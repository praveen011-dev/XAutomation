import assert from 'node:assert/strict';
import test from 'node:test';

import { buildIntentUrl, composeManually, isCreditError } from '../src/compose.js';
import { UserError } from '../src/util.js';

function createLogger() {
  const lines = { out: [], err: [] };
  return {
    lines,
    logger: {
      info: (message = '') => lines.out.push(message),
      step: (message) => lines.out.push(message),
      success: (message) => lines.out.push(message),
      warn: (message) => lines.err.push(message),
      error: (message) => lines.err.push(message),
      detail: (message) => lines.out.push(message),
      blank: () => lines.out.push(''),
    },
  };
}

test('buildIntentUrl percent-encodes the draft into the X composer link', () => {
  const text = 'Ship it & ship it #1?\nnew line';
  const url = buildIntentUrl(text);

  assert.ok(url.startsWith('https://x.com/intent/tweet?text='));
  const encoded = url.slice(url.indexOf('?text=') + 6);
  assert.equal(decodeURIComponent(encoded), text);
  // The query value must be fully encoded: no bare ampersands, spaces or newlines.
  assert.doesNotMatch(encoded, /[&\s]/);

  assert.equal(buildIntentUrl('plain text'), 'https://x.com/intent/tweet?text=plain%20text');
  assert.throws(() => buildIntentUrl(''), UserError);
  assert.throws(() => buildIntentUrl('   '), UserError);
});

test('isCreditError spots billing failures but not auth or rate limits', () => {
  assert.equal(isCreditError({ code: 402 }), true);
  assert.equal(isCreditError({ status: 402, message: 'Payment Required' }), true);
  assert.equal(
    isCreditError({ code: 403, data: { detail: 'This account has insufficient credits' } }),
    true,
  );

  assert.equal(isCreditError({ code: 401, message: 'Unauthorized' }), false);
  assert.equal(isCreditError({ code: 429, message: 'Too Many Requests' }), false);
  assert.equal(isCreditError({ code: 403, message: 'Forbidden' }), false);
  assert.equal(isCreditError(null), false);
});

test('composeManually opens the composer, copies the text and saves a manual record', async () => {
  const { lines, logger } = createLogger();
  const calls = { open: [], copy: [], saved: [] };

  const result = await composeManually({
    text: 'Hello from xpost',
    imagePath: 'drafts/media/x.png',
    logger,
    save: async (record) => {
      calls.saved.push(record);
      return { file: 'drafts/manual.json' };
    },
    settings: { browser: 'auto', clipboard: 'auto' },
    open: (url) => {
      calls.open.push(url);
      return true;
    },
    copy: (text) => {
      calls.copy.push(text);
      return true;
    },
  });

  assert.equal(result.opened, true);
  assert.equal(result.copied, true);
  assert.equal(result.file, 'drafts/manual.json');
  assert.equal(result.url, calls.open[0]);
  assert.match(result.url, /^https:\/\/x\.com\/intent\/tweet\?text=/);
  assert.deepEqual(calls.copy, ['Hello from xpost']);
  assert.equal(calls.saved.length, 1);
  assert.deepEqual(calls.saved[0], {
    status: 'manual',
    text: 'Hello from xpost',
    imagePath: 'drafts/media/x.png',
    url: result.url,
  });
  // When an image exists, the user is told to attach it by hand.
  assert.ok(lines.out.some((line) => line.includes('drafts/media/x.png')));
});

test('composeManually can skip the browser and clipboard entirely', async () => {
  const { lines, logger } = createLogger();
  let touched = 0;
  const saves = [];

  const result = await composeManually({
    text: 'Just print the link',
    logger,
    save: async (record) => {
      saves.push(record);
      return { file: 'f.json' };
    },
    settings: { browser: 'none', clipboard: 'none' },
    open: () => {
      touched += 1;
      return true;
    },
    copy: () => {
      touched += 1;
      return true;
    },
  });

  assert.equal(touched, 0);
  assert.equal(result.opened, false);
  assert.equal(result.copied, false);
  assert.equal(saves.length, 1);
  assert.match(saves[0].url, /intent\/tweet/);
  // The link is still printed so it can be copied by hand.
  assert.ok(lines.out.some((line) => line.includes('Just%20print%20the%20link')));
});

test('composeManually warns when the clipboard copy fails', async () => {
  const { lines, logger } = createLogger();
  const result = await composeManually({
    text: 'Draft text',
    logger,
    save: async () => ({ file: 'f.json' }),
    settings: { browser: 'auto', clipboard: 'auto' },
    open: () => true,
    copy: () => false,
  });

  assert.equal(result.copied, false);
  assert.equal(result.opened, true);
  assert.ok(lines.err.some((line) => line.includes('Clipboard copy failed')));
});

test('composeManually refuses empty text and a missing save function', async () => {
  const { logger } = createLogger();
  await assert.rejects(
    () => composeManually({ text: '  ', logger, save: async () => ({ file: 'f' }) }),
    UserError,
  );
  await assert.rejects(
    () => composeManually({ text: 'ok', logger }),
    /requires a save function/,
  );
});
