import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { startUiServer } from '../src/server.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = path.join(ROOT, 'public');

function makeDeps(overrides = {}) {
  const calls = [];
  const deps = {
    calls,
    status: async () => ({
      account: { username: 'dev', name: 'Dev' },
      accountError: null,
      posting: { manual: false },
      gemini: { model: 'gemini-test', ready: true },
      x: { ready: true },
      scoop: { source: 'nitter', instances: 5 },
    }),
    scoop: async (input) => {
      calls.push(['scoop', input]);
      return {
        query: input.topic,
        source: input.source ?? 'nitter',
        host: 'https://nitter.test',
        saved: 'drafts/scoops/scoop-1.json',
        posts: [
          { author: '@ratecoach', text: 'Charge 3x.', url: 'https://x.com/ratecoach/status/3001' },
        ],
      };
    },
    draft: async (input) => {
      calls.push(['draft', input]);
      return {
        text: `Draft about ${input.topic} with ${input.posts.length} posts`,
        model: 'gemini-test',
        length: 42,
        remaining: 238,
      };
    },
    publish: async (input) => {
      calls.push(['publish', input]);
      return {
        status: 'posted',
        mode: input.mode,
        url: 'https://x.com/me/status/555',
        file: 'drafts/2026.json',
        message: 'Posted',
      };
    },
    save: async (input) => {
      calls.push(['save', input]);
      return { file: 'drafts/saved.json' };
    },
    history: async ({ limit }) => {
      calls.push(['history', { limit }]);
      return [{ id: '1', status: 'posted', text: 'hello', createdAt: '2026-10-21T00:00:00.000Z' }];
    },
    ...overrides,
  };
  return deps;
}

async function withServer(t, deps = makeDeps()) {
  const ui = await startUiServer({ deps, publicDir: PUBLIC_DIR, port: 0, version: '9.9.9', maxChars: 280 });
  t.after(() => ui.close());
  return { ...ui, deps };
}

function request(url, { method = 'GET', body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : typeof body === 'string' ? body : JSON.stringify(body);
    const target = new URL(url);
    const request_ = http.request(
      {
        method,
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        headers: {
          ...(payload
            ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }
            : {}),
          ...headers,
        },
      },
      (response) => {
        let raw = '';
        response.on('data', (chunk) => {
          raw += chunk;
        });
        response.on('end', () => {
          let json = null;
          try {
            json = raw ? JSON.parse(raw) : null;
          } catch {
            json = null;
          }
          resolve({ status: response.statusCode, headers: response.headers, text: raw, json });
        });
      },
    );
    request_.on('error', reject);
    if (payload) request_.write(payload);
    request_.end();
  });
}

test('serves the UI shell and static assets', async (t) => {
  const ui = await withServer(t);

  const page = await request(`${ui.url}/`);
  assert.equal(page.status, 200);
  assert.match(page.headers['content-type'], /text\/html/);
  assert.match(page.text, /xpost/);
  assert.match(page.text, /Draft with AI/);

  const css = await request(`${ui.url}/styles.css`);
  assert.equal(css.status, 200);
  assert.match(css.headers['content-type'], /text\/css/);

  const script = await request(`${ui.url}/app.js`);
  assert.equal(script.status, 200);
  assert.match(script.headers['content-type'], /javascript/);

  const missing = await request(`${ui.url}/nope.js`);
  assert.equal(missing.status, 404);
});

test('refuses path traversal outside the public folder', async (t) => {
  const ui = await withServer(t);
  const escaped = await request(`${ui.url}/..%2f..%2fpackage.json`);
  assert.ok([403, 404].includes(escaped.status), `got ${escaped.status}`);
  assert.doesNotMatch(escaped.text, /"name": "xpost"/);
});

test('GET /api/status merges server defaults', async (t) => {
  const ui = await withServer(t);
  const response = await request(`${ui.url}/api/status`);

  assert.equal(response.status, 200);
  assert.equal(response.json.version, '9.9.9');
  assert.equal(response.json.maxChars, 280);
  assert.equal(response.json.account.username, 'dev');
  assert.equal(response.json.posting.manual, false);
});

test('POST /api/scoop forwards topic, limit, and source', async (t) => {
  const ui = await withServer(t);
  const response = await request(`${ui.url}/api/scoop`, {
    method: 'POST',
    body: { topic: 'web development', limit: 20, source: 'nitter' },
  });

  assert.equal(response.status, 200);
  assert.equal(response.json.posts[0].url, 'https://x.com/ratecoach/status/3001');
  assert.deepEqual(ui.deps.calls[0], ['scoop', { topic: 'web development', limit: 20, source: 'nitter' }]);
});

test('POST /api/scoop accepts an empty topic and rejects an oversized one', async (t) => {
  const ui = await withServer(t);

  const empty = await request(`${ui.url}/api/scoop`, { method: 'POST', body: { topic: '' } });
  assert.equal(empty.status, 200); // empty falls back to the default query server-side
  assert.equal(ui.deps.calls.at(-1)[1].topic, '');

  const huge = await request(`${ui.url}/api/scoop`, {
    method: 'POST',
    body: { topic: 'x'.repeat(201) },
  });
  assert.equal(huge.status, 400);
  assert.match(huge.json.error, /too long/i);
});

test('POST /api/draft passes the selected posts as context', async (t) => {
  const ui = await withServer(t);
  const posts = [{ author: '@a', text: 'one', url: 'https://x.com/a/status/1' }];
  const response = await request(`${ui.url}/api/draft`, {
    method: 'POST',
    body: { topic: 'freelancing', posts, previousText: '' },
  });

  assert.equal(response.status, 200);
  assert.match(response.json.text, /Draft about freelancing with 1 posts/);
  assert.deepEqual(ui.deps.calls.at(-1)[1].posts, posts);
});

test('POST /api/post validates text and forwards the mode', async (t) => {
  const ui = await withServer(t);

  const empty = await request(`${ui.url}/api/post`, { method: 'POST', body: { text: '   ' } });
  assert.equal(empty.status, 400);

  const ok = await request(`${ui.url}/api/post`, {
    method: 'POST',
    body: { text: 'Ship it.', mode: 'composer' },
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.mode, 'composer');
  assert.equal(ok.json.url, 'https://x.com/me/status/555');
  assert.deepEqual(ui.deps.calls.at(-1), ['publish', { text: 'Ship it.', mode: 'composer' }]);
});

test('unknown publish modes fall back to auto', async (t) => {
  const ui = await withServer(t);
  const response = await request(`${ui.url}/api/post`, {
    method: 'POST',
    body: { text: 'hello', mode: 'telepathy' },
  });
  assert.equal(response.json.mode, 'auto');
});

test('POST /api/save and GET /api/history work', async (t) => {
  const ui = await withServer(t);

  const saved = await request(`${ui.url}/api/save`, { method: 'POST', body: { text: 'keep this' } });
  assert.equal(saved.status, 200);
  assert.equal(saved.json.file, 'drafts/saved.json');

  const history = await request(`${ui.url}/api/history?limit=5`);
  assert.equal(history.status, 200);
  assert.equal(history.json.drafts.length, 1);
  assert.equal(ui.deps.calls.at(-1)[1].limit, 5);
});

test('public binding requires a strong dashboard password and signing secret', async () => {
  await assert.rejects(
    startUiServer({ deps: makeDeps(), publicDir: PUBLIC_DIR, port: 0, host: '0.0.0.0' }),
    /XPOST_UI_PASSWORD/,
  );
});

test('public APIs require password sign-in and use a secure signed cookie', async (t) => {
  const ui = await startUiServer({
    deps: makeDeps(), publicDir: PUBLIC_DIR, port: 0, host: '0.0.0.0',
    auth: { password: 'a-long-private-password', secret: 's'.repeat(48) },
  });
  t.after(() => ui.close());

  const health = await request(`${ui.url}/api/health`);
  assert.equal(health.status, 200);
  assert.equal((await request(`${ui.url}/api/status`)).status, 401);

  const rejected = await request(`${ui.url}/api/auth/login`, { method: 'POST', body: { password: 'wrong' } });
  assert.equal(rejected.status, 401);

  const login = await request(`${ui.url}/api/auth/login`, {
    method: 'POST', body: { password: 'a-long-private-password' },
    headers: { 'x-forwarded-proto': 'https', origin: ui.url },
  });
  assert.equal(login.status, 200);
  const cookieHeader = login.headers['set-cookie'].join(';');
  assert.match(cookieHeader, /HttpOnly/);
  assert.match(cookieHeader, /SameSite=Strict/);
  assert.match(cookieHeader, /Secure/);

  const cookie = login.headers['set-cookie'][0].split(';')[0];
  const status = await request(`${ui.url}/api/status`, { headers: { cookie } });
  assert.equal(status.status, 200);

  const logout = await request(`${ui.url}/api/auth/logout`, { method: 'POST', body: {}, headers: { cookie } });
  assert.equal(logout.status, 200);
  assert.match(logout.headers['set-cookie'].join(';'), /Max-Age=0/);
  const afterLogout = await request(`${ui.url}/api/status`);
  assert.equal(afterLogout.status, 401);
});

test('rejects cross-origin posts, form posts, and malformed JSON', async (t) => {
  const ui = await withServer(t);

  const crossOrigin = await request(`${ui.url}/api/post`, {
    method: 'POST',
    body: { text: 'nope' },
    headers: { origin: 'https://evil.example' },
  });
  assert.equal(crossOrigin.status, 403);
  assert.equal(ui.deps.calls.filter(([name]) => name === 'publish').length, 0);

  const sameOrigin = await request(`${ui.url}/api/post`, {
    method: 'POST',
    body: { text: 'ok' },
    headers: { origin: ui.url },
  });
  assert.equal(sameOrigin.status, 200);

  const formPost = await request(`${ui.url}/api/post`, {
    method: 'POST',
    body: 'text=hello',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  });
  assert.equal(formPost.status, 415);

  const malformed = await request(`${ui.url}/api/post`, {
    method: 'POST',
    body: '{not json',
  });
  assert.equal(malformed.status, 400);
  assert.match(malformed.json.error, /Malformed JSON/);
});

test('unknown API routes and methods are rejected', async (t) => {
  const ui = await withServer(t);

  const missing = await request(`${ui.url}/api/does-not-exist`);
  assert.equal(missing.status, 404);

  const wrongMethod = await request(`${ui.url}/api/post`);
  assert.equal(wrongMethod.status, 405);
});

test('server errors become JSON instead of crashing the app', async (t) => {
  const ui = await withServer(
    t,
    makeDeps({
      scoop: async () => {
        throw new Error('nitter exploded');
      },
    }),
  );

  const response = await request(`${ui.url}/api/scoop`, { method: 'POST', body: { topic: 'x' } });
  assert.equal(response.status, 500);
  assert.match(response.json.error, /nitter exploded/);

  // Still serving after the failure.
  const status = await request(`${ui.url}/api/status`);
  assert.equal(status.status, 200);
});

test('falls through to the next port when the preferred one is busy', async (t) => {
  const deps = makeDeps();
  const first = await startUiServer({ deps, publicDir: PUBLIC_DIR, port: 0 });
  t.after(() => first.close());

  const second = await startUiServer({ deps, publicDir: PUBLIC_DIR, port: first.port });
  t.after(() => second.close());

  assert.notEqual(second.port, first.port);
  assert.equal(second.port, first.port + 1);
});
