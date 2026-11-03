import assert from 'node:assert/strict';
import os from 'node:os';
import test from 'node:test';
import path from 'node:path';

import {
  DEFAULT_IMAGE_MODEL,
  DEFAULT_TEXT_MODEL,
  missingXConfig,
  parseEnv,
  readConfig,
} from '../src/config.js';

test('parses dotenv syntax used by the project', () => {
  const values = parseEnv(
    [
      '\uFEFF# comment',
      '',
      'PLAIN=value',
      'export EXPORTED=yes',
      'SPACED = padded ',
      'QUOTED="hello # not a comment"',
      "SINGLE='single value'",
      'MULTILINE="line1\\nline2"',
      'WITH_COMMENT=value # trailing comment',
      'URL=https://example.com/#fragment',
      'EMPTY=',
      'not a valid line',
    ].join('\r\n'),
  );

  assert.deepEqual(values, {
    PLAIN: 'value',
    EXPORTED: 'yes',
    SPACED: 'padded',
    QUOTED: 'hello # not a comment',
    SINGLE: 'single value',
    MULTILINE: 'line1\nline2',
    WITH_COMMENT: 'value',
    URL: 'https://example.com/#fragment',
    EMPTY: '',
  });
});

test('applies defaults and reads overrides', () => {
  const config = readConfig(
    {
      GEMINI_API_KEY: 'gem-key',
      X_API_KEY: 'x-key',
      TWEET_REPOS: 'one, two',
      TWEET_MAX_CHARS: '9999',
    },
    { projectRoot: '/project', cwd: '/work' },
  );

  assert.equal(config.gemini.model, DEFAULT_TEXT_MODEL);
  assert.equal(config.gemini.imageModel, DEFAULT_IMAGE_MODEL);
  assert.equal(config.gemini.baseUrl, 'https://generativelanguage.googleapis.com/v1beta');
  assert.equal(config.gemini.apiKey, 'gem-key');
  assert.equal(config.repos.length, 2);
  assert.equal(config.maxChars, 9999);
  assert.equal(config.draftsDir, path.join('/project', 'drafts'));

  const overridden = readConfig(
    {
      GEMINI_MODEL: 'custom-text',
      GEMINI_IMAGE_MODEL: 'custom-image',
      GEMINI_BASE_URL: 'http://localhost:1234/v1beta/',
      XPOST_DRAFTS_DIR: 'out',
      TWEET_MAX_CHARS: 'not-a-number',
    },
    { projectRoot: '/project', cwd: '/work' },
  );

  assert.equal(overridden.gemini.model, 'custom-text');
  assert.equal(overridden.gemini.imageModel, 'custom-image');
  assert.equal(overridden.gemini.baseUrl, 'http://localhost:1234/v1beta');
  assert.equal(overridden.maxChars, 280);
  assert.equal(overridden.draftsDir, path.resolve('/work', 'out'));
});

test('reads publishing and public UI settings', () => {
  const defaults = readConfig({}, { projectRoot: '/project', cwd: '/work' });
  assert.equal(defaults.xpost.uiPort, 4321);
  assert.equal(defaults.xpost.uiHost, '127.0.0.1');

  const custom = readConfig(
    {
      XPOST_UI_HOST: '0.0.0.0',
      XPOST_UI_PASSWORD: 'long-private-password',
      XPOST_UI_SECRET: 'a'.repeat(40),
      XPOST_UI_PORT: '5000',
    },
    { projectRoot: '/project', cwd: '/work' },
  );
  assert.equal(custom.xpost.uiHost, '0.0.0.0');
  assert.equal(custom.xpost.uiPassword, 'long-private-password');
  assert.equal(custom.xpost.uiSecret.length, 40);
  assert.equal(custom.xpost.uiPort, 5000);
});

test('reports exactly which X credentials are missing', () => {
  assert.deepEqual(
    missingXConfig({ x: { apiKey: 'a', apiSecret: '', accessToken: 'c', accessSecret: '' } }),
    ['X_API_KEY_SECRET', 'X_ACCESS_TOKEN_SECRET'],
  );
});
