import assert from 'node:assert/strict';
import test from 'node:test';

import { parseArgs } from '../src/args.js';
import { UsageError } from '../src/util.js';

test('defaults to the draft command', () => {
  const { command, flags } = parseArgs([]);
  assert.equal(command, 'draft');
  assert.equal(flags.dryRun, false);
  assert.deepEqual(flags.repos, []);
});

test('parses commands and flags', () => {
  const { command, flags } = parseArgs([
    'draft',
    '--dry-run',
    '--image',
    '--text',
    'hello there',
    '--model',
    'gemini-test',
    '--since=24 hours ago',
  ]);
  assert.equal(command, 'draft');
  assert.equal(flags.dryRun, true);
  assert.equal(flags.image, true);
  assert.equal(flags.text, 'hello there');
  assert.equal(flags.model, 'gemini-test');
  assert.equal(flags.since, '24 hours ago');
});

test('collects repeated and comma-separated repos', () => {
  const { flags } = parseArgs(['--repo', 'a,b', '--repo', 'c']);
  assert.deepEqual(flags.repos, ['a', 'b', 'c']);
});

test('supports short flags and command positionals', () => {
  assert.equal(parseArgs(['-n']).flags.dryRun, true);
  assert.equal(parseArgs(['-i']).flags.image, true);
  assert.equal(parseArgs(['history', '--limit', '5']).command, 'history');
  assert.equal(parseArgs(['history', '--limit', '5']).flags.limit, 5);
  assert.equal(parseArgs(['-h']).command, 'help');
  assert.equal(parseArgs(['-v']).command, 'version');
});

test('rejects bad input with actionable errors', () => {
  assert.throws(() => parseArgs(['--nope']), UsageError);
  assert.throws(() => parseArgs(['--text']), /needs a value/);
  assert.throws(() => parseArgs(['--topic', 'a', '--text', 'b']), /either --text or --topic/);
  assert.throws(() => parseArgs(['history', '--limit', '0']), /positive number/);
  assert.throws(() => parseArgs(['publish']), /Unknown command/);
  assert.throws(() => parseArgs(['doctor', 'extra']), /Unexpected argument/);
});

test('parses the scoop command with topic, limit and source', () => {
  const { command, flags } = parseArgs([
    'scoop',
    '--topic',
    'freelancing',
    '--limit',
    '15',
    '--source',
    'api',
  ]);
  assert.equal(command, 'scoop');
  assert.equal(flags.topic, 'freelancing');
  assert.equal(flags.limit, 15);
  assert.equal(flags.source, 'api');
});

test('parses the manual and scoop publishing flags', () => {
  const { flags } = parseArgs(['--manual', '--scoop', '--topic', 'freelancing']);
  assert.equal(flags.manual, true);
  assert.equal(flags.scoop, true);
  assert.equal(flags.topic, 'freelancing');
});

test('joins an unquoted multi-word topic instead of failing', () => {
  const scoop = parseArgs(['scoop', '--topic', 'website', 'development']);
  assert.equal(scoop.command, 'scoop');
  assert.equal(scoop.flags.topic, 'website development');

  const draft = parseArgs(['--topic', 'web', 'development', 'basics']);
  assert.equal(draft.flags.topic, 'web development basics');
});

test('parses the UI command and validates its port', () => {
  const ui = parseArgs(['ui', '--port', '4400']);
  assert.equal(ui.command, 'ui');
  assert.equal(ui.flags.port, 4400);

  assert.throws(() => parseArgs(['login']), /Unknown command/);
  assert.throws(() => parseArgs(['--autopost']), /Unknown option/);
  assert.throws(() => parseArgs(['ui', '--port', '80']), /between 1024 and 65535/);
  assert.throws(() => parseArgs(['ui', '--port', 'abc']), /between 1024 and 65535/);
});

test('rejects invalid scoop usage', () => {
  assert.throws(() => parseArgs(['scoop', '--source', 'reddit']), /--source must be nitter or api/);
  assert.throws(() => parseArgs(['--source', 'api']), /only applies to/);
  assert.throws(() => parseArgs(['--scoop', '--text', 'hi']), /cannot be combined with --text/);
});
