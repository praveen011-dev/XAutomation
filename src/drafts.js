import { randomBytes } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const EXTENSION_BY_MIME = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

export function draftId(now = new Date()) {
  const stamp = now.toISOString().replace(/\.\d{3}Z$/, '').replace(/:/g, '-');
  return `${stamp}-${randomBytes(2).toString('hex')}`;
}

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function toPosix(value) {
  return value.split(path.sep).join('/');
}

export async function saveImage({ draftsDir, buffer, mimeType, id = draftId() }) {
  const extension = EXTENSION_BY_MIME[mimeType] ?? 'png';
  const mediaDir = path.join(draftsDir, 'media');
  await mkdir(mediaDir, { recursive: true });

  const file = path.join(mediaDir, `${id}.${extension}`);
  await writeFile(file, buffer);
  return file;
}

export async function saveDraft({
  draftsDir,
  text,
  imagePath = null,
  status = 'draft',
  source = null,
  model = null,
  tweetId = null,
  url = null,
  error = null,
  createdAt = new Date(),
}) {
  const id = draftId(createdAt);
  await mkdir(draftsDir, { recursive: true });

  let storedImage = null;
  if (imagePath) {
    if (isInside(draftsDir, imagePath)) {
      storedImage = toPosix(path.relative(draftsDir, imagePath));
    } else {
      const mediaDir = path.join(draftsDir, 'media');
      await mkdir(mediaDir, { recursive: true });
      const extension = path.extname(imagePath) || '.png';
      const destination = path.join(mediaDir, `${id}${extension}`);
      await copyFile(imagePath, destination);
      storedImage = toPosix(path.relative(draftsDir, destination));
    }
  }

  const record = {
    id,
    createdAt: createdAt.toISOString(),
    status,
    text,
    image: storedImage,
    model,
    source,
    tweetId,
    url,
    error,
  };

  const file = path.join(draftsDir, `${id}.json`);
  await writeFile(file, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  return { file, record };
}

export async function updateDraft(file, patch) {
  const record = JSON.parse(await readFile(file, 'utf8'));
  const next = { ...record, ...patch };
  await writeFile(file, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return next;
}

export async function listDrafts(draftsDir, limit = 10) {
  let entries;
  try {
    entries = await readdir(draftsDir);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }

  const records = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    try {
      const parsed = JSON.parse(await readFile(path.join(draftsDir, entry), 'utf8'));
      records.push(parsed);
    } catch {
      // A partially written or hand-edited file should not break history.
    }
  }

  return records
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, limit);
}
