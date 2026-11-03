import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { listDrafts, saveDraft, saveImage } from '../src/drafts.js';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

async function tempDir(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'xpost-drafts-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('saves an image inside the drafts media folder', async (t) => {
  const dir = await tempDir(t);

  const file = await saveImage({
    draftsDir: dir,
    buffer: PNG,
    mimeType: 'image/png',
    id: 'image-1',
  });

  assert.equal(path.basename(file), 'image-1.png');
  assert.equal((await stat(file)).size, PNG.length);
});

test('stores records, keeps media relative, and sorts newest first', async (t) => {
  const dir = await tempDir(t);
  const media = await saveImage({
    draftsDir: dir,
    buffer: PNG,
    mimeType: 'image/png',
    id: 'shot',
  });

  const older = await saveDraft({
    draftsDir: dir,
    text: 'older draft',
    imagePath: media,
    status: 'dry-run',
    source: { kind: 'activity' },
    model: 'gemini-test',
    createdAt: new Date('2026-10-18T10:00:00Z'),
  });
  const newer = await saveDraft({
    draftsDir: dir,
    text: 'newer draft',
    status: 'posted',
    tweetId: '42',
    url: 'https://x.com/i/status/42',
    createdAt: new Date('2026-10-19T10:00:00Z'),
  });

  assert.equal(older.record.image, path.join('media', 'shot.png').split(path.sep).join('/'));
  assert.deepEqual(older.record.source, { kind: 'activity' });
  assert.equal(newer.record.url, 'https://x.com/i/status/42');

  const listed = await listDrafts(dir);
  assert.equal(listed.length, 2);
  assert.equal(listed[0].text, 'newer draft');
  assert.equal(listed[1].text, 'older draft');

  const stored = JSON.parse(await readFile(older.file, 'utf8'));
  assert.equal(stored.model, 'gemini-test');
});

test('copies an image from outside the drafts folder', async (t) => {
  const dir = await tempDir(t);
  const externalDir = await tempDir(t);
  const external = path.join(externalDir, 'outside.png');
  await writeFile(external, PNG);

  const { record } = await saveDraft({
    draftsDir: dir,
    text: 'with copied image',
    imagePath: external,
  });

  assert.match(record.image, /^media\/.+\.png$/);
  const copied = path.join(dir, record.image);
  assert.equal((await stat(copied)).size, PNG.length);
});
