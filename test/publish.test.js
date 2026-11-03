import assert from 'node:assert/strict';
import test from 'node:test';

import { publishText } from '../src/publish.js';
import { UserError } from '../src/util.js';

function makeConfig(overrides = {}) {
  return {
    x: { apiKey: 'app', apiSecret: 'secret', accessToken: 'token', accessSecret: 'secret' },
    xpost: { manual: false, browser: 'none', clipboard: 'none' },
    ...overrides,
  };
}

function creditError() {
  const error = new Error('credits depleted');
  error.code = 402;
  error.data = { detail: 'Credits depleted' };
  return error;
}

test('API mode posts directly when credentials and credits are available', async () => {
  let called = 0;
  const result = await publishText({
    text: 'ship it', config: makeConfig(), createClient: () => ({}),
    post: async () => { called += 1; return { id: '99', url: 'https://x.com/i/status/99' }; },
  });
  assert.equal(called, 1);
  assert.equal(result.status, 'posted');
  assert.equal(result.mode, 'api');
  assert.equal(result.tweetId, '99');
});

test('composer mode prepares the link without calling the X API', async () => {
  let apiCalled = false;
  let saved = false;
  const result = await publishText({
    text: 'review me', mode: 'composer', config: makeConfig(),
    post: async () => { apiCalled = true; }, createClient: () => ({}),
    compose: async ({ text, save }) => {
      assert.equal(text, 'review me');
      const record = await save({ status: 'manual', text });
      saved = true;
      return { url: 'https://x.com/intent/tweet?text=review', file: record.file };
    },
    save: async () => ({ file: 'draft.json' }),
  });
  assert.equal(apiCalled, false);
  assert.equal(saved, true);
  assert.equal(result.status, 'composer');
  assert.equal(result.needsClick, true);
  assert.equal(result.file, 'draft.json');
});

test('credit exhaustion falls back to the manual composer', async () => {
  let composed = 0;
  const result = await publishText({
    text: 'keep the draft', config: makeConfig(), createClient: () => ({}),
    post: async () => { throw creditError(); },
    compose: async () => { composed += 1; return { url: 'https://x.com/intent/tweet' }; },
    logger: { warn() {}, detail() {} },
  });
  assert.equal(composed, 1);
  assert.equal(result.status, 'composer');
  assert.equal(result.reason, 'out of API credits');
});

test('missing X credentials choose the composer without an API call', async () => {
  let apiCalled = false;
  const config = makeConfig({ x: { apiKey: '', apiSecret: '', accessToken: '', accessSecret: '' } });
  const result = await publishText({
    text: 'manual post', config, post: async () => { apiCalled = true; },
    compose: async () => ({ url: 'https://x.com/intent/tweet' }),
  });
  assert.equal(apiCalled, false);
  assert.equal(result.status, 'composer');
  assert.equal(result.reason, 'no X credentials');
});

test('authentication errors are surfaced without silent fallback', async () => {
  const error = Object.assign(new Error('Unauthorized'), { code: 401, data: { detail: 'Unauthorized' } });
  await assert.rejects(
    publishText({ text: 'hello', config: makeConfig(), createClient: () => ({}), post: async () => { throw error; } }),
    (caught) => caught instanceof UserError && /401/.test(caught.message),
  );
});

test('rejects empty text and unsupported publish modes', async () => {
  await assert.rejects(publishText({ text: ' ', config: makeConfig() }), UserError);
  await assert.rejects(publishText({ text: 'hello', mode: 'browser', config: makeConfig() }), /Unknown publish mode/);
});
