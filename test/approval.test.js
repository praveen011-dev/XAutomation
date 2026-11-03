import assert from 'node:assert/strict';
import test from 'node:test';

import { reviewDraft } from '../src/approval.js';

function fakeRl(answers) {
  return {
    question: async () => (answers.length ? answers.shift() : 'q'),
    once() {},
    off() {},
  };
}

function stubLogger() {
  const messages = [];
  const record = (kind) => (message) => messages.push({ kind, message });
  return {
    messages,
    info: record('info'),
    step: record('step'),
    success: record('success'),
    warn: record('warn'),
    error: record('error'),
    detail: record('detail'),
    blank() {},
  };
}

const out = { write() {} };

test('p during a dry run saves the draft and never calls post', async () => {
  const saved = [];
  let posted = false;

  const result = await reviewDraft({
    text: 'hello world',
    maxChars: 280,
    dryRun: true,
    interactive: false,
    rl: fakeRl(['p']),
    logger: stubLogger(),
    out,
    save: async (payload) => {
      saved.push(payload);
      return { file: 'draft.json' };
    },
    post: async () => {
      posted = true;
    },
  });

  assert.equal(result.action, 'dry-run');
  assert.equal(posted, false);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].status, 'dry-run');
  assert.equal(saved[0].text, 'hello world');
});

test('blocks an over-limit draft until the user saves or edits', async () => {
  const logger = stubLogger();
  const saved = [];

  const result = await reviewDraft({
    text: 'a'.repeat(300),
    maxChars: 280,
    dryRun: true,
    rl: fakeRl(['p', 's']),
    logger,
    out,
    save: async (payload) => {
      saved.push(payload);
      return { file: 'draft.json' };
    },
    post: async () => {
      throw new Error('post must not be called for an over-limit draft');
    },
  });

  assert.equal(result.action, 'saved');
  assert.equal(saved.length, 1);
  assert.equal(saved[0].status, 'saved');
  assert.ok(
    logger.messages.some(
      (entry) => entry.kind === 'warn' && /Too long/.test(entry.message),
    ),
  );
});

test('refuses to post from a non-interactive terminal', async () => {
  const logger = stubLogger();
  let posted = false;

  const result = await reviewDraft({
    text: 'hello world',
    maxChars: 280,
    dryRun: false,
    interactive: false,
    rl: fakeRl(['p']),
    logger,
    out,
    save: async () => ({ file: 'draft.json' }),
    post: async () => {
      posted = true;
    },
  });

  assert.equal(result.action, 'refused');
  assert.equal(posted, false);
  assert.ok(
    logger.messages.some(
      (entry) => entry.kind === 'error' && /Refusing to post/.test(entry.message),
    ),
  );
});

test('regenerates on r and keeps the new text', async () => {
  let previous = null;

  const result = await reviewDraft({
    text: 'first draft',
    maxChars: 280,
    dryRun: true,
    rl: fakeRl(['r', 'q']),
    logger: stubLogger(),
    out,
    regenerate: async (current) => {
      previous = current;
      return 'second draft';
    },
    save: async () => ({ file: 'draft.json' }),
    post: async () => {
      throw new Error('must not post');
    },
  });

  assert.equal(previous, 'first draft');
  assert.equal(result.action, 'quit');
  assert.equal(result.text, 'second draft');
});
