import { DEFAULT_MAX_CHARS } from './tweet.js';

function formatCommit(commit) {
  const stats = `${commit.filesChanged} ${commit.filesChanged === 1 ? 'file' : 'files'}, +${commit.insertions}/-${commit.deletions}`;
  return `- ${commit.repo}: "${commit.subject}" (${stats})`;
}

export function buildDraftPrompt({
  activity = null,
  topic = '',
  maxChars = DEFAULT_MAX_CHARS,
  previousText = '',
  scoop = null,
  now = new Date(),
} = {}) {
  const system = [
    'You write short, high-signal X (Twitter) posts for a working software developer.',
    '',
    'Hard rules:',
    '- Return only the post text. No preamble, no explanation, no markdown, no code fences, no surrounding quotes.',
    `- Keep it within ${maxChars} characters. X counts every link as 23 characters.`,
    '- Sound like a person, not a brand. Be specific. Avoid "excited to announce", "game-changer", "dive in".',
    '- Use at most 2 hashtags and at most 2 emoji. Prefer none.',
    '- Never invent commits, numbers, links, or events. Only use the facts provided.',
    '- Do not add URLs unless they appear in the facts.',
    '',
    'Aim for one clear idea: a small win, a lesson, an observation, or a question other developers would answer.',
  ].join('\n');

  const pad = (value) => String(value).padStart(2, '0');
  const localDate = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const sections = [`Date: ${localDate}`];

  if (topic) {
    sections.push(
      '',
      `Write one X post about this topic: ${topic}`,
      'Do not claim you shipped or did something today unless it is listed in the facts below.',
    );
  } else {
    sections.push('', "Today's coding activity from git:");
  }

  if (activity) {
    if (activity.commits.length) {
      const shown = activity.commits.slice(0, 20);
      sections.push(
        ...shown.map(formatCommit),
        `Totals: ${activity.totals.commits} commits, ${activity.totals.filesChanged} files, +${activity.totals.insertions}/-${activity.totals.deletions}.`,
      );
      const repoList = activity.repos
        .map((repo) => `${repo.name} (branch ${repo.branch})`)
        .join(', ');
      sections.push(`Repositories: ${repoList}.`);
    } else if (activity.repos?.length === 0) {
      sections.push(
        'No repository data was found.',
        'Write an honest tech-industry post. It can be a reflection, a small lesson, or a question to other developers. Do not pretend you shipped something today.',
      );
    } else {
      sections.push(
        'No commits were recorded today.',
        'Write an honest off-day / tech-industry post instead. It can be a reflection, a small lesson, or a question to other developers. Do not pretend work happened.',
      );
    }
  } else if (!topic) {
    sections.push('No repository data is available. Write a general tech-industry post.');
  }

  if (previousText) {
    sections.push(
      '',
      'The writer rejected this earlier draft. Take a clearly different angle and do not reuse its wording:',
      `"""${previousText.slice(0, 600)}"""`,
    );
  }

  const inspiration = Array.isArray(scoop?.posts) ? scoop.posts.filter((post) => post?.text) : [];
  if (inspiration.length) {
    const heading = scoop.query ?? topic ?? 'this topic';
    sections.push(
      '',
      `Recent public X posts about "${heading}" — context on what people are discussing:`,
      ...inspiration
        .slice(0, 8)
        .map((post) => `- ${String(post.text).replace(/\s+/g, ' ').trim().slice(0, 220)}`),
      '',
      'Use them only as background. Write an original post in your own voice: do not quote or closely paraphrase them, and never present someone else’s experience as your own.',
    );
  }

  sections.push('', 'Write the post now.');

  return { system, prompt: sections.join('\n') };
}

export function buildImagePrompt(draftText) {
  const concept = String(draftText).replace(/\s+/g, ' ').trim().slice(0, 500);
  return [
    'Create a square 1:1 editorial illustration for this developer post:',
    `"""${concept}"""`,
    '',
    'Style: clean modern editorial illustration, strong composition, high contrast, restrained palette, subtle grain.',
    'Requirements: no text, no letters, no numbers, no logos, no watermarks, no screenshots, no cluttered UI.',
  ].join('\n');
}
