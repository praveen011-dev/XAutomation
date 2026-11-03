import { createReadStream } from 'node:fs';
import { createHmac, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { stat } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';

import { UserError } from './util.js';

const MAX_BODY_BYTES = 256 * 1024;

const POST_ROUTES = new Set([
  '/api/scoop',
  '/api/draft',
  '/api/post',
  '/api/save',
  '/api/auth/login',
  '/api/auth/logout',
]);
const SESSION_COOKIE = 'xpost_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 8;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
};

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'x-frame-options': 'DENY',
  });
  response.end(body);
}

async function readJsonBody(request) {
  const type = String(request.headers['content-type'] ?? '');
  if (!type.includes('application/json')) {
    throw new UserError('Expected a JSON request body (content-type: application/json).', {
      exitCode: 415,
    });
  }

  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      throw new UserError('Request body is too large.', { exitCode: 413 });
    }
    chunks.push(chunk);
  }

  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('not an object');
    }
    return parsed;
  } catch {
    throw new UserError('Malformed JSON request body.', { exitCode: 400 });
  }
}

/**
 * A localhost server is reachable from any web page the browser has open, so
 * cross-site POSTs are rejected: the Origin must match the Host we were asked
 * on, and JSON bodies are required (a form post cannot set that type).
 */
function assertSameOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return;
  let originHost;
  try {
    originHost = new URL(origin).host;
  } catch {
    throw new UserError('Invalid Origin header.', { exitCode: 403 });
  }
  if (originHost !== request.headers.host) {
    throw new UserError('Cross-origin request refused.', { exitCode: 403 });
  }
}

function asText(value, { max = 5_000, field = 'value' } = {}) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new UserError(`${field} must be a string.`);
  const trimmed = value.trim();
  if (trimmed.length > max) throw new UserError(`${field} is too long (max ${max} characters).`);
  return trimmed;
}

function asCount(value, { fallback, min = 1, max = 50 } = {}) {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function readCookie(request, name) {
  const cookie = String(request.headers.cookie ?? '')
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`));
  return cookie ? decodeURIComponent(cookie.slice(name.length + 1)) : '';
}

function sessionSignature(payload, secret) {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

function hasValidSession(request, auth, now = Date.now()) {
  if (!auth.required) return true;
  const token = readCookie(request, SESSION_COOKIE);
  const split = token.lastIndexOf('.');
  if (split <= 0) return false;

  const payload = token.slice(0, split);
  const supplied = Buffer.from(token.slice(split + 1));
  const expected = Buffer.from(sessionSignature(payload, auth.secret));
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return false;

  const issuedAt = Number(payload.split('.', 1)[0]);
  return Number.isFinite(issuedAt) && issuedAt <= now + 60_000 && now - issuedAt < SESSION_TTL_MS;
}

function makeSession(auth, now = Date.now()) {
  const payload = `${now}.${randomBytes(18).toString('base64url')}`;
  return `${payload}.${sessionSignature(payload, auth.secret)}`;
}

function isSecureRequest(request) {
  const forwarded = String(request.headers['x-forwarded-proto'] ?? '').split(',')[0].trim();
  return forwarded === 'https' || request.socket.encrypted === true;
}

function setSessionCookie(response, request, token) {
  const secure = isSecureRequest(request) ? '; Secure' : '';
  response.setHeader(
    'set-cookie',
    `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Strict; Max-Age=${SESSION_TTL_MS / 1000}${secure}`,
  );
}

function clearSessionCookie(response, request) {
  const secure = isSecureRequest(request) ? '; Secure' : '';
  response.setHeader(
    'set-cookie',
    `${SESSION_COOKIE}=; HttpOnly; Path=/; SameSite=Strict; Max-Age=0${secure}`,
  );
}

function isPasswordCorrect(input, expected) {
  const actualHash = createHash('sha256').update(String(input ?? '')).digest();
  const expectedHash = createHash('sha256').update(expected).digest();
  return timingSafeEqual(actualHash, expectedHash);
}

function isLoopbackHost(host) {
  return ['127.0.0.1', '::1', 'localhost'].includes(String(host).toLowerCase());
}

async function serveStatic({ response, publicDir, pathname }) {
  const relative = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
  const target = path.resolve(publicDir, `.${relative}`);

  if (target !== publicDir && !target.startsWith(`${publicDir}${path.sep}`)) {
    sendJson(response, 403, { error: 'Forbidden.' });
    return;
  }

  let info;
  try {
    info = await stat(target);
  } catch {
    sendJson(response, 404, { error: `Not found: ${pathname}` });
    return;
  }
  if (!info.isFile()) {
    sendJson(response, 404, { error: `Not found: ${pathname}` });
    return;
  }

  response.writeHead(200, {
    'content-type': MIME_TYPES[path.extname(target).toLowerCase()] ?? 'application/octet-stream',
    'content-length': info.size,
    'cache-control': target.endsWith('.html') ? 'no-store' : 'public, max-age=60',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
  });
  createReadStream(target).pipe(response);
}

/**
 * deps (all async, all injected so tests never touch the network):
 *   status()                                  → object for the header
 *   scoop({ topic, limit, source })           → { posts, host, source, query, saved }
 *   draft({ topic, posts, previousText })     → { text, model, length, remaining }
 *   publish({ text, mode })                   → { status, url, mode, message }
 *   save({ text, status })                    → { file }
 *   history({ limit })                        → [draft records]
 */
export function createHandler({
  deps,
  publicDir,
  version = '1.0.0',
  maxChars = 280,
  logger,
  auth = { required: false },
}) {
  const loginAttempts = new Map();

  async function routeApi(request, response, pathname) {
    if (request.method === 'GET' && pathname === '/api/health') {
      return sendJson(response, 200, { ok: true });
    }

    if (request.method === 'GET' && pathname === '/api/auth/session') {
      return sendJson(response, 200, {
        authenticated: hasValidSession(request, auth),
        required: Boolean(auth.required),
      });
    }

    if (pathname === '/api/auth/login') {
      if (request.method !== 'POST') {
        return sendJson(response, 405, { error: `${request.method} is not allowed on ${pathname}.` });
      }
      assertSameOrigin(request);
      const body = await readJsonBody(request);
      if (!auth.required) return sendJson(response, 200, { authenticated: true });

      const ip = request.socket.remoteAddress ?? 'unknown';
      const now = Date.now();
      let attempts = loginAttempts.get(ip);
      if (!attempts || now - attempts.startedAt >= LOGIN_WINDOW_MS) {
        attempts = { startedAt: now, count: 0 };
        loginAttempts.set(ip, attempts);
      }
      if (attempts.count >= LOGIN_MAX_ATTEMPTS) {
        return sendJson(response, 429, { error: 'Too many sign-in attempts. Wait 15 minutes and try again.' });
      }

      if (!isPasswordCorrect(body.password, auth.password)) {
        attempts.count += 1;
        return sendJson(response, 401, { error: 'That password did not match.' });
      }

      loginAttempts.delete(ip);
      setSessionCookie(response, request, makeSession(auth));
      return sendJson(response, 200, { authenticated: true });
    }

    if (pathname === '/api/auth/logout') {
      if (request.method !== 'POST') {
        return sendJson(response, 405, { error: `${request.method} is not allowed on ${pathname}.` });
      }
      assertSameOrigin(request);
      await readJsonBody(request);
      clearSessionCookie(response, request);
      return sendJson(response, 200, { authenticated: false });
    }

    if (!hasValidSession(request, auth)) {
      return sendJson(response, 401, { error: 'Sign in to continue.', code: 'AUTH_REQUIRED' });
    }

    if (request.method === 'GET' && pathname === '/api/status') {
      const status = await deps.status();
      return sendJson(response, 200, { version, maxChars, ...status });
    }

    if (request.method === 'GET' && pathname === '/api/history') {
      const limit = asCount(new URL(request.url, 'http://x').searchParams.get('limit'), {
        fallback: 20,
        max: 100,
      });
      return sendJson(response, 200, { drafts: await deps.history({ limit }) });
    }

    if (!POST_ROUTES.has(pathname)) {
      return sendJson(response, 404, { error: `Unknown endpoint: ${pathname}` });
    }

    if (request.method !== 'POST') {
      return sendJson(response, 405, { error: `${request.method} is not allowed on ${pathname}.` });
    }

    assertSameOrigin(request);
    const body = await readJsonBody(request);

    if (pathname === '/api/scoop') {
      const topic = asText(body.topic, { max: 200, field: 'topic' });
      const source = ['nitter', 'api'].includes(body.source) ? body.source : undefined;
      const limit = asCount(body.limit, { fallback: 12, max: 50 });
      return sendJson(response, 200, await deps.scoop({ topic, limit, source }));
    }

    if (pathname === '/api/draft') {
      const topic = asText(body.topic, { max: 200, field: 'topic' });
      const previousText = asText(body.previousText, { max: 2_000, field: 'previousText' });
      const posts = Array.isArray(body.posts) ? body.posts.slice(0, 20) : [];
      return sendJson(response, 200, await deps.draft({ topic, posts, previousText }));
    }

    if (pathname === '/api/post') {
      const text = asText(body.text, { max: 10_000, field: 'text' });
      if (!text) throw new UserError('There is no text to post.', { exitCode: 400 });
      const mode = ['auto', 'composer'].includes(body.mode) ? body.mode : 'auto';
      return sendJson(response, 200, await deps.publish({ text, mode }));
    }

    if (pathname === '/api/save') {
      const text = asText(body.text, { max: 10_000, field: 'text' });
      if (!text) throw new UserError('There is no text to save.', { exitCode: 400 });
      return sendJson(response, 200, await deps.save({ text }));
    }

    return sendJson(response, 404, { error: `Unknown endpoint: ${pathname}` });
  }

  return async function handler(request, response) {
    const { pathname } = new URL(request.url ?? '/', 'http://localhost');

    try {
      if (pathname.startsWith('/api/')) {
        return await routeApi(request, response, pathname);
      }
      return await serveStatic({ response, publicDir, pathname });
    } catch (error) {
      // UserError carries a CLI exit code by default, so only trust it when it
      // is actually a valid HTTP status.
      const code = error instanceof UserError ? error.exitCode : 500;
      const status = code >= 400 && code <= 599 ? code : 400;
      if (status >= 500) {
        logger?.error(`${request.method} ${pathname} failed: ${error.message}`);
      } else {
        logger?.detail(`${request.method} ${pathname} → ${status}: ${error.message}`);
      }
      sendJson(response, status, {
        error: error.message,
        ...(error.hint ? { hint: error.hint } : {}),
      });
    }
  };
}

/**
 * Start the local UI. Falls through to the next port when the preferred one is
 * already in use, so a second `xpost ui` never fails with EADDRINUSE.
 */
export async function startUiServer({
  deps,
  publicDir,
  port = 4321,
  host = '127.0.0.1',
  version = '1.0.0',
  maxChars = 280,
  attempts = 10,
  logger,
  auth = { required: false },
}) {
  if (!isLoopbackHost(host)) {
    if (!auth?.password || !auth?.secret || String(auth.secret).length < 32) {
      throw new UserError(
        'Network-accessible UI requires XPOST_UI_PASSWORD and a random XPOST_UI_SECRET of at least 32 characters.',
      );
    }
    auth = { ...auth, required: true };
  }
  if (auth?.required && (String(auth.password ?? '').length < 12 || String(auth.secret ?? '').length < 32)) {
    throw new UserError('Dashboard sign-in requires an XPOST_UI_PASSWORD of at least 12 characters and an XPOST_UI_SECRET of at least 32 characters.');
  }
  const handler = createHandler({ deps, publicDir, version, maxChars, logger, auth });
  let lastError = null;

  for (let offset = 0; offset < attempts; offset += 1) {
    const candidate = port + offset;
    const server = http.createServer((request, response) => {
      // Errors are already reported to the client; this only stops a stray
      // rejection from taking the whole server down.
      handler(request, response).catch((error) => {
        logger?.error(`Unhandled request error: ${error.message}`);
        if (!response.headersSent) sendJson(response, 500, { error: 'Internal server error.' });
      });
    });

    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(candidate, host, () => {
          server.off('error', reject);
          resolve();
        });
      });

      const address = server.address();
      const actualPort =
        address && typeof address === 'object' ? address.port : candidate;
      const url = `http://${host}:${actualPort}`;
      return {
        server,
        port: actualPort,
        url,
        close: () =>
          new Promise((resolve) => {
            server.closeAllConnections?.();
            server.close(() => resolve());
          }),
      };
    } catch (error) {
      lastError = error;
      if (error.code !== 'EADDRINUSE') break;
    }
  }

  throw new UserError(`Could not start the xpost UI: ${lastError?.message ?? 'unknown error'}`, {
    hint: 'Pick another port with `xpost ui --port 4400`.',
  });
}
