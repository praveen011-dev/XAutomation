import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { UserError } from './util.js';

export const DEFAULT_GEMINI_BASE_URL =
  'https://generativelanguage.googleapis.com/v1beta';
export const DEFAULT_TEXT_MODEL = 'gemini-3.8-flash';
export const DEFAULT_IMAGE_MODEL = 'gemini-nano-banana-2.1';
export const DEFAULT_MAX_CHARS = 280;
export const X_MEDIA_LIMIT_BYTES = 5 * 1024 * 1024;

export class ConfigError extends UserError {
  constructor(message, hint) {
    super(message, { hint });
    this.name = 'ConfigError';
  }
}

/**
 * Parse the small subset of dotenv syntax this project needs:
 * comments, blank lines, `export KEY=`, single/double quotes and blank values.
 */
export function parseEnv(content) {
  const values = {};
  const source = String(content).replace(/^\uFEFF/, '');

  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;

    const [, key, rawValue] = match;
    let value = rawValue.trim();

    if (value.startsWith('"') || value.startsWith("'")) {
      const quote = value[0];
      if (value.length >= 2 && value.endsWith(quote)) {
        value = value.slice(1, -1);
      } else {
        value = value.slice(1);
      }
      if (quote === '"') {
        value = value
          .replace(/\\n/g, '\n')
          .replace(/\\r/g, '\r')
          .replace(/\\t/g, '\t')
          .replace(/\\"/g, '"')
          .replace(/\\\\/g, '\\');
      }
    } else {
      // A `#` only starts a comment when preceded by whitespace, so URLs survive.
      value = value.replace(/\s+#.*$/, '').trim();
    }

    values[key] = value;
  }

  return values;
}

/**
 * Load .env files without overriding variables already present in the
 * environment (shell exports always win). Returns the files that were read.
 */
export function loadEnvFiles({ cwd = process.cwd(), projectRoot = cwd } = {}) {
  const candidates = [path.join(cwd, '.env'), path.join(projectRoot, '.env')];
  const seen = new Set();
  const loaded = [];

  for (const candidate of candidates) {
    const file = path.resolve(candidate);
    if (seen.has(file)) continue;
    seen.add(file);
    if (!existsSync(file)) continue;

    const values = parseEnv(readFileSync(file, 'utf8'));
    for (const [key, value] of Object.entries(values)) {
      if (!(key in process.env)) process.env[key] = value;
    }
    loaded.push(file);
  }

  return loaded;
}

function parseList(value) {
  if (!value) return [];
  return String(value)
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function isTruthy(value) {
  return /^(1|true|yes|on)$/i.test(String(value ?? '').trim());
}

function parseMode(value) {
  return String(value ?? '').trim().toLowerCase() === 'none' ? 'none' : 'auto';
}

function parseScoopSource(value) {
  return String(value ?? '').trim().toLowerCase() === 'api' ? 'api' : 'nitter';
}

function parsePositiveInt(value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

export function readConfig(env = process.env, { projectRoot = process.cwd(), cwd = process.cwd() } = {}) {
  return {
    projectRoot,
    cwd,
    gemini: {
      apiKey: env.GEMINI_API_KEY?.trim() ?? '',
      model: env.GEMINI_MODEL?.trim() || DEFAULT_TEXT_MODEL,
      imageModel: env.GEMINI_IMAGE_MODEL?.trim() || DEFAULT_IMAGE_MODEL,
      baseUrl: (env.GEMINI_BASE_URL?.trim() || DEFAULT_GEMINI_BASE_URL).replace(/\/+$/, ''),
      timeoutMs: parsePositiveInt(env.GEMINI_TIMEOUT_MS, 60_000, { min: 5_000, max: 300_000 }),
    },
    x: {
      apiKey: env.X_API_KEY?.trim() ?? '',
      apiSecret: env.X_API_KEY_SECRET?.trim() ?? '',
      accessToken: env.X_ACCESS_TOKEN?.trim() ?? '',
      accessSecret: env.X_ACCESS_TOKEN_SECRET?.trim() ?? '',
    },
    scoop: {
      source: parseScoopSource(env.XPOST_SCOOP_SOURCE),
      instances: parseList(env.NITTER_INSTANCES),
    },
    xpost: {
      manual: isTruthy(env.XPOST_MANUAL),
      browser: parseMode(env.XPOST_BROWSER),
      clipboard: parseMode(env.XPOST_CLIPBOARD),
      uiHost: env.XPOST_UI_HOST?.trim() || '127.0.0.1',
      uiPassword: env.XPOST_UI_PASSWORD?.trim() || '',
      uiSecret: env.XPOST_UI_SECRET?.trim() || '',
      uiPort: parsePositiveInt(env.PORT || env.XPOST_UI_PORT, 4321, { min: 1024, max: 65_535 }),
    },
    repos: parseList(env.TWEET_REPOS),
    gitEmail: env.TWEET_GIT_EMAIL?.trim() || '',
    since: env.TWEET_SINCE?.trim() || 'midnight',
    maxChars: parsePositiveInt(env.TWEET_MAX_CHARS, DEFAULT_MAX_CHARS, { min: 1, max: 25_000 }),
    draftsDir: env.XPOST_DRAFTS_DIR
      ? path.resolve(cwd, env.XPOST_DRAFTS_DIR)
      : path.join(projectRoot, 'drafts'),
  };
}

export function missingGeminiConfig(config) {
  return config.gemini.apiKey ? [] : ['GEMINI_API_KEY'];
}

export function missingXConfig(config) {
  return [
    ['X_API_KEY', config.x.apiKey],
    ['X_API_KEY_SECRET', config.x.apiSecret],
    ['X_ACCESS_TOKEN', config.x.accessToken],
    ['X_ACCESS_TOKEN_SECRET', config.x.accessSecret],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);
}

export function requireGemini(config) {
  const missing = missingGeminiConfig(config);
  if (missing.length) {
    throw new ConfigError(
      `Missing Gemini credentials: ${missing.join(', ')}`,
      'Copy .env.example to .env and add your key from https://aistudio.google.com/apikey — see SETUP.md.',
    );
  }
  return config.gemini;
}

export function requireX(config) {
  const missing = missingXConfig(config);
  if (missing.length) {
    throw new ConfigError(
      `Missing X credentials: ${missing.join(', ')}`,
      'Fill in all four X_* values in .env and make sure the app has Read and write permissions — see SETUP.md.',
    );
  }
  return config.x;
}
