export const DEFAULT_MAX_CHARS = 280;
const URL_LENGTH = 23;
const URL_PATTERN = /https?:\/\/[^\s]+/g;

// X counts most Latin/Greek/Cyrillic/Hebrew/Arabic characters as 1 and
// everything else (CJK, emoji, ...) as 2. Links always count as 23.
const LIGHT_RANGES = [
  [0x0000, 0x10ff],
  [0x2000, 0x200d],
  [0x2010, 0x2017],
  [0x2032, 0x2037],
];

function isLightCodePoint(codePoint) {
  return LIGHT_RANGES.some(([start, end]) => codePoint >= start && codePoint <= end);
}

export function countTweetLength(text) {
  const withoutLinks = String(text ?? '').replace(URL_PATTERN, 'x'.repeat(URL_LENGTH));
  let length = 0;
  for (const character of withoutLinks) {
    length += isLightCodePoint(character.codePointAt(0)) ? 1 : 2;
  }
  return length;
}

/**
 * Strip artefacts models commonly add: code fences, a leading "Tweet:" label,
 * markdown bold, and surrounding quote marks. Keeps hashtags and line breaks.
 */
export function normalizeDraftText(raw) {
  if (typeof raw !== 'string') return '';

  let text = raw.replace(/\r\n/g, '\n').trim();

  const fence = text.match(/^```(?:[a-z0-9_-]+)?\s*\n([\s\S]*?)\n?```$/i);
  if (fence) text = fence[1].trim();

  text = text.replace(/^(?:tweet|post|draft)\s*[:\-]\s*/i, '');

  while (
    text.length >= 2 &&
    ((text.startsWith('"') && text.endsWith('"')) ||
      (text.startsWith('“') && text.endsWith('”')))
  ) {
    text = text.slice(1, -1).trim();
  }

  text = text
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return text;
}

export function validateTweet(text, maxChars = DEFAULT_MAX_CHARS) {
  const value = String(text ?? '').trim();
  const length = countTweetLength(value);
  const problems = [];

  if (!value) problems.push('The tweet is empty.');
  if (length > maxChars) {
    problems.push(`Too long: ${length}/${maxChars} characters.`);
  }

  return {
    ok: problems.length === 0,
    length,
    remaining: maxChars - length,
    problems,
  };
}

export function hashtagCount(text) {
  return (String(text).match(/(^|\s)#[A-Za-z0-9_]+/g) ?? []).length;
}
