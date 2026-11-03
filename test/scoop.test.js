import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  DEFAULT_NITTER_INSTANCES,
  decodeEntities,
  latestScoop,
  parseFeed,
  saveScoop,
  scoopFromApi,
  scoopFromNitter,
  stripHtml,
} from '../src/scoop.js';
import { UserError } from '../src/util.js';

// Shape verified against a live Nitter instance on 2026-10-20.
const RSS_FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
<title>Search results for "freelancing"</title>
<item>
<title>How I got my first freelance client &amp; what I&#39;d do differently</title>
<dc:creator>@devjane</dc:creator>
<description><![CDATA[<p>Three lessons from a year of freelancing.<br>Thread 🧵</p>]]></description>
<pubDate>Mon, 19 Oct 2026 19:20:31 GMT</pubDate>
<guid isPermaLink="false">111</guid>
<link>http://mirror.example/devjane/status/111#m</link>
</item>
<item>
<title>RT by @amplifier: rates &amp; contracts</title>
<dc:creator>@originalvoice</dc:creator>
<description><![CDATA[<p>Set your rates higher.</p>]]></description>
<pubDate>Mon, 19 Oct 2026 18:00:00 GMT</pubDate>
<guid isPermaLink="false">222</guid>
<link>http://mirror.example/originalvoice/status/222#m</link>
</item>
<item>
<title>Duplicate of the first post</title>
<description><![CDATA[<p>Same status id as item one.</p>]]></description>
<link>http://mirror.example/devjane/status/111#m</link>
</item>
</channel></rss>`;

test('decodeEntities handles named, decimal and hex entities', () => {
  assert.equal(
    decodeEntities('a &amp; b &#65; &#x42; &lt;x&gt; &unknown; &AMP;'),
    'a & b A B <x> &unknown; &',
  );
});

test('stripHtml unwraps CDATA, line breaks and tags into plain text', () => {
  assert.equal(
    stripHtml('<![CDATA[<p>Hi<br>there &amp; more</p>]]>'),
    'Hi\nthere & more',
  );
  assert.equal(stripHtml('<script>alert(1)</script><b>bold</b>'), 'bold');
});

test('parseFeed normalizes Nitter RSS into posts with x.com permalinks', () => {
  const posts = parseFeed(RSS_FIXTURE);

  // Three items in, one retweet, one duplicate → two unique posts out.
  assert.equal(posts.length, 2);

  const [original, retweet] = posts;
  assert.equal(original.text, 'Three lessons from a year of freelancing.\nThread 🧵');
  assert.equal(original.author, '@devjane');
  assert.equal(original.url, 'https://x.com/devjane/status/111');
  assert.equal(original.id, '111');
  assert.equal(original.isRetweet, false);
  assert.match(original.createdAt, /Mon, 19 Oct 2026/);

  assert.equal(retweet.text, 'Set your rates higher.');
  assert.equal(retweet.author, '@originalvoice');
  assert.equal(retweet.isRetweet, true);
});

test('parseFeed falls back to Atom entries', () => {
  const atom = `<feed><entry><title>Atom post</title><summary>Body text</summary>
<published>2026-10-20T00:00:00Z</published></entry></feed>`;
  const posts = parseFeed(atom);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].text, 'Body text');
});

test('scoopFromNitter falls through broken instances to the first working one', async () => {
  const fetchImpl = async (url) => {
    if (url.includes('bad.example')) throw new Error('ECONNREFUSED');
    if (url.includes('empty.example')) {
      return { ok: true, text: async () => '<rss version="2.0"><channel></channel></rss>' };
    }
    return { ok: true, text: async () => RSS_FIXTURE };
  };

  const { posts, host } = await scoopFromNitter({
    query: 'freelancing',
    limit: 5,
    instances: ['bad.example', 'empty.example', 'good.example/'],
    fetchImpl,
  });

  // The host is returned normalized (scheme added, trailing slash stripped).
  assert.equal(host, 'https://good.example');
  assert.equal(posts.length, 1);
  assert.equal(posts[0].author, '@devjane');
  assert.equal(posts[0].isRetweet, false);
});

test('scoopFromNitter reports every failed source when nothing works', async () => {
  const fetchImpl = async () => ({ ok: false, status: 403, text: async () => '' });

  await assert.rejects(
    () => scoopFromNitter({ query: 'x', instances: ['a.example'], fetchImpl }),
    (error) =>
      error instanceof UserError &&
      /returned nothing/.test(error.message) &&
      /NITTER_INSTANCES/.test(error.hint ?? ''),
  );

  await assert.rejects(
    () => scoopFromNitter({ query: 'x', instances: [] }),
    /No Nitter instances configured/,
  );
});

test('scoopFromApi maps search results and reports the estimated cost', async () => {
  const seen = {};
  const client = {
    v2: {
      get: async (endpoint, params) => {
        seen.endpoint = endpoint;
        seen.params = params;
        return {
          data: [
            {
              id: '900',
              text: 'Freelance rate card template',
              author_id: 'u1',
              created_at: '2026-10-20T10:00:00.000Z',
            },
          ],
          includes: { users: [{ id: 'u1', username: 'alicewrites' }] },
        };
      },
    },
  };
  const costs = [];

  const posts = await scoopFromApi({
    client,
    query: 'freelancing',
    limit: 12,
    onCost: (...args) => costs.push(args),
  });

  assert.equal(seen.endpoint, 'tweets/search/recent');
  assert.equal(seen.params.query, 'freelancing -is:retweet');
  assert.equal(seen.params.max_results, 12);
  // 12 returned posts × $0.005 per read ≈ $0.06.
  assert.deepEqual(costs[0], ['0.06', 12]);

  assert.equal(posts.length, 1);
  assert.equal(posts[0].author, '@alicewrites');
  assert.equal(posts[0].url, 'https://x.com/i/status/900');
  assert.equal(posts[0].isRetweet, false);
});

test('scoopFromApi clamps max_results to X limits (10..100)', async () => {
  const seen = [];
  const client = {
    v2: {
      get: async (endpoint, params) => {
        seen.push(params);
        return { data: [{ id: '1', text: 't' }] };
      },
    },
  };

  await scoopFromApi({ client, query: 'q', limit: 3 });
  await scoopFromApi({ client, query: 'q', limit: 500 });

  assert.equal(seen[0].max_results, 10);
  assert.equal(seen[1].max_results, 100);
});

test('scoopFromApi raises actionable errors for empty results and billing failures', async () => {
  await assert.rejects(
    () => scoopFromApi({ client: { v2: { get: async () => ({ data: [] }) } }, query: 'nothing' }),
    /returned no posts/,
  );

  await assert.rejects(
    () =>
      scoopFromApi({
        client: {
          v2: {
            get: async () => {
              throw { code: 402, data: { detail: 'out of credits' } };
            },
          },
        },
        query: 'freelancing',
      }),
    (error) => error instanceof UserError && /402/.test(error.message) && /out of credits/.test(error.message),
  );
});

test('saveScoop and latestScoop persist scoops under drafts/scoops', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'xpost-scoop-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const { file, record } = await saveScoop({
    draftsDir: dir,
    query: 'freelancing',
    source: 'nitter',
    posts: [
      {
        text: 'hi',
        author: '@a',
        url: 'https://x.com/a/status/1',
        id: '1',
        createdAt: null,
        isRetweet: false,
      },
    ],
    createdAt: new Date('2026-10-20T10:00:00Z'),
  });

  assert.match(file, /scoops[\\/]scoop-/);
  assert.equal(record.count, 1);
  assert.equal(record.source, 'nitter');

  // A second, newer scoop should win — even if a corrupt file is in the way.
  await saveScoop({
    draftsDir: dir,
    query: 'rates',
    source: 'nitter',
    posts: [{ text: 'later', author: '@b', url: 'https://x.com/b/status/2' }],
    createdAt: new Date('2026-10-20T11:00:00Z'),
  });
  await writeFile(path.join(dir, 'scoops', 'scoop-9999.json'), '{ not json', 'utf8');

  const latest = await latestScoop(dir);
  assert.equal(latest.query, 'rates');
  assert.equal(latest.posts.length, 1);

  const files = (await readdir(path.join(dir, 'scoops'))).filter((name) => name.endsWith('.json'));
  assert.equal(files.length, 3);

  assert.equal(await latestScoop(path.join(dir, 'does-not-exist')), null);
});

test('the default Nitter instance list is non-empty and host-shaped', () => {
  assert.ok(Array.isArray(DEFAULT_NITTER_INSTANCES));
  assert.ok(DEFAULT_NITTER_INSTANCES.length >= 1);
  for (const host of DEFAULT_NITTER_INSTANCES) {
    assert.match(host, /^[\w.-]+$/);
  }
});
