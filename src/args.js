import { UsageError } from './util.js';

export const COMMANDS = [
  'draft',
  'scoop',
  'ui',
  'doctor',
  'whoami',
  'history',
  'help',
  'version',
];

export const HELP = `xpost — draft, approve, and post a daily tweet

Usage
  xpost [options]                 Draft a tweet from today's git activity
  xpost scoop [--topic T]         Scrape recent posts on a topic (default: freelancing)
  xpost ui                        Open the secure web app (draft and publish)
  xpost doctor                    Check Node, credentials, git, and drafts folder
  xpost whoami                    Verify X credentials and show the account
  xpost history [--limit N]       Show saved drafts and posts
  xpost --version                 Print the version
  xpost --help                    Show this help

Draft options
  --topic <text>       Write about a topic instead of your commits
  --text <text>        Use your own text (skips AI drafting, still asks approval)
  --repo <paths>       Comma-separated repos to scan (default: TWEET_REPOS or cwd)
  --since <date>       Git --since value (default: midnight)
  --image              Also generate an AI image and attach it
  --scoop              Scrape recent X posts first and use them as context for the draft
  --manual             Open X's composer; you review and press Post
  --source <s>         Scoop backend: nitter (third-party feeds) or api (official X API)
  --port <n>           Port for the ui command (default: 4321, or XPOST_UI_PORT)
  --dry-run, -n        Never call the X API; save the approved draft instead
  --model <id>         Gemini text model (default: gemini-3.8-flash)
  --image-model <id>   Gemini image model (default: gemini-nano-banana-2.1)

Review keys
  p  post (or finish a dry run)     e  edit the text
  r  regenerate the text            i  generate / replace the image
  s  save without posting           q  quit without posting

Examples
  npm start                          # draft, review, post
  npm run dry                        # same, but never posts
  npm start -- --topic "shipping on Fridays" --image
  npm start -- --repo ../api,../web --since "24 hours ago"
  xpost scoop --topic freelancing --limit 15
  xpost --topic freelancing --scoop          # draft shaped by scraped posts
  xpost --manual                             # prepare a composer link and review in X
  xpost ui                                   # http://127.0.0.1:4321
`;

const VALUE_FLAGS = new Map([
  ['--text', 'text'],
  ['--topic', 'topic'],
  ['--repo', 'repo'],
  ['--since', 'since'],
  ['--model', 'model'],
  ['--image-model', 'imageModel'],
  ['--limit', 'limit'],
  ['--source', 'source'],
  ['--port', 'port'],
]);

const BOOLEAN_FLAGS = new Map([
  ['--dry-run', 'dryRun'],
  ['--image', 'image'],
  ['--scoop', 'scoop'],
  ['--manual', 'manual'],
  ['--help', 'help'],
  ['--version', 'version'],
]);

const SHORT_FLAGS = new Map([
  ['-n', 'dryRun'],
  ['-i', 'image'],
  ['-h', 'help'],
  ['-v', 'version'],
]);

export function parseArgs(argv) {
  const flags = {
    dryRun: false,
    image: false,
    scoop: false,
    manual: false,
    port: undefined,
    source: undefined,
    help: false,
    version: false,
    repos: [],
    text: undefined,
    topic: undefined,
    since: undefined,
    model: undefined,
    imageModel: undefined,
    limit: undefined,
  };
  const positionals = [];
  let literal = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (literal) {
      positionals.push(arg);
      continue;
    }
    if (arg === '--') {
      literal = true;
      continue;
    }

    if (arg.startsWith('--')) {
      const equals = arg.indexOf('=');
      const name = equals === -1 ? arg : arg.slice(0, equals);
      const inlineValue = equals === -1 ? undefined : arg.slice(equals + 1);

      if (BOOLEAN_FLAGS.has(name)) {
        if (inlineValue !== undefined) {
          throw new UsageError(`${name} does not take a value`);
        }
        flags[BOOLEAN_FLAGS.get(name)] = true;
        continue;
      }

      if (VALUE_FLAGS.has(name)) {
        const value = inlineValue !== undefined ? inlineValue : argv[++index];
        if (value === undefined) {
          throw new UsageError(`${name} needs a value`);
        }
        const key = VALUE_FLAGS.get(name);
        if (key === 'repo') {
          const paths = value.split(',').map((entry) => entry.trim()).filter(Boolean);
          if (!paths.length) throw new UsageError('--repo needs at least one path');
          flags.repos.push(...paths);
        } else {
          flags[key] = value;
        }
        continue;
      }

      throw new UsageError(`Unknown option: ${name}`);
    }

    if (arg.startsWith('-') && arg.length > 1) {
      if (!SHORT_FLAGS.has(arg)) throw new UsageError(`Unknown option: ${arg}`);
      flags[SHORT_FLAGS.get(arg)] = true;
      continue;
    }

    positionals.push(arg);
  }

  let command = positionals[0] ?? 'draft';
  let extra = positionals.slice(1);

  // `--topic website development` (an unquoted multi-word topic) should work:
  // when no command was typed, every leftover word belongs to the topic.
  if (!COMMANDS.includes(command)) {
    if (flags.topic !== undefined) {
      flags.topic = [flags.topic, ...positionals].join(' ');
      command = 'draft';
      extra = [];
    } else {
      throw new UsageError(
        `Unknown command: ${command}\nCommands: ${COMMANDS.join(', ')}`,
      );
    }
  }

  if (extra.length) {
    if (flags.topic !== undefined) {
      flags.topic = [flags.topic, ...extra].join(' ');
    } else {
      throw new UsageError(`Unexpected argument: ${extra[0]}`);
    }
  }
  if (flags.topic !== undefined) {
    flags.topic = flags.topic.replace(/\s+/g, ' ').trim();
  }

  if (flags.help) command = 'help';
  if (flags.version) command = 'version';

  if (flags.text !== undefined && flags.topic !== undefined) {
    throw new UsageError('Use either --text or --topic, not both');
  }
  if (flags.port !== undefined) {
    const parsed = Number.parseInt(flags.port, 10);
    if (!Number.isFinite(parsed) || parsed < 1024 || parsed > 65_535) {
      throw new UsageError('--port must be a number between 1024 and 65535');
    }
    flags.port = parsed;
  }

  if (flags.limit !== undefined) {
    const parsed = Number.parseInt(flags.limit, 10);
    if (!Number.isFinite(parsed) || parsed < 1) {
      throw new UsageError('--limit must be a positive number');
    }
    flags.limit = parsed;
  }

  if (flags.source !== undefined) {
    if (!['nitter', 'api'].includes(flags.source)) {
      throw new UsageError('--source must be nitter or api');
    }
    if (command !== 'scoop' && !flags.scoop) {
      throw new UsageError('--source only applies to `xpost scoop` or `--scoop`');
    }
  }
  if (flags.scoop && flags.text !== undefined) {
    throw new UsageError('--scoop feeds the AI draft, so it cannot be combined with --text');
  }

  return { command, flags };
}
