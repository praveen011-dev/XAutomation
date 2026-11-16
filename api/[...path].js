import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildIntentUrl } from '../src/compose.js';
import { readConfig, requireGemini } from '../src/config.js';
import { buildDraftPrompt } from '../src/prompts.js';
import { publishText } from '../src/publish.js';
import { createHandler } from '../src/server.js';
import { scoopFromNitter, DEFAULT_NITTER_INSTANCES } from '../src/scoop.js';
import { countTweetLength, normalizeDraftText } from '../src/tweet.js';
import { UserError } from '../src/util.js';
import { generateText } from '../src/gemini.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = readConfig(process.env, { projectRoot: root, cwd: root });
const password = config.xpost.uiPassword;
const secret = config.xpost.uiSecret;

if (password.length < 12 || secret.length < 32) {
  throw new Error('Set XPOST_UI_PASSWORD (12+ characters) and XPOST_UI_SECRET (32+ characters) in Vercel.');
}

const noOpLogger = {
  info() {}, step() {}, success() {}, warn() {}, detail() {}, error() {}, blank() {},
};

const deps = {
  status: async () => ({
    account: null,
    accountError: 'Posts are prepared in the X composer for your review.',
    posting: { manual: true },
    gemini: { model: config.gemini.model, ready: Boolean(config.gemini.apiKey) },
    x: { ready: false },
    scoop: { source: 'nitter', instances: DEFAULT_NITTER_INSTANCES.length },
  }),
  scoop: async ({ topic, limit }) => {
    const result = await scoopFromNitter({
      query: topic,
      limit,
      instances: config.scoop.instances.length ? config.scoop.instances : DEFAULT_NITTER_INSTANCES,
    });
    return { query: topic, source: 'nitter', host: result.host, posts: result.posts, saved: null };
  },
  draft: async ({ topic, posts, previousText }) => {
    requireGemini(config);
    const scoop = posts?.length ? { query: topic, posts } : null;
    const { system, prompt } = buildDraftPrompt({
      topic,
      scoop,
      previousText,
      maxChars: config.maxChars,
    });
    const result = await generateText({
      apiKey: config.gemini.apiKey,
      model: config.gemini.model,
      baseUrl: config.gemini.baseUrl,
      timeoutMs: Math.min(config.gemini.timeoutMs, 45_000),
      maxAttempts: 1,
      system,
      prompt,
      maxOutputTokens: 512,
    });
    const text = normalizeDraftText(result.text);
    if (!text) throw new UserError('Gemini returned an empty draft. Please try again.');
    const length = countTweetLength(text);
    return { text, model: result.model, length, remaining: config.maxChars - length };
  },
  publish: async ({ text, mode }) => publishText({
    text,
    mode: config.xpost.manual ? 'composer' : mode,
    config,
    logger: noOpLogger,
    compose: async ({ text: composerText }) => ({ url: buildIntentUrl(composerText) }),
  }),
  save: async () => ({ file: 'Saved in this browser' }),
  history: async () => [],
};

const handler = createHandler({
  deps,
  publicDir: path.join(root, 'public'),
  version: '1.0.0',
  maxChars: config.maxChars,
  logger: noOpLogger,
  auth: { required: true, password, secret },
});

export default handler;
