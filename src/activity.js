import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

async function git(args, cwd) {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout;
}

function parseNumstat(lines) {
  let filesChanged = 0;
  let insertions = 0;
  let deletions = 0;

  for (const line of lines) {
    const match = line.match(/^(\d+|-)\t(\d+|-)\t/);
    if (!match) continue;
    filesChanged += 1;
    if (match[1] !== '-') insertions += Number.parseInt(match[1], 10);
    if (match[2] !== '-') deletions += Number.parseInt(match[2], 10);
  }

  return { filesChanged, insertions, deletions };
}

function parseLog(stdout, repoName) {
  const commits = [];
  let current = null;

  for (const line of stdout.split(/\r?\n/)) {
    if (line.startsWith('__COMMIT__')) {
      if (current) commits.push(current);
      const [hash, date, ...subjectParts] = line.slice('__COMMIT__'.length).split('\t');
      current = {
        repo: repoName,
        hash,
        date,
        subject: subjectParts.join('\t').trim(),
        filesChanged: 0,
        insertions: 0,
        deletions: 0,
      };
      continue;
    }
    if (current && line.trim()) {
      const stats = parseNumstat([line]);
      current.filesChanged += stats.filesChanged;
      current.insertions += stats.insertions;
      current.deletions += stats.deletions;
    }
  }
  if (current) commits.push(current);

  return commits;
}

function errorText(error) {
  return String(error?.stderr || error?.message || error).trim().split('\n')[0];
}

/**
 * Collect today's commits from one or more repositories.
 * Invalid / missing paths end up in `skipped` rather than failing the run.
 */
export async function collectActivity({
  repos = [],
  cwd = process.cwd(),
  since = 'midnight',
  email = '',
  maxCommits = 20,
} = {}) {
  const requested = repos.length ? repos : [cwd];
  const activity = {
    since,
    repos: [],
    commits: [],
    skipped: [],
    totals: { commits: 0, filesChanged: 0, insertions: 0, deletions: 0 },
  };

  const seen = new Set();

  for (const requestedPath of requested) {
    const candidate = path.resolve(cwd, requestedPath);

    if (seen.has(candidate)) continue;
    seen.add(candidate);

    if (!existsSync(candidate)) {
      activity.skipped.push({ path: candidate, reason: 'path does not exist' });
      continue;
    }

    let topLevel;
    try {
      topLevel = (await git(['rev-parse', '--show-toplevel'], candidate)).trim();
    } catch (error) {
      activity.skipped.push({
        path: candidate,
        reason: errorText(error) || 'not a git repository',
      });
      continue;
    }

    let branch = 'unknown';
    try {
      branch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'], topLevel)).trim() || 'unknown';
    } catch {
      // An empty repository has no branch yet; keep going.
    }

    let author = email;
    if (!author) {
      try {
        author = (await git(['config', 'user.email'], topLevel)).trim();
      } catch {
        author = '';
      }
    }

    const repoInfo = {
      path: topLevel,
      name: path.basename(topLevel),
      branch,
      email: author,
    };
    activity.repos.push(repoInfo);

    const args = [
      'log',
      `--since=${since}`,
      `--max-count=${maxCommits}`,
      '--no-merges',
      '--date=short',
      '--pretty=format:__COMMIT__%h%x09%ad%x09%s',
      '--numstat',
    ];
    if (author) args.splice(2, 0, `--author=${author}`);

    try {
      const stdout = await git(args, topLevel);
      const commits = parseLog(stdout, repoInfo.name);

      for (const commit of commits) {
        activity.commits.push(commit);
        activity.totals.commits += 1;
        activity.totals.filesChanged += commit.filesChanged;
        activity.totals.insertions += commit.insertions;
        activity.totals.deletions += commit.deletions;
      }
    } catch (error) {
      const reason = errorText(error);
      if (/does not have any commits|unknown revision|bad default revision/i.test(reason)) {
        continue;
      }
      activity.skipped.push({ path: topLevel, reason });
    }
  }

  return activity;
}

export function describeActivity(activity) {
  const repos = activity.repos.length;
  const commits = activity.totals.commits;

  if (!repos) {
    return 'No git repository found — the AI will write a tech-industry post.';
  }
  if (!commits) {
    return `No commits found in ${repos} ${repos === 1 ? 'repo' : 'repos'} since ${activity.since} — the AI will write an off-day post.`;
  }

  const stats = `+${activity.totals.insertions}/-${activity.totals.deletions} across ${activity.totals.filesChanged} files`;
  return `${commits} ${commits === 1 ? 'commit' : 'commits'} in ${repos} ${repos === 1 ? 'repo' : 'repos'} (${stats}).`;
}
