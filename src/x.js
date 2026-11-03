import { statSync } from 'node:fs';
import path from 'node:path';
import { TwitterApi } from 'twitter-api-v2';
import { X_MEDIA_LIMIT_BYTES } from './config.js';
import { UserError } from './util.js';

const ALLOWED_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);

export function createXClient(config) {
  return new TwitterApi({
    appKey: config.x.apiKey,
    appSecret: config.x.apiSecret,
    accessToken: config.x.accessToken,
    accessSecret: config.x.accessSecret,
  });
}

export async function verifyCredentials(client) {
  const { data } = await client.v2.me();
  return data;
}

export function assertUsableMedia(imagePath) {
  if (!imagePath) return;

  const extension = path.extname(imagePath).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(extension)) {
    throw new UserError(
      `X does not accept ${extension || 'that'} images. Use PNG, JPG, WEBP, or GIF.`,
    );
  }

  let size;
  try {
    size = statSync(imagePath).size;
  } catch (error) {
    throw new UserError(`Cannot read image ${imagePath}: ${error.message}`);
  }

  if (size > X_MEDIA_LIMIT_BYTES) {
    throw new UserError(
      `Image is ${(size / (1024 * 1024)).toFixed(2)} MB; X allows at most 5 MB.`,
    );
  }
}

/** Upload the image first (if any), then create the post. */
export async function postTweet({ client, text, imagePath = null }) {
  if (!text?.trim()) throw new UserError('Refusing to post an empty tweet.');
  assertUsableMedia(imagePath);

  let mediaId = null;
  if (imagePath) {
    mediaId = await client.v1.uploadMedia(imagePath);
  }

  const payload = { text };
  if (mediaId) payload.media = { media_ids: [mediaId] };

  const { data } = await client.v2.tweet(payload);
  return {
    id: data.id,
    url: `https://x.com/i/status/${data.id}`,
    mediaId,
  };
}

export function describeXError(error) {
  const status = Number(error?.code) || Number(error?.status) || undefined;
  const data = error?.data;
  const detail =
    data?.detail ||
    data?.title ||
    data?.errors?.[0]?.message ||
    (typeof data?.error === 'string' ? data.error : '') ||
    error?.message ||
    String(error);

  const hints = {
    401: 'Check the four X_* keys in .env. Also confirm the app has "Read and write" permission and that the access token was regenerated afterwards.',
    403: 'The app probably lacks write permission. Set "Read and write" in the X Developer Console, then regenerate the access token and secret.',
    402: 'X may require API credits for posting. Check your plan in the Developer Console — a post costs about $0.015, more if it contains a URL.',
    429: 'X rate limit hit. Wait a few minutes (limits reset every 15 minutes) and try again.',
  };

  const hint = hints[status];
  return `X API error${status ? ` (${status})` : ''}: ${detail}${hint ? `\n  ${hint}` : ''}`;
}
