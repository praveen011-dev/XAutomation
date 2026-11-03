import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { collectActivity, describeActivity } from '../src/activity.js';

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
}

async function createRepo(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'xpost-activity-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'dev@example.com']);
  git(dir, ['config', 'user.name', 'Dev']);
  await writeFile(path.join(dir, 'app.js'), 'console.log("one");\nconsole.log("two");\n');
  git(dir, ['add', '.']);
  git(dir, ['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'feat: add the app']);
  return dir;
}

test('collects commits, stats, and repo metadata', async (t) => {
  const repo = await createRepo(t);

  const activity = await collectActivity({ repos: [repo], cwd: repo, since: 'midnight' });

  assert.equal(activity.repos.length, 1);
  assert.equal(activity.repos[0].name, path.basename(repo));
  assert.equal(activity.repos[0].email, 'dev@example.com');
  assert.equal(activity.repos[0].branch, 'main');
  assert.equal(activity.commits.length, 1);
  assert.equal(activity.commits[0].subject, 'feat: add the app');
  assert.equal(activity.commits[0].filesChanged, 1);
  assert.equal(activity.commits[0].insertions, 2);
  assert.equal(activity.totals.commits, 1);
  assert.match(describeActivity(activity), /1 commit in 1 repo \(\+2\/-0 across 1 files\)/);
});

test('filters by author email when provided', async (t) => {
  const repo = await createRepo(t);
  const activity = await collectActivity({
    repos: [repo],
    cwd: repo,
    since: 'midnight',
    email: 'someone-else@example.com',
  });

  assert.equal(activity.commits.length, 0);
  assert.match(describeActivity(activity), /No commits found/);
});

test('skips missing and non-git paths instead of failing', async (t) => {
  const plain = await mkdtemp(path.join(os.tmpdir(), 'xpost-plain-'));
  t.after(() => rm(plain, { recursive: true, force: true }));

  const activity = await collectActivity({
    repos: [path.join(plain, 'missing'), plain],
    cwd: plain,
  });

  assert.equal(activity.repos.length, 0);
  assert.equal(activity.skipped.length, 2);
  assert.match(describeActivity(activity), /No git repository found/);
});
