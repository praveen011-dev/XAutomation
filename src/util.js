import path from 'node:path';

const colorEnabled =
  Boolean(process.stdout.isTTY) &&
  !process.env.NO_COLOR &&
  process.env.TERM !== 'dumb';

const style = (code) => (value) =>
  colorEnabled ? `\u001b[${code}m${value}\u001b[0m` : String(value);

export const color = {
  bold: style('1'),
  dim: style('2'),
  red: style('31'),
  green: style('32'),
  yellow: style('33'),
  blue: style('34'),
  magenta: style('35'),
  cyan: style('36'),
};

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Wrap text to a fixed width, preserving existing newlines and words. */
export function wrapText(text, width = 76) {
  return String(text)
    .split(/\r?\n/)
    .flatMap((line) => {
      if (line.length <= width) return [line];
      const words = line.split(' ');
      const lines = [];
      let current = '';
      for (const word of words) {
        if (!current) {
          current = word;
        } else if (current.length + 1 + word.length <= width) {
          current += ` ${word}`;
        } else {
          lines.push(current);
          current = word;
        }
      }
      if (current) lines.push(current);
      return lines;
    })
    .join('\n');
}

export function maskSecret(value) {
  if (!value) return '(missing)';
  if (value.length <= 8) return '*'.repeat(value.length);
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function truncate(value, length = 88) {
  const text = String(value ?? '');
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}

export function formatLocalTimestamp(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso);
  const pad = (number) => String(number).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function relativeTo(cwd, target) {
  const relative = path.relative(cwd, target);
  return relative && !relative.startsWith('..') ? relative : target;
}

export function createLogger({ out = process.stdout, err = process.stderr } = {}) {
  return {
    info: (message = '') => out.write(`${message}\n`),
    step: (message) => out.write(`${color.cyan('›')} ${message}\n`),
    success: (message) => out.write(`${color.green('✔')} ${message}\n`),
    warn: (message) => err.write(`${color.yellow('!')} ${message}\n`),
    error: (message) => err.write(`${color.red('✖')} ${message}\n`),
    detail: (message) => out.write(`${color.dim(message)}\n`),
    blank: () => out.write('\n'),
  };
}

export class UserError extends Error {
  constructor(message, { exitCode = 1, hint } = {}) {
    super(message);
    this.name = 'UserError';
    this.exitCode = exitCode;
    this.hint = hint;
  }
}

export class UsageError extends UserError {
  constructor(message) {
    super(message, { exitCode: 2 });
    this.name = 'UsageError';
  }
}
