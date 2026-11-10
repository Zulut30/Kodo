/** Deterministic fast path: a local proof, made without any model, that a task
 * is a small style-only change. Only a positive proof selects it; every doubt
 * returns the ordinary route (Jev assessment, then quick/standard/deep). The
 * proof is re-checked against the plan: a plan that writes anything else
 * revokes the fast path.
 */
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { execute } from './command.mjs';

export const FAST_PATH_VERSION = 1;
export const STYLE_EXTENSIONS = Object.freeze(['.css', '.scss', '.sass', '.less', '.styl', '.pcss']);
export const FAST_PATH_LIMITS = Object.freeze({ taskBytes: 800, files: 3, fileBytes: 65536 });

/** A style file named plainly: ASCII segments, no hidden segment, a style extension. */
const stylePath = /^[A-Za-z0-9_-][\w.-]*(?:\/[A-Za-z0-9_-][\w.-]*)*\.(?:css|scss|sass|less|styl|pcss)$/i;
/** Words that mean behaviour, data or delivery rather than appearance. Doubt, not proof. */
const riskMarkers = [
  /auth|log-?in|passw|secret|token|credential|security|payment|billing/i,
  /migrat|deploy|releas|publish|delet|remov|install|upgrad|dependenc/i,
  /script|javascript|typescript|backend|database|refactor|renam|endpoint/i,
  /\b(?:html|api)\b/i,
  /безопасн|парол|секрет|токен|оплат|плат[её]ж|миграц|депло|релиз|публик|удал|установ|обнов|зависимост/i,
  /скрипт|бэкенд|баз\S* данн|рефактор|переимен/i,
];

/**
 * Words of the task that look like a file reference: anything with a slash,
 * or with a dot that is not sentence punctuation. `.env`, `обработчик.js`,
 * `a.7z`, `src/server` and `v1.2` all count; each must then be a style path.
 */
function pathLike(task) {
  return (
    task
      .split(/[\s"'`()[\]{}<>,\u00ab\u00bb\u2018\u2019\u201c\u201d]+/)
      .map(word => word.replace(/[.,;:!?]+$/, ''))
      // A plain number with an optional unit (`0.8`, `1.5rem`, `50%`) is a value, not a file.
      .filter(word => (word.includes('/') || word.includes('.')) && !/^\d+(?:\.\d+)?[a-z%]*$/i.test(word))
  );
}

/** @typedef {{ fastPath: boolean, reason: string, files?: string[] }} LocalTaskDecision `files` is set when `fastPath` is true. */

/** @returns {LocalTaskDecision} */
const doubt = reason => ({ fastPath: false, reason });

/**
 * Decide whether `task` is provably a style-only change of a few existing files.
 * @param {{ cwd: string, task: string, requested?: string | null }} input `requested` is an explicit execution mode.
 * @returns {Promise<LocalTaskDecision>}
 */
export async function classifyLocalTask({ cwd, task, requested }) {
  // An explicit wider mode is the user's decision; the fast path never narrows it.
  if (requested === 'standard' || requested === 'deep') return doubt('mode_requested');
  if (typeof task !== 'string' || !task.trim() || !task.isWellFormed()) return doubt('task_invalid');
  if (Buffer.byteLength(task) > FAST_PATH_LIMITS.taskBytes) return doubt('task_too_long');
  if (/:\/\/|\bwww\./i.test(task)) return doubt('url');
  if (/[\\]|\.\.\/|(?:^|\s)[~/]/.test(task)) return doubt('path_not_relative');
  if (riskMarkers.some(marker => marker.test(task))) return doubt('risk_marker');
  const named = [...new Set(pathLike(task))];
  if (!named.length) return doubt('no_paths');
  if (named.some(name => !stylePath.test(name))) return doubt('non_style_path');
  if (named.length > FAST_PATH_LIMITS.files) return doubt('too_many_files');
  for (const name of named) {
    // The index entry must be a regular file: mode 120000 is a symbolic link even where the
    // working tree shows it as a plain file, 160000 is a submodule.
    const tracked = await execute('git', ['ls-files', '-s', '--', name], { cwd, allowFailure: true });
    const entries = tracked.code === 0 ? tracked.stdout.split('\n').filter(Boolean) : [];
    if (entries.length !== 1) return doubt('path_untracked');
    if (!/^100(?:644|755) /.test(entries[0])) return doubt('path_not_file');
    let info;
    try {
      info = await lstat(path.join(cwd, name));
    } catch {
      return doubt('path_missing');
    }
    if (!info.isFile() || info.isSymbolicLink()) return doubt('path_not_file');
    if (info.size > FAST_PATH_LIMITS.fileBytes) return doubt('file_too_large');
  }
  return { fastPath: true, reason: 'style_only', files: named.toSorted() };
}

/**
 * The plan stays inside the proof: every write scope is one of the proven files, literally.
 * @param {any} plan
 * @param {string[]} files
 */
export function fastPathAllowsPlan(plan, files) {
  const allowed = new Set(files);
  return (
    Array.isArray(plan?.tasks) &&
    plan.tasks.length > 0 &&
    plan.tasks.every(
      task =>
        Array.isArray(task?.writePaths) &&
        task.writePaths.length > 0 &&
        task.writePaths.every(scope => allowed.has(scope)),
    )
  );
}
