import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';


const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'src', 'cli.js');

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('end-to-end-image'),
]);

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
}

async function createRepo(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'xpost-e2e-repo-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'dev@example.com']);
  git(dir, ['config', 'user.name', 'Dev']);
  await writeFile(path.join(dir, 'app.js'), 'console.log("ship it");\n');
  git(dir, ['add', '.']);
  git(dir, ['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'feat: wire up the draft flow']);
  return dir;
}

async function startMockGemini(t, text) {
  const seen = [];

  const server = http.createServer((request, response) => {
    let raw = '';
    request.on('data', (chunk) => {
      raw += chunk;
    });
    request.on('end', () => {
      let body = null;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {
        body = raw;
      }
      seen.push({
        url: request.url,
        key: request.headers['x-goog-api-key'],
        body,
      });

      response.setHeader('content-type', 'application/json');

      if (request.url.includes(':generateContent')) {
        response.end(
          JSON.stringify({
            candidates: [{ content: { parts: [{ text }] } }],
          }),
        );
        return;
      }

      if (request.url.endsWith('/interactions')) {
        response.end(
          JSON.stringify({
            output_image: {
              data: PNG.toString('base64'),
              mime_type: 'image/png',
            },
          }),
        );
        return;
      }

      response.statusCode = 404;
      response.end(JSON.stringify({ error: { message: 'not found' } }));
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const { port } = server.address();
  return { baseUrl: `http://127.0.0.1:${port}/v1beta`, seen };
}

function runCli(args, { env, input = '' } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: ROOT,
      env: {
        ...process.env,
        NO_COLOR: '1',
        // Neutralize any ambient project .env so tests never open a real
        // browser, switch posting modes, or hit live Nitter/X endpoints.
        XPOST_MANUAL: '',
        XPOST_BROWSER: 'none',
        XPOST_CLIPBOARD: 'none',
        XPOST_SCOOP_SOURCE: '',
        NITTER_INSTANCES: '',
        ...env,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));

    child.stdin.end(input);
  });
}

async function makeDraftsDir(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'xpost-e2e-drafts-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('end to end: git activity → Gemini → approval → saved dry-run draft with image', async (t) => {
  const repo = await createRepo(t);
  const drafts = await makeDraftsDir(t);
  const mock = await startMockGemini(
    t,
    '"Shipped a small fix today.\n\nSmall steps count."',
  );

  const env = {
    GEMINI_API_KEY: 'test-key',
    GEMINI_BASE_URL: mock.baseUrl,
    GEMINI_MODEL: 'gemini-test',
    GEMINI_IMAGE_MODEL: 'image-test',
    GEMINI_TIMEOUT_MS: '10000',
    XPOST_DRAFTS_DIR: drafts,
    X_API_KEY: '',
    X_API_KEY_SECRET: '',
    X_ACCESS_TOKEN: '',
    X_ACCESS_TOKEN_SECRET: '',
    TWEET_REPOS: '',
    TWEET_GIT_EMAIL: '',
  };

  const result = await runCli(['--dry-run', '--repo', repo, '--image'], {
    env,
    input: 'p\n',
  });

  assert.equal(result.code, 0, `stderr:\n${result.stderr}`);
  assert.match(result.stdout, /DRAFT/);
  assert.match(result.stdout, /Shipped a small fix today/);
  assert.match(result.stdout, /Dry run complete/);
  assert.match(result.stdout, /nothing was sent to X/i);

  const files = (await readdir(drafts)).filter((file) => file.endsWith('.json'));
  assert.equal(files.length, 1);

  const record = JSON.parse(await readFile(path.join(drafts, files[0]), 'utf8'));
  assert.equal(record.status, 'dry-run');
  assert.equal(record.text, 'Shipped a small fix today.\n\nSmall steps count.');
  assert.equal(record.model, 'gemini-test');
  assert.equal(record.source.kind, 'activity');
  assert.equal(record.source.commits, 1);
  assert.match(record.image, /^media\/.+\.png$/);

  const imageFile = path.join(drafts, record.image);
  assert.equal((await stat(imageFile)).size, PNG.length);

  const textCall = mock.seen.find(
    (entry) => entry.url.includes('/models/gemini-test:generateContent'),
  );
  assert.ok(textCall, 'expected a text generation call');
  assert.equal(textCall.key, 'test-key');
  assert.match(
    textCall.body.contents[0].parts[0].text,
    /feat: wire up the draft flow/,
  );
  assert.ok(mock.seen.some((entry) => entry.url.endsWith('/interactions')));

  const history = await runCli(['history'], { env });
  assert.equal(history.code, 0, `stderr:\n${history.stderr}`);
  assert.match(history.stdout, /dry-run/);
  assert.match(history.stdout, /Shipped a small fix today/);
});

test('end to end: refuses to post when stdin is not a terminal', async (t) => {
  const repo = await createRepo(t);
  const drafts = await makeDraftsDir(t);
  const mock = await startMockGemini(t, 'A draft that must never be posted.');

  const env = {
    GEMINI_API_KEY: 'test-key',
    GEMINI_BASE_URL: mock.baseUrl,
    GEMINI_MODEL: 'gemini-test',
    GEMINI_TIMEOUT_MS: '10000',
    XPOST_DRAFTS_DIR: drafts,
    X_API_KEY: 'app-key',
    X_API_KEY_SECRET: 'app-secret',
    X_ACCESS_TOKEN: 'access-token',
    X_ACCESS_TOKEN_SECRET: 'access-secret',
    TWEET_REPOS: '',
    TWEET_GIT_EMAIL: '',
  };

  const result = await runCli(['--repo', repo], { env, input: 'p\n' });

  assert.equal(result.code, 2, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.match(result.stderr, /Refusing to post/);
  assert.doesNotMatch(result.stderr, /Posted:/);

  const entries = await readdir(drafts).catch(() => []);
  assert.equal(entries.filter((file) => file.endsWith('.json')).length, 0);
});

// Nitter RSS shape, as served by live instances on 2026-10-20.
function e2eRss() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
<title>Search results for "freelancing"</title>
<item>
<title>Charge 3x what you think you're worth, then subtract the awkward tax.</title>
<dc:creator>@ratecoach</dc:creator>
<description><![CDATA[<p>Charge 3x what you think you're worth, then subtract the awkward tax.<br>Freelance pricing mini-thread</p>]]></description>
<pubDate>Tue, 20 Oct 2026 09:00:00 GMT</pubDate>
<guid isPermaLink="false">3001</guid>
<link>http://mirror.test/ratecoach/status/3001#m</link>
</item>
<item>
<title>RT by @quoter: generic advice</title>
<dc:creator>@someoneelse</dc:creator>
<description><![CDATA[<p>Just do what you love.</p>]]></description>
<guid isPermaLink="false">3002</guid>
<link>http://mirror.test/someoneelse/status/3002#m</link>
</item>
</channel></rss>`;
}

async function startMockNitter(t) {
  const seen = [];
  const server = http.createServer((request, response) => {
    seen.push(request.url);
    if (request.url.startsWith('/search/rss') || request.url.startsWith('/search?')) {
      response.setHeader('content-type', 'application/rss+xml');
      response.end(e2eRss());
      return;
    }
    response.statusCode = 404;
    response.end('not found');
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const { port } = server.address();
  return { baseUrl: `http://127.0.0.1:${port}`, seen };
}

test('end to end: --manual publishes through the free intent composer, not the API', async (t) => {
  const drafts = await makeDraftsDir(t);

  const env = {
    GEMINI_API_KEY: '',
    XPOST_DRAFTS_DIR: drafts,
    X_API_KEY: '',
    X_API_KEY_SECRET: '',
    X_ACCESS_TOKEN: '',
    X_ACCESS_TOKEN_SECRET: '',
    TWEET_REPOS: '',
    TWEET_GIT_EMAIL: '',
  };

  const result = await runCli(
    ['--manual', '--text', 'Freelancing tip: charge for outcomes, not hours.'],
    { env, input: 'p\n' },
  );

  assert.equal(result.code, 0, `stderr:\n${result.stderr}`);
  assert.match(result.stdout, /composer prepared/i);
  assert.match(result.stdout, /x\.com\/intent\/tweet\?text=/);
  assert.doesNotMatch(result.stdout, /Posted: /);

  const files = (await readdir(drafts)).filter((file) => file.endsWith('.json'));
  assert.equal(files.length, 1);

  const record = JSON.parse(await readFile(path.join(drafts, files[0]), 'utf8'));
  assert.equal(record.status, 'manual');
  assert.match(record.url, /intent\/tweet\?text=/);
  assert.match(record.text, /charge for outcomes/);
});

test('end to end: xpost scoop scrapes free Nitter RSS and saves the scoop', async (t) => {
  const drafts = await makeDraftsDir(t);
  const nitter = await startMockNitter(t);

  const env = {
    GEMINI_API_KEY: '',
    XPOST_DRAFTS_DIR: drafts,
    NITTER_INSTANCES: nitter.baseUrl,
    TWEET_REPOS: '',
    TWEET_GIT_EMAIL: '',
  };

  const result = await runCli(['scoop', '--topic', 'freelancing', '--limit', '5'], { env });

  assert.equal(result.code, 0, `stderr:\n${result.stderr}`);
  assert.match(result.stdout, /Scooping "freelancing"/);
  assert.match(result.stdout, /1\. @ratecoach/);
  assert.match(result.stdout, /Charge 3x/);
  assert.match(result.stdout, /1 post saved/);
  assert.match(result.stdout, /xpost --scoop/);

  const scoopDir = path.join(drafts, 'scoops');
  const files = (await readdir(scoopDir)).filter((file) => file.endsWith('.json'));
  assert.equal(files.length, 1);

  const scoop = JSON.parse(await readFile(path.join(scoopDir, files[0]), 'utf8'));
  assert.equal(scoop.source, 'nitter');
  assert.equal(scoop.query, 'freelancing');
  assert.equal(scoop.posts.length, 1);
  assert.equal(scoop.posts[0].author, '@ratecoach');
  assert.equal(scoop.posts[0].url, 'https://x.com/ratecoach/status/3001');
  assert.equal(scoop.posts[0].isRetweet, false);
});

test('end to end: --scoop feeds scraped posts into the Gemini draft prompt', async (t) => {
  const repo = await createRepo(t);
  const drafts = await makeDraftsDir(t);
  const mock = await startMockGemini(t, 'Scope the contract before quoting the price.');
  const nitter = await startMockNitter(t);

  const env = {
    GEMINI_API_KEY: 'test-key',
    GEMINI_BASE_URL: mock.baseUrl,
    GEMINI_MODEL: 'gemini-test',
    GEMINI_TIMEOUT_MS: '10000',
    XPOST_DRAFTS_DIR: drafts,
    NITTER_INSTANCES: nitter.baseUrl,
    X_API_KEY: '',
    X_API_KEY_SECRET: '',
    X_ACCESS_TOKEN: '',
    X_ACCESS_TOKEN_SECRET: '',
    TWEET_REPOS: '',
    TWEET_GIT_EMAIL: '',
  };

  const result = await runCli(
    ['--dry-run', '--scoop', '--topic', 'freelancing', '--repo', repo],
    { env, input: 'p\n' },
  );

  assert.equal(result.code, 0, `stderr:\n${result.stderr}`);
  assert.match(result.stdout, /1 post found for context/);
  assert.match(result.stdout, /Inspiration: 1 scraped posts/);
  assert.match(result.stdout, /Dry run complete/);

  const textCall = mock.seen.find((entry) =>
    entry.url.includes('/models/gemini-test:generateContent'),
  );
  assert.ok(textCall, 'expected a text generation call');

  const prompt = textCall.body.contents[0].parts[0].text;
  assert.match(prompt, /Recent public X posts about "freelancing"/);
  assert.match(prompt, /Charge 3x what you think you're worth/);
  assert.match(prompt, /do not quote or closely paraphrase/);
});

test('end to end: an unquoted multi-word topic reaches the scraper', async (t) => {
  const drafts = await makeDraftsDir(t);
  const nitter = await startMockNitter(t);

  const env = {
    GEMINI_API_KEY: '',
    XPOST_DRAFTS_DIR: drafts,
    NITTER_INSTANCES: nitter.baseUrl,
    TWEET_REPOS: '',
    TWEET_GIT_EMAIL: '',
  };

  const result = await runCli(['scoop', '--topic', 'website', 'development', '--limit', '3'], {
    env,
  });

  assert.equal(result.code, 0, `stderr:\n${result.stderr}`);
  assert.match(result.stdout, /Scooping "website development"/);

  const asked = nitter.seen.map((url) => decodeURIComponent(url)).join(' ');
  assert.match(asked, /q=website development/);

  const scoopDir = path.join(drafts, 'scoops');
  const files = (await readdir(scoopDir)).filter((file) => file.endsWith('.json'));
  const scoop = JSON.parse(await readFile(path.join(scoopDir, files[0]), 'utf8'));
  assert.equal(scoop.query, 'website development');
});

function waitForServerUrl(child, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(
      () => reject(new Error(`the ui never printed a URL:\n${buffer}`)),
      timeoutMs,
    );

    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      const match = buffer.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) {
        clearTimeout(timer);
        resolve(match[0]);
      }
    });
    child.stderr.on('data', (chunk) => {
      buffer += chunk;
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`xpost ui exited with ${code}:\n${buffer}`));
    });
  });
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => null);
  assert.equal(response.status, 200, `HTTP ${response.status}: ${JSON.stringify(payload)}`);
  return payload;
}

test('end to end: xpost ui drives scrape → draft over HTTP', async (t) => {
  const drafts = await makeDraftsDir(t);
  const mock = await startMockGemini(t, 'Scope the contract before quoting the price.');
  const nitter = await startMockNitter(t);
  const port = 46_000 + Math.floor(Math.random() * 1_000);

  const child = spawn(process.execPath, [CLI, 'ui', '--port', String(port)], {
    cwd: ROOT,
    env: {
      ...process.env,
      NO_COLOR: '1',
      XPOST_MANUAL: '',
      XPOST_BROWSER: 'none',
      XPOST_CLIPBOARD: 'none',
      XPOST_DRAFTS_DIR: drafts,
      NITTER_INSTANCES: nitter.baseUrl,
      GEMINI_API_KEY: 'test-key',
      GEMINI_BASE_URL: mock.baseUrl,
      GEMINI_MODEL: 'gemini-test',
      GEMINI_TIMEOUT_MS: '10000',
      X_API_KEY: '',
      X_API_KEY_SECRET: '',
      X_ACCESS_TOKEN: '',
      X_ACCESS_TOKEN_SECRET: '',
      TWEET_REPOS: '',
      TWEET_GIT_EMAIL: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => child.kill('SIGTERM'));

  const origin = await waitForServerUrl(child);

  const page = await fetch(`${origin}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Draft with AI/);

  const status = await (await fetch(`${origin}/api/status`)).json();
  assert.equal(status.gemini.model, 'gemini-test');
  assert.equal(status.maxChars, 280);

  const scoop = await postJson(`${origin}/api/scoop`, { topic: 'freelancing', limit: 5 });
  assert.equal(scoop.posts.length, 1);
  assert.equal(scoop.posts[0].url, 'https://x.com/ratecoach/status/3001');

  const draft = await postJson(`${origin}/api/draft`, {
    topic: 'freelancing',
    posts: scoop.posts,
  });
  assert.equal(draft.text, 'Scope the contract before quoting the price.');
  assert.equal(draft.model, 'gemini-test');

  const textCall = mock.seen.find((entry) => entry.url.includes('/models/gemini-test:generateContent'));
  assert.ok(textCall, 'expected the UI draft to call Gemini');
  assert.match(textCall.body.contents[0].parts[0].text, /Charge 3x what you think/);

  // Composer mode with no browser: the same publish wiring the Publish button uses,
  // minus actually opening anything or calling X.
  const published = await postJson(`${origin}/api/post`, {
    text: draft.text,
    mode: 'composer',
  });
  assert.equal(published.status, 'composer');
  assert.match(published.url, /^https:\/\/x\.com\/intent\/tweet\?text=/);

  const records = (await readdir(drafts)).filter((file) => file.endsWith('.json'));
  assert.equal(records.length, 1);
  const record = JSON.parse(await readFile(path.join(drafts, records[0]), 'utf8'));
  assert.equal(record.status, 'manual');
  assert.equal(record.text, draft.text);

  child.kill('SIGTERM');
});

