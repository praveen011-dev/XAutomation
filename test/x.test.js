import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { assertUsableMedia, describeXError, postTweet } from '../src/x.js';

async function tempPng(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'xpost-x-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'photo.png');
  await writeFile(file, Buffer.from('89504e470d0a1a0a', 'hex'));
  return file;
}

function fakeClient(calls) {
  return {
    v1: {
      uploadMedia: async (file) => {
        calls.push(['upload', file]);
        return 'media-123';
      },
    },
    v2: {
      tweet: async (payload) => {
        calls.push(['tweet', payload]);
        return { data: { id: '999' } };
      },
    },
  };
}

test('uploads media first, then posts with media_ids', async (t) => {
  const image = await tempPng(t);
  const calls = [];

  const result = await postTweet({
    client: fakeClient(calls),
    text: 'hello X',
    imagePath: image,
  });

  assert.deepEqual(calls, [
    ['upload', image],
    ['tweet', { text: 'hello X', media: { media_ids: ['media-123'] } }],
  ]);
  assert.equal(result.id, '999');
  assert.equal(result.url, 'https://x.com/i/status/999');
});

test('posts text only when no image is given', async (t) => {
  const calls = [];

  await postTweet({ client: fakeClient(calls), text: 'just text' });

  assert.deepEqual(calls, [['tweet', { text: 'just text' }]]);
});

test('rejects empty text before touching the API', async (t) => {
  const calls = [];
  await assert.rejects(
    postTweet({ client: fakeClient(calls), text: '   ' }),
    /empty tweet/,
  );
  assert.equal(calls.length, 0);
});

test('rejects unsupported extensions and missing files', async (t) => {
  assert.throws(() => assertUsableMedia('/tmp/photo.bmp'), /PNG, JPG, WEBP, or GIF/);
  assert.throws(() => assertUsableMedia('/tmp/does-not-exist.png'), /Cannot read image/);
});

test('explains auth and permission errors', () => {
  assert.match(describeXError({ code: 401, data: { detail: 'Unauthorized' } }), /X_\* keys/);
  assert.match(describeXError({ code: 403, data: { detail: 'Forbidden' } }), /Read and write/);
  assert.match(describeXError({ code: 429, data: { detail: 'Rate limit exceeded' } }), /15 minutes/);
  assert.match(describeXError({ data: { errors: [{ message: 'Something else' }] } }), /Something else/);
});
