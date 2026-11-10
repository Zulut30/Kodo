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

/** Anything shaped like `name.ext` or `dir/name.ext`, wherever it stands in the text. */
const pathToken = /[\w.-]+(?:\/[\w.-]+)*\.[A-Za-z][A-Za-z0-9]{0,7}(?![\w/])/g;
/** Words that mean behaviour, data or delivery rather than appearance. Doubt, not proof. */
const riskMarkers = [
  /\b(?:auth\w*|log-?in|passw\w*|secret\w*|token\w*|credential\w*|security|payment\w*|billing)\b/i,
  /\b(?:migrat\w*|deploy\w*|releas\w*|publish\w*|delet\w*|remov\w*|install\w*|upgrad\w*|dependenc\w*)\b/i,
  /\b(?:script\w*|javascript|typescript|html|api|endpoint\w*|backend|database|refactor\w*|renam\w*)\b/i,
  /безопасн|парол|секрет|токен|оплат|платеж|миграц|депло|релиз|публик|удал|установ|обнов|зависимост/i,
  /скрипт|бэкенд|база данных|рефактор|переимен/i,
];

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
  const named = [...new Set(task.match(pathToken) || [])];
  if (!named.length) return doubt('no_paths');
  if (named.some(name => !STYLE_EXTENSIONS.includes(path.posix.extname(name).toLowerCase())))
    return doubt('non_style_path');
  if (named.length > FAST_PATH_LIMITS.files) return doubt('too_many_files');
  for (const name of named) {
    if (name.split('/').some(part => part.startsWith('.') || part === '')) return doubt('path_hidden');
    const tracked = await execute('git', ['ls-files', '--error-unmatch', '--', name], { cwd, allowFailure: true });
    if (tracked.code !== 0) return doubt('path_untracked');
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
