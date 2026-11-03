import assert from 'node:assert/strict';
import test from 'node:test';

import {
  countTweetLength,
  normalizeDraftText,
  validateTweet,
} from '../src/tweet.js';

test('counts plain latin text by character', () => {
  assert.equal(countTweetLength('hello world'), 11);
  assert.equal(countTweetLength(''), 0);
});

test('counts every link as 23 characters', () => {
  assert.equal(countTweetLength('https://example.com/a/very/long/path?x=1'), 23);
  assert.equal(countTweetLength('read https://example.com now'), 5 + 23 + 4);
});

test('weights CJK and emoji as two', () => {
  assert.equal(countTweetLength('日本'), 4);
  assert.equal(countTweetLength('🚀'), 2);
});

test('rejects empty and over-limit drafts', () => {
  const empty = validateTweet('   ', 280);
  assert.equal(empty.ok, false);
  assert.match(empty.problems.join(' '), /empty/);

  const long = validateTweet('a'.repeat(281), 280);
  assert.equal(long.ok, false);
  assert.match(long.problems.join(' '), /Too long: 281\/280/);

  const ok = validateTweet('a'.repeat(280), 280);
  assert.equal(ok.ok, true);
  assert.equal(ok.remaining, 0);
});

test('normalizes fences, labels, quote wrappers, and bold markdown', () => {
  assert.equal(normalizeDraftText('```\nHello **world**\n```'), 'Hello world');
  assert.equal(normalizeDraftText('Tweet: shipped a fix'), 'shipped a fix');
  assert.equal(normalizeDraftText('"shipped a fix"'), 'shipped a fix');
  assert.equal(normalizeDraftText('“smart quotes”'), 'smart quotes');
  assert.equal(normalizeDraftText('line one\n\n\n\nline two'), 'line one\n\nline two');
  assert.equal(normalizeDraftText('  keep #hashtag  '), 'keep #hashtag');
});
