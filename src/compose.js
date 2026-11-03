import { spawnSync } from 'node:child_process';

import { UserError } from './util.js';

export const INTENT_BASE_URL = 'https://x.com/intent/tweet';

/**
 * Web Intents open X's own composer with the text pre-filled. The user still
 * presses Post. This does not make a request to the X API; posting is completed
 * manually in X.
 * https://docs.x.com/x-for-websites/web-intents/overview
 */
export function buildIntentUrl(text, base = INTENT_BASE_URL) {
  const value = String(text ?? '').trim();
  if (!value) throw new UserError('Refusing to build a composer link for empty text.');
  return `${base}?text=${encodeURIComponent(value)}`;
}

/** Best-effort: open a URL in the user's browser. Returns true on success. */
export function openUrl(url, platform = process.platform) {
  try {
    if (platform === 'win32') {
      // rundll32.exe takes the URL as one plain argument — no shell quoting,
      // no cmd.exe metacharacter surprises with percent-encoded text.
      const result = spawnSync('rundll32.exe', ['url.dll,FileProtocolHandler', url], {
        windowsHide: true,
        timeout: 15_000,
      });
      return !result.error && result.status === 0;
    }
    const command = platform === 'darwin' ? 'open' : 'xdg-open';
    const result = spawnSync(command, [url], { timeout: 15_000, stdio: 'ignore' });
    return !result.error && result.status === 0;
  } catch {
    return false;
  }
}

/** Best-effort: put the draft text on the clipboard. Returns true on success. */
export function copyText(text, platform = process.platform) {
  try {
    if (platform === 'win32') {
      const result = spawnSync('clip.exe', [], { input: String(text), windowsHide: true, timeout: 15_000 });
      return !result.error && result.status === 0;
    }
    if (platform === 'darwin') {
      const result = spawnSync('pbcopy', [], { input: String(text), timeout: 15_000 });
      return !result.error && result.status === 0;
    }
    for (const [command, args] of [
      ['wl-copy', []],
      ['xclip', ['-selection', 'clipboard']],
    ]) {
      const result = spawnSync(command, args, {
        input: String(text),
        timeout: 15_000,
        stdio: ['pipe', 'ignore', 'ignore'],
      });
      if (!result.error && result.status === 0) return true;
    }
    return false;
  } catch {
    return false;
  }
}

const CREDIT_PATTERN = /credit|billing|payment|invoice|usage cap|insufficient/i;

/**
 * True when X rejected a call because the account cannot pay for it —
 * HTTP 402, or a 4xx whose payload talks about credits/billing. Auth (401)
 * and rate limits (429) are deliberately not credit errors.
 */
export function isCreditError(error) {
  const status = Number(error?.code) || Number(error?.status) || undefined;
  if (status === 402) return true;

  const detail = [
    error?.data?.detail,
    error?.data?.title,
    typeof error?.data?.error === 'string' ? error.data.error : '',
    error?.message,
  ]
    .filter(Boolean)
    .join(' ');

  return CREDIT_PATTERN.test(detail);
}

/**
 * Prepare a draft for X's composer instead of publishing through the API.
 * Nothing is posted here — the flow ends with the human pressing Post.
 *
 * settings: { browser: 'auto'|'none', clipboard: 'auto'|'none' }
 */
export async function composeManually({
  text,
  imagePath = null,
  logger,
  save,
  settings = {},
  platform = process.platform,
  open = openUrl,
  copy = copyText,
}) {
  if (!String(text ?? '').trim()) {
    throw new UserError('Refusing to open the composer for empty text.');
  }
  if (typeof save !== 'function') {
    throw new UserError('composeManually requires a save function.');
  }

  const url = buildIntentUrl(text);
  const enabled = (value) => String(value ?? 'auto').toLowerCase() !== 'none';

  let copied = false;
  if (enabled(settings.clipboard)) {
    copied = Boolean(copy(text, platform));
    if (copied) logger.detail('  Draft text copied to the clipboard.');
    else logger.warn('Clipboard copy failed — the composer opens pre-filled anyway.');
  }

  let opened = false;
  if (enabled(settings.browser)) {
    opened = Boolean(open(url, platform));
    if (opened) logger.success('X composer opened in your browser — review it and press Post.');
    else logger.warn('Could not open a browser automatically.');
  }
  logger.detail(`  ${url}`);

  if (imagePath) {
    logger.info('  Intent links cannot carry files — attach the image in the composer:');
    logger.detail(`    ${imagePath}`);
  }

  const saved = await save({ status: 'manual', text, imagePath, url });
  return { url, opened, copied, file: saved?.file ?? null };
}
