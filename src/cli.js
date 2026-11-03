#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readFile, mkdir, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { collectActivity, describeActivity } from './activity.js';
import { reviewDraft } from './approval.js';
import { HELP, parseArgs } from './args.js';
import { buildIntentUrl, openUrl } from './compose.js';
import {
  loadEnvFiles,
  missingGeminiConfig,
  missingXConfig,
  readConfig,
  requireGemini,
  requireX,
} from './config.js';
import { listDrafts, saveDraft, saveImage } from './drafts.js';
import { generateImage, generateText } from './gemini.js';
import { buildDraftPrompt, buildImagePrompt } from './prompts.js';
import { publishText } from './publish.js';
import { startUiServer } from './server.js';
import {
  DEFAULT_NITTER_INSTANCES,
  DEFAULT_SCOOP_LIMIT,
  DEFAULT_SCOOP_QUERY,
  latestScoop,
  saveScoop,
  scoopFromApi,
  scoopFromNitter,
} from './scoop.js';
import { countTweetLength, normalizeDraftText } from './tweet.js';
import {
  createLogger,
  color,
  formatBytes,
  formatLocalTimestamp,
  maskSecret,
  relativeTo,
  truncate,
  UserError,
} from './util.js';
import { createXClient, describeXError, verifyCredentials } from './x.js';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function isLoopbackHost(host) {
  return ['127.0.0.1', '::1', 'localhost'].includes(String(host).toLowerCase());
}

async function readPackageVersion() {
  try {
    const raw = await readFile(path.join(PROJECT_ROOT, 'package.json'), 'utf8');
    return JSON.parse(raw).version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

function retryLogger(logger) {
  return ({ attempt, delayMs, message }) => {
    logger.warn(`${message} — retrying in ${(delayMs / 1000).toFixed(1)}s (attempt ${attempt})…`);
  };
}

async function draftText({ config, model, activity, topic, scoop, previousText, maxChars, logger }) {
  const { system, prompt } = buildDraftPrompt({
    activity,
    topic,
    scoop,
    previousText,
    maxChars,
  });

  const result = await generateText({
    apiKey: config.gemini.apiKey,
    model,
    baseUrl: config.gemini.baseUrl,
    timeoutMs: config.gemini.timeoutMs,
    system,
    prompt,
    onRetry: retryLogger(logger),
  });

  const normalized = normalizeDraftText(result.text);
  if (!normalized) {
    throw new UserError('Gemini returned an empty draft after cleanup. Try again or pass --text.');
  }
  return normalized;
}

/** Run the configured scoop backend: nitter = free RSS, api = paid search. */
async function fetchScoop({ query, limit, source, config, logger }) {
  if (source === 'api') {
    requireX(config);
    const posts = await scoopFromApi({
      client: createXClient(config),
      query,
      limit,
      onCost: (estimate, count) =>
        logger.warn(
          `Official X search: up to ${count} returned posts ≈ $${estimate} of API credits (pay-per-use).`,
        ),
    });
    return { posts };
  }

  const instances = config.scoop.instances.length
    ? config.scoop.instances
    : DEFAULT_NITTER_INSTANCES;
  const result = await scoopFromNitter({ query, limit, instances });
  return { posts: result.posts, host: result.host };
}

async function editDraftText(currentText, { interactive, rl, logger }) {
  const editor = process.env.VISUAL || process.env.EDITOR;

  if (editor && interactive) {
    const file = path.join(os.tmpdir(), `xpost-edit-${Date.now()}.txt`);
    await writeFile(file, currentText, 'utf8');
    logger.step(`Opening ${editor} — save and close the editor to continue…`);

    // Avoid shell quoting entirely for a plain editor name; only use the shell
    // when EDITOR contains its own arguments (for example "code --wait").
    const hasArguments = /\s/.test(editor.trim());
    const result = hasArguments
      ? spawnSync(`${editor.trim()} "${file}"`, { stdio: 'inherit', shell: true })
      : spawnSync(editor, [file], { stdio: 'inherit' });
    if (result.error) logger.warn(`Could not open editor: ${result.error.message}`);

    let edited = '';
    try {
      edited = await readFile(file, 'utf8');
    } finally {
      await unlink(file).catch(() => {});
    }
    return edited;
  }

  const answer = await rl.question('New text (single line; use \\n for a line break): ');
  return answer.replace(/\\n/g, '\n');
}

function formatSource(source) {
  if (!source) return '';
  if (source.kind === 'topic') return `topic: ${source.topic}`;
  if (source.kind === 'manual') return 'manual text';
  if (source.kind === 'activity') {
    return `${source.commits} commits, ${source.filesChanged} files (+${source.insertions}/-${source.deletions}) since ${source.since}`;
  }
  return '';
}

async function commandDraft({ flags, config, logger, cwd }) {
  const interactive = Boolean(process.stdin.isTTY);
  const dryRun = Boolean(flags.dryRun);
  const wantImage = Boolean(flags.image);

  const manual = Boolean(flags.manual) || config.xpost.manual;
  const publishMode = manual ? 'composer' : 'auto';

  if (!dryRun && publishMode === 'auto') requireX(config);
  if (!flags.text) requireGemini(config);
  if (wantImage) requireGemini(config);

  let text = flags.text ? normalizeDraftText(flags.text) : '';
  if (flags.text !== undefined && !text) {
    throw new UserError('--text cannot be empty.');
  }

  let activity = null;
  let source = null;

  if (!text) {
    if (flags.topic) {
      source = { kind: 'topic', topic: flags.topic };
      logger.detail(`Topic mode: ${flags.topic}`);
    } else {
      const repos = flags.repos.length ? flags.repos : config.repos;
      logger.step('Reading git activity…');
      activity = await collectActivity({
        repos,
        cwd,
        since: flags.since ?? config.since,
        email: config.gitEmail,
      });
      logger.info(`  ${describeActivity(activity)}`);
      for (const skipped of activity.skipped) {
        logger.warn(`Skipped ${skipped.path}: ${skipped.reason}`);
      }
      for (const repo of activity.repos) {
        if (!repo.email) {
          logger.warn(
            `No git author email in ${repo.name}; including all commits. Set TWEET_GIT_EMAIL to filter.`,
          );
        }
      }
      source = {
        kind: 'activity',
        commits: activity.totals.commits,
        filesChanged: activity.totals.filesChanged,
        insertions: activity.totals.insertions,
        deletions: activity.totals.deletions,
        since: activity.since,
        repos: activity.repos.map((repo) => ({
          name: repo.name,
          branch: repo.branch,
          email: repo.email,
        })),
      };
    }
  } else {
    source = { kind: 'manual' };
  }

  let scoop = null;
  if (flags.scoop) {
    const query = (flags.topic ?? DEFAULT_SCOOP_QUERY).trim() || DEFAULT_SCOOP_QUERY;
    const source = flags.source ?? config.scoop.source;
    logger.step(`Scooping recent "${query}" posts (${source}) for inspiration…`);
    try {
      const { posts } = await fetchScoop({ query, limit: 8, source, config, logger });
      scoop = { query, source, posts };
      logger.info(`  ${posts.length} post${posts.length === 1 ? '' : 's'} found for context`);
    } catch (error) {
      logger.warn(`Scoop failed: ${error.message}`);
      const stale = await latestScoop(config.draftsDir).catch(() => null);
      if (stale?.posts?.length) {
        scoop = {
          query: stale.query ?? query,
          source: stale.source ?? 'saved',
          posts: stale.posts,
        };
        logger.info(`  Using the saved scoop from ${stale.createdAt} (${stale.posts.length} posts).`);
      } else {
        logger.detail('  Continuing without inspiration.');
      }
    }
  }

  const model = flags.text ? null : flags.model ?? config.gemini.model;
  if (!text) {
    logger.step(`Drafting with ${model}…`);
    text = await draftText({
      config,
      model,
      activity,
      topic: flags.topic,
      scoop,
      maxChars: config.maxChars,
      logger,
    });
  }

  const imageModel = flags.imageModel ?? config.gemini.imageModel;
  let imagePath = null;

  const makeImage = async (draft) => {
    const image = await generateImage({
      apiKey: config.gemini.apiKey,
      model: imageModel,
      baseUrl: config.gemini.baseUrl,
      prompt: buildImagePrompt(draft),
      timeoutMs: Math.max(config.gemini.timeoutMs, 90_000),
      onRetry: retryLogger(logger),
      onFallback: () =>
        logger.warn('/interactions is unavailable for this key; using generateContent for the image.'),
    });

    const file = await saveImage({
      draftsDir: config.draftsDir,
      buffer: image.buffer,
      mimeType: image.mimeType,
    });
    logger.detail(`  ${formatBytes(image.buffer.length)} ${image.mimeType} via ${image.model}`);
    return file;
  };

  if (wantImage) {
    logger.step(`Generating image with ${imageModel}…`);
    try {
      imagePath = await makeImage(text);
      logger.success(`Image ready: ${relativeTo(cwd, imagePath)}`);
    } catch (error) {
      logger.error(`Image generation failed: ${error.message}`);
      logger.detail('Continuing without an image — press i during review to retry.');
    }
  }

  const persist = ({ status, text: finalText, imagePath: finalImage, tweet, url, error }) =>
    saveDraft({
      draftsDir: config.draftsDir,
      text: finalText,
      imagePath: finalImage,
      status,
      source,
      model,
      tweetId: tweet?.id ?? null,
      url: tweet?.url ?? url ?? null,
      error: error ?? null,
    });

  const post = async ({ text: finalText, imagePath: finalImage }) => {
    if (dryRun) {
      throw new UserError('Internal error: attempted to call X during a dry run.');
    }

    const result = await publishText({
      text: finalText,
      imagePath: finalImage,
      mode: publishMode,
      config,
      logger,
      save: persist,
    });

    // The composer path saves its own record; API posts are saved here.
    let file = result.file ?? null;
    if (!file) {
      const status = result.status === 'posted' ? 'posted' : 'manual';
      try {
        const saved = await persist({
          status,
          text: finalText,
          imagePath: finalImage,
          tweet: { id: result.tweetId, url: result.url },
          url: result.url,
        });
        file = saved.file;
      } catch (error) {
        logger.warn(`Posted, but could not save the local record: ${error.message}`);
      }
    }

    return {
      tweet: { id: result.tweetId, url: result.url },
      file,
      mode: result.mode,
      needsClick: Boolean(result.needsClick),
      manual: result.status === 'composer',
    };
  };

  if (source) logger.detail(`Source: ${formatSource(source)}`);
  if (scoop) logger.detail(`Inspiration: ${scoop.posts.length} scraped posts (${scoop.source})`);
  if (dryRun) logger.detail(`Dry run — X credentials are not required and nothing will be posted.`);
  if (!dryRun && publishMode === 'composer') {
    logger.detail('Composer mode: X’s composer opens; the X API is not called.');
  }
  let rl;
  try {
    rl = createInterface({ input: process.stdin, output: process.stdout });
    const result = await reviewDraft({
      text,
      imagePath,
      maxChars: config.maxChars,
      dryRun,
      manual: publishMode === 'composer',
      interactive,
      rl,
      logger,
      regenerate: async (previousText) => {
        const model_ = flags.model ?? config.gemini.model;
        logger.step(`Regenerating with ${model_}…`);
        return draftText({
          config,
          model: model_,
          activity,
          topic: flags.topic,
          scoop,
          previousText,
          maxChars: config.maxChars,
          logger,
        });
      },
      makeImage,
      editText: (currentText) => editDraftText(currentText, { interactive, rl, logger }),
      save: persist,
      post,
    });

    return result.action === 'refused' ? 2 : 0;
  } finally {
    rl?.close();
  }
}

async function commandScoop({ flags, config, logger, cwd }) {
  const query = (flags.topic ?? DEFAULT_SCOOP_QUERY).trim() || DEFAULT_SCOOP_QUERY;
  const limit = Math.min(100, flags.limit ?? DEFAULT_SCOOP_LIMIT);
  const source = flags.source ?? config.scoop.source;

  logger.step(
    `Scooping "${query}" from ${source === 'api' ? 'the official X API' : 'free Nitter feeds'}…`,
  );

  const { posts } = await fetchScoop({ query, limit, source, config, logger });
  const { file } = await saveScoop({ draftsDir: config.draftsDir, query, source, posts });

  logger.blank();
  for (const [index, post] of posts.entries()) {
    const label = post.author ? `${post.author} · ` : '';
    const line = `${label}${String(post.text).replace(/\s+/g, ' ').trim()}`;
    logger.info(`${String(index + 1).padStart(2)}. ${truncate(line, 110)}`);
    if (post.url) logger.detail(`    ${post.url}`);
  }

  logger.blank();
  logger.success(
    `${posts.length} post${posts.length === 1 ? '' : 's'} saved: ${relativeTo(cwd, file)}`,
  );
  logger.detail(`Draft with this context: xpost --scoop --topic "${query}"`);
  logger.detail('Scooped posts are background only — drafts are always written fresh.');
  return 0;
}

async function commandWhoami({ config, logger }) {
  requireX(config);
  const client = createXClient(config);

  let me;
  try {
    me = await verifyCredentials(client);
  } catch (error) {
    throw new UserError(describeXError(error));
  }

  logger.success(`Authenticated with X as @${me.username}${me.name ? ` (${me.name})` : ''}`);
  logger.detail(`  user id: ${me.id}`);
  return 0;
}

async function commandHistory({ flags, config, logger }) {
  const limit = flags.limit ?? 10;
  const drafts = await listDrafts(config.draftsDir, limit);

  if (!drafts.length) {
    logger.info(`No drafts yet in ${config.draftsDir}. Run \`xpost\` to create one.`);
    return 0;
  }

  const statusColors = {
    posted: color.green,
    manual: color.green,
    'dry-run': color.cyan,
    failed: color.red,
    saved: color.yellow,
    draft: color.dim,
  };

  for (const draft of drafts) {
    const when = formatLocalTimestamp(draft.createdAt);
    const paint = statusColors[draft.status] ?? color.dim;
    const length = countTweetLength(draft.text ?? '');
    const extras = [
      `${String(length).padStart(3)} chars`,
      draft.image ? 'image' : null,
    ]
      .filter(Boolean)
      .join('  ');

    logger.info(`${when}  ${paint(String(draft.status).padEnd(8))}  ${extras}`);
    logger.detail(`  ${truncate((draft.text ?? '').split('\n')[0], 88)}`);
    if (draft.url) logger.detail(`  ${draft.url}`);
    if (draft.error) logger.detail(`  ${String(draft.error).split('\n')[0]}`);
  }

  logger.blank();
  logger.detail(`${drafts.length} shown — ${config.draftsDir}`);
  return 0;
}

async function commandUi({ flags, config, logger, cwd }) {
  let accountCache = { done: false, account: null, error: null };
  const loadAccount = async () => {
    if (accountCache.done) return accountCache;
    accountCache = { done: true, account: null, error: null };

    const missing = missingXConfig(config);
    if (missing.length) {
      accountCache.error = `no X credentials (${missing.join(', ')})`;
      return accountCache;
    }
    try {
      accountCache.account = await verifyCredentials(createXClient(config));
    } catch (error) {
      accountCache.error = String(describeXError(error)).split('\n')[0];
    }
    return accountCache;
  };

  const uiHost = config.xpost.uiHost;
  const remoteUi = !isLoopbackHost(uiHost);
  const auth = {
    required: remoteUi || Boolean(config.xpost.uiPassword),
    password: config.xpost.uiPassword,
    secret: config.xpost.uiSecret,
  };

  const deps = {
    status: async () => {
      const { account, error } = await loadAccount();
      return {
        account: account ? { username: account.username, name: account.name ?? null } : null,
        accountError: error,
        posting: {
          manual: config.xpost.manual,
        },
        gemini: { model: config.gemini.model, ready: Boolean(config.gemini.apiKey) },
        x: { ready: missingXConfig(config).length === 0 },
        scoop: {
          source: config.scoop.source,
          instances: config.scoop.instances.length || DEFAULT_NITTER_INSTANCES.length,
        },
      };
    },

    scoop: async ({ topic, limit, source }) => {
      const query = topic || DEFAULT_SCOOP_QUERY;
      const backend = source ?? config.scoop.source;
      const { posts, host } = await fetchScoop({
        query,
        limit,
        source: backend,
        config,
        logger,
      });
      const { record, file } = await saveScoop({
        draftsDir: config.draftsDir,
        query,
        source: backend,
        posts,
      });
      return {
        query,
        source: backend,
        host: host ?? null,
        posts,
        scoopId: record.id,
        saved: relativeTo(cwd, file),
      };
    },

    draft: async ({ topic, posts, previousText }) => {
      requireGemini(config);
      const query = topic || DEFAULT_SCOOP_QUERY;
      const scoop = posts?.length ? { query, source: 'ui', posts } : null;
      const text = await draftText({
        config,
        model: config.gemini.model,
        activity: null,
        topic,
        scoop,
        previousText,
        maxChars: config.maxChars,
        logger,
      });
      const length = countTweetLength(text);
      return {
        text,
        model: config.gemini.model,
        length,
        remaining: config.maxChars - length,
      };
    },

    publish: async ({ text, mode }) => {
      const result = await publishText({
        text,
        mode: mode === 'auto' && config.xpost.manual ? 'composer' : mode,
        config,
        logger,
        compose: async ({ text: composerText, imagePath, save: persist }) => {
          const url = buildIntentUrl(composerText);
          const saved = await persist?.({
            status: 'manual',
            text: composerText,
            imagePath,
            url,
          });
          return { url, file: saved?.file ?? null };
        },
        save: async ({ status, text: savedText, url }) => {
          const saved = await saveDraft({
            draftsDir: config.draftsDir,
            text: savedText,
            status,
            url: url ?? null,
          });
          return { file: relativeTo(cwd, saved.file) };
        },
      });

      if (result.file) return result;

      const saved = await saveDraft({
        draftsDir: config.draftsDir,
        text,
        status: result.status === 'posted' ? 'posted' : 'manual',
        url: result.url ?? null,
        tweetId: result.tweetId ?? null,
        error: null,
      });

      return { ...result, file: relativeTo(cwd, saved.file) };
    },

    save: async ({ text }) => {
      const saved = await saveDraft({ draftsDir: config.draftsDir, text, status: 'saved' });
      return { file: relativeTo(cwd, saved.file) };
    },

    history: async ({ limit }) => listDrafts(config.draftsDir, limit),

  };

  const ui = await startUiServer({
    deps,
    publicDir: path.join(PROJECT_ROOT, 'public'),
    port: flags.port ?? config.xpost.uiPort,
    version: await readPackageVersion(),
    maxChars: config.maxChars,
    logger,
    host: uiHost,
    auth,
  });

  logger.blank();
  logger.success(`xpost UI running at ${ui.url}`);
  logger.detail('  Research → draft → review → publish. API writes use X credits.');
  logger.detail('  Press Ctrl+C to stop.');
  if (remoteUi) {
    logger.detail('  Network access is password-protected. Open the public URL shown by your host provider.');
  }

  if (!remoteUi && config.xpost.browser !== 'none') openUrl(ui.url);

  await new Promise((resolve) => {
    const stop = () => {
      logger.blank();
      logger.info('UI stopped.');
      ui.close().finally(resolve);
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });

  return 0;
}

async function commandDoctor({ config, logger, envFiles, cwd }) {
  logger.info(color.bold('xpost doctor'));
  logger.blank();

  let failures = 0;
  const check = async (label, fn) => {
    try {
      const detail = await fn();
      logger.success(`${label}${detail ? ` — ${detail}` : ''}`);
    } catch (error) {
      failures += 1;
      logger.error(`${label} — ${error.message}`);
    }
  };

  await check('Node runtime', async () => {
    const major = Number(process.versions.node.split('.')[0]);
    if (major < 20) throw new Error(`Node ${process.versions.node} found; Node 20+ is required`);
    return `v${process.versions.node}`;
  });

  await check('git', async () => {
    const result = spawnSync('git', ['--version'], { encoding: 'utf8' });
    if (result.error) throw new Error('git is not on PATH');
    return result.stdout.trim();
  });

  await check('Environment file', async () => {
    if (!envFiles.length) {
      return 'no .env found — using shell environment only';
    }
    return envFiles.map((file) => relativeTo(cwd, file)).join(', ');
  });

  const geminiMissing = missingGeminiConfig(config);
  if (geminiMissing.length) {
    failures += 1;
    logger.error(`Gemini credentials — missing ${geminiMissing.join(', ')}`);
  } else {
    logger.detail(`  GEMINI_API_KEY ${maskSecret(config.gemini.apiKey)}`);
    await check('Gemini text generation', async () => {
      const result = await generateText({
        apiKey: config.gemini.apiKey,
        model: config.gemini.model,
        baseUrl: config.gemini.baseUrl,
        timeoutMs: config.gemini.timeoutMs,
        system: 'You are a health check. Reply with exactly: OK',
        prompt: 'Reply with exactly: OK',
        maxOutputTokens: 16,
        temperature: 0,
        maxAttempts: 2,
      });
      return `${result.model} responded`;
    });
    logger.detail(
      `  Image model: ${config.gemini.imageModel} (not generated — image calls are paid)`,
    );
  }

  const xMissing = missingXConfig(config);
  if (xMissing.length) {
    if (config.xpost.manual) {
      logger.warn(`X credentials — missing ${xMissing.join(', ')} (not needed in manual mode)`);
    } else {
      failures += 1;
      logger.error(`X credentials — missing ${xMissing.join(', ')}`);
    }
  } else {
    await check('X authentication', async () => {
      const me = await verifyCredentials(createXClient(config));
      return `@${me.username}`;
    });
  }

  logger.detail(
    `  Posting mode: ${
      config.xpost.manual
        ? 'X composer, you review and press Post'
        : 'official X API, manual composer fallback on credit errors'
    }`,
  );
  logger.detail(`  Web UI: xpost ui → http://127.0.0.1:${config.xpost.uiPort}`);
  logger.detail(
    `  Scoop source: ${config.scoop.source}${config.scoop.instances.length ? ` (${config.scoop.instances.length} custom Nitter instances)` : ''}`,
  );

  await check('Drafts folder', async () => {
    await mkdir(config.draftsDir, { recursive: true });
    const probe = path.join(config.draftsDir, `.write-test-${Date.now()}`);
    await writeFile(probe, 'ok');
    await unlink(probe);
    return config.draftsDir;
  });

  await check('Git activity', async () => {
    const repos = config.repos.length ? config.repos : [cwd];
    const activity = await collectActivity({
      repos,
      cwd,
      since: config.since,
      email: config.gitEmail,
    });
    for (const skipped of activity.skipped) {
      logger.warn(`  skipped ${skipped.path}: ${skipped.reason}`);
    }
    return describeActivity(activity);
  });

  logger.blank();
  if (failures) {
    logger.error(`${failures} check${failures === 1 ? '' : 's'} failed. See SETUP.md.`);
    return 1;
  }

  logger.success('All checks passed. Run `npm start` to draft your next post.');
  return 0;
}

export async function main(argv = process.argv.slice(2), { cwd = process.cwd() } = {}) {
  const logger = createLogger();

  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    logger.error(error.message);
    logger.detail('Run `xpost --help` for usage.');
    return error.exitCode ?? 2;
  }

  if (parsed.command === 'help') {
    logger.info(HELP);
    return 0;
  }

  if (parsed.command === 'version') {
    logger.info(await readPackageVersion());
    return 0;
  }

  const envFiles = loadEnvFiles({ cwd, projectRoot: PROJECT_ROOT });
  const config = readConfig(process.env, { projectRoot: PROJECT_ROOT, cwd });

  try {
    switch (parsed.command) {
      case 'doctor':
        return await commandDoctor({ config, logger, envFiles, cwd });
      case 'scoop':
        return await commandScoop({ flags: parsed.flags, config, logger, cwd });
      case 'ui':
        return await commandUi({ flags: parsed.flags, config, logger, cwd });
      case 'whoami':
        return await commandWhoami({ config, logger });
      case 'history':
        return await commandHistory({ flags: parsed.flags, config, logger });
      case 'draft':
      default:
        return await commandDraft({ flags: parsed.flags, config, logger, cwd });
    }
  } catch (error) {
    if (error instanceof UserError) {
      logger.error(error.message);
      if (error.hint) logger.detail(error.hint);
      return error.exitCode;
    }
    logger.error(`Unexpected error: ${error.message}`);
    if (process.env.DEBUG) console.error(error.stack);
    return 1;
  }
}

const isEntryPoint =
  Boolean(process.argv[1]) &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isEntryPoint) {
  process.once('SIGINT', () => {
    process.stdout.write('\nCancelled. Nothing was posted.\n');
    process.exit(130);
  });

  main().then((code) => {
    process.exitCode = code;
  });
}
