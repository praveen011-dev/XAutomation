import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { describeXError } from './x.js';
import { UserError } from './util.js';

export const DEFAULT_SCOOP_QUERY = 'freelancing';
export const DEFAULT_SCOOP_LIMIT = 10;

/**
 * Free Nitter front-ends with RSS enabled, ordered by observed health
 * (checked 2026-10-20, tracker: https://status.d420.de/). Override with
 * NITTER_INSTANCES=host1,host2 — instances appear and disappear often, so
 * failures fall through to the next one instead of aborting.
 */
export const DEFAULT_NITTER_INSTANCES = [
  'nitter.meowing.monster',
  'nitter.netbub.com',
  'nitter.kareem.one',
  'nitter.pp.ua',
  'nitter.tiekoetter.com',
];

/** Official X search bills $0.005 per Post resource returned (Oct 2026). */
export const X_POST_READ_PRICE = 0.005;

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

export function decodeEntities(text) {
  const named = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
  };
  return String(text ?? '').replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity) => {
    if (entity[0] === '#') {
      const code =
        entity[1] === 'x' || entity[1] === 'X'
          ? Number.parseInt(entity.slice(2), 16)
          : Number.parseInt(entity.slice(1), 10);
      if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) {
        try {
          return String.fromCodePoint(code);
        } catch {
          return match;
        }
      }
      return match;
    }
    return named[entity.toLowerCase()] ?? match;
  });
}

/** Turn an RSS/Atom HTML fragment into plain, readable post text. */
export function stripHtml(html) {
  const text = String(html ?? '')
    .replace(/<!\[CDATA\[/g, '')
    .replace(/\]\]>/g, '')
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .split('\n')
    .map((line) => decodeEntities(line).replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
    .trim();
  return text;
}

function xmlField(block, tag) {
  const match = block.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  if (!match) return '';
  return stripHtml(match[1]);
}

function authorFromUrl(url) {
  const match = String(url ?? '').match(/\/([^/?#]+)\/status\/(\d+)/);
  if (!match) return { author: '', id: '' };
  return { author: `@${decodeURIComponent(match[1])}`, id: match[2] };
}

/**
 * Parse a Nitter (RSS 2.0) or Atom search feed into normalized posts.
 * Nitter item shape (verified live 2026-10-20):
 *   <item><title>…</title><dc:creator>@user</dc:creator>
 *   <description><![CDATA[<p>…</p>]]></description>
 *   <pubDate>…</pubDate><guid …>123</guid><link>…/user/status/123#m</link></item>
 */
export function parseFeed(xml) {
  const source = String(xml ?? '');
  let blocks = [...source.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)].map((m) => m[1]);
  if (!blocks.length) {
    blocks = [...source.matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/gi)].map((m) => m[1]);
  }

  const posts = [];
  const seen = new Set();

  for (const block of blocks) {
    const title = xmlField(block, 'title');
    const description = xmlField(block, 'description') || xmlField(block, 'summary');
    const text = description || title;
    if (!text) continue;

    const link = xmlField(block, 'link');
    const { author: linkAuthor, id: linkId } = authorFromUrl(link);
    const creator = xmlField(block, 'dc:creator') || xmlField(block, 'creator');
    const guid = xmlField(block, 'guid');
    const id = linkId || guid;
    const url = id && linkAuthor ? `https://x.com/${linkAuthor.slice(1)}/status/${id}` : link;
    const key = id || url || text.slice(0, 80);
    if (seen.has(key)) continue;
    seen.add(key);

    const isRetweet = /^RT (by|@)/i.test(title) || /^RT @/.test(text);

    posts.push({
      text,
      author: creator || linkAuthor,
      url,
      id: id || null,
      createdAt: xmlField(block, 'pubDate') || xmlField(block, 'published') || xmlField(block, 'updated') || null,
      isRetweet,
    });
  }

  return posts;
}

function normalizeInstance(raw) {
  const value = String(raw ?? '').trim();
  if (!value) return '';
  const withScheme = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  return withScheme.replace(/\/+$/, '');
}

function searchPaths(query) {
  const encoded = encodeURIComponent(query);
  return [`/search/rss?q=${encoded}&f=tweets`, `/search?q=${encoded}&f=tweets&format=rss`];
}

/**
 * Free source: public Nitter RSS feeds. Tries every instance × path until one
 * returns posts, and reports each failed attempt so a dead list is diagnosable.
 */
export async function scoopFromNitter({
  query,
  limit = DEFAULT_SCOOP_LIMIT,
  instances = DEFAULT_NITTER_INSTANCES,
  fetchImpl = fetch,
  timeoutMs = 12_000,
}) {
  const hosts = instances.map(normalizeInstance).filter(Boolean);
  if (!hosts.length) {
    throw new UserError(
      'No Nitter instances configured. Set NITTER_INSTANCES=host1,host2 or use --source api.',
    );
  }

  const attempts = [];
  for (const host of hosts) {
    for (const searchPath of searchPaths(query)) {
      const url = `${host}${searchPath}`;
      try {
        const response = await fetchImpl(url, {
          headers: {
            'user-agent': BROWSER_UA,
            accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
          },
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!response.ok) {
          attempts.push(`${host} → HTTP ${response.status}`);
          continue;
        }

        const feed = await response.text();
        const all = parseFeed(feed);
        if (!all.length) {
          attempts.push(`${host} → no results`);
          continue;
        }

        const originals = all.filter((post) => !post.isRetweet);
        const chosen = (originals.length ? originals : all).slice(0, limit);
        return { posts: chosen, host };
      } catch (error) {
        attempts.push(`${host} → ${error.message}`);
      }
    }
  }

  throw new UserError(`Free Nitter sources returned nothing (${attempts.length} attempts).`, {
    hint: [
      `Tried: ${attempts.slice(0, 4).join(' | ')}`,
      'Instances change often — set NITTER_INSTANCES=host1,host2, or use --source api',
      `(${X_POST_READ_PRICE} USD per post returned, official and ToS-safe).`,
    ].join('\n  '),
  });
}

/** Official source: GET /2/tweets/search/recent via the OAuth 1.0a client. */
export async function scoopFromApi({
  client,
  query,
  limit = DEFAULT_SCOOP_LIMIT,
  onCost,
}) {
  const maxResults = Math.min(100, Math.max(10, limit));
  const estimate = (maxResults * X_POST_READ_PRICE).toFixed(2);
  onCost?.(estimate, maxResults);

  let payload;
  try {
    payload = await client.v2.get('tweets/search/recent', {
      query: `${query} -is:retweet`,
      max_results: maxResults,
      'tweet.fields': 'created_at,author_id',
      expansions: 'author_id',
      'user.fields': 'username',
    });
  } catch (error) {
    throw new UserError(describeXError(error));
  }

  const usernames = new Map(
    (payload?.includes?.users ?? []).map((user) => [user.id, user.username]),
  );

  const posts = (payload?.data ?? []).map((tweet) => ({
    text: tweet.text,
    author: usernames.get(tweet.author_id) ? `@${usernames.get(tweet.author_id)}` : '',
    url: `https://x.com/i/status/${tweet.id}`,
    id: tweet.id,
    createdAt: tweet.created_at ?? null,
    isRetweet: false,
  }));

  if (!posts.length) {
    throw new UserError(`X search returned no posts for "${query}".`, {
      hint: 'Try a broader topic, or check query syntax at https://docs.x.com/x-api/posts/search/introduction',
    });
  }

  return posts.slice(0, limit);
}

export function scoopId(now = new Date()) {
  const stamp = now.toISOString().replace(/\.\d{3}Z$/, '').replace(/:/g, '-');
  return `scoop-${stamp}`;
}

export async function saveScoop({
  draftsDir,
  query,
  source,
  posts,
  createdAt = new Date(),
}) {
  const dir = path.join(draftsDir, 'scoops');
  await mkdir(dir, { recursive: true });

  const record = {
    id: scoopId(createdAt),
    createdAt: createdAt.toISOString(),
    query,
    source,
    count: posts.length,
    posts,
  };
  const file = path.join(dir, `${record.id}.json`);
  await writeFile(file, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  return { file, record };
}

/** Newest saved scoop, used as a fallback when live sources are down. */
export async function latestScoop(draftsDir) {
  const dir = path.join(draftsDir, 'scoops');
  let entries;
  try {
    entries = await readdir(dir);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }

  const files = entries.filter((entry) => entry.endsWith('.json')).sort().reverse();
  for (const file of files) {
    try {
      const record = JSON.parse(await readFile(path.join(dir, file), 'utf8'));
      if (Array.isArray(record.posts) && record.posts.length) return record;
    } catch {
      // Skip a partially written or hand-edited scoop file.
    }
  }
  return null;
}
