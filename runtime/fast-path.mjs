/** Deterministic fast path: a local proof, made without any model, that a task
 * is a small change of a few named files — style files only (`style_only`) or
 * one to three small source files (`small_local`). Only a positive proof
 * selects it; every doubt returns the ordinary route (Jev assessment, then
 * quick/standard/deep). The proof is re-checked against the plan: a plan that
 * writes anything else revokes the fast path.
 */
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { execute } from './command.mjs';
import { ownsPath } from './contracts.mjs';
import { secretFile } from './security.mjs';

export const FAST_PATH_VERSION = 2;
export const STYLE_EXTENSIONS = Object.freeze(['.css', '.scss', '.sass', '.less', '.styl', '.pcss']);
/**
 * Front-end and JavaScript/TypeScript sources whose effect stays inside code that the project's
 * own tests, build and the review check. Configuration and data (`.json`, `.yml`, `.toml`, `.env`),
 * manifests and lockfiles, shell/PowerShell, SQL/migrations, CI and documentation are left out:
 * they change dependencies, data, delivery or the execution environment, which no word list proves.
 */
export const SOURCE_EXTENSIONS = Object.freeze([
  '.js',
  '.mjs',
  '.cjs',
  '.jsx',
  '.ts',
  '.mts',
  '.cts',
  '.tsx',
  '.vue',
  '.svelte',
  '.html',
  '.htm',
]);
export const FAST_PATH_LIMITS = Object.freeze({ taskBytes: 800, files: 3, fileBytes: 65536 });
/** Test locations a small local code change may also write: its regression test. */
export const FAST_PATH_TEST_SCOPES = Object.freeze([
  '**/test/**',
  '**/tests/**',
  '**/__tests__/**',
  '**/*.test.*',
  '**/*.spec.*',
]);

const extensions = [...STYLE_EXTENSIONS, ...SOURCE_EXTENSIONS].map(extension => extension.slice(1)).join('|');
/** A file named plainly: ASCII segments, no hidden segment, an allowed extension. */
const plainPath = new RegExp(`^[A-Za-z0-9_-][\\w.-]*(?:\\/[A-Za-z0-9_-][\\w.-]*)*\\.(?:${extensions})$`, 'i');
const generated = /(?:^|\/)(?:node_modules|vendor|dist|build|coverage)\//i;
/** A class selector chain with optional pseudo-classes: `.button`, `.card.is-active`, `.btn:hover`. */
const classSelector = /^(?:\.[A-Za-z_-][\w-]*)+(?::{1,2}[A-Za-z-]+)*$/;
/** Leading-dot names of configuration and tool files: never a selector. */
const dotFile =
  /^\.(?:env|git|npm|yarn|pnpm|nvm|node-version|tool-versions|docker|eslint|prettier|babel|stylelint|husky|vscode|idea|ssh|aws|kube|config|editorconfig|htaccess|htpasswd)|(?:rc|ignore)$/i;
/** Words that mean behaviour, data, access or delivery rather than a local edit. Doubt, not proof. */
const riskMarkers = [
  /auth|log-?in|passw|secret|token|credential|security|payment|billing/i,
  /migrat|deploy|releas|publish|install|upgrad|dependenc|permission|privileg|chmod|chown|sudo|\bkeys?\b/i,
  /backend|database|endpoint|refactor|renam|\bapi\b|\bnpm\b|\bnpx\b/i,
  /безопасн|парол|секрет|токен|оплат|плат[её]ж|миграц|депло|релиз|публик|установ|зависимост|пакет/i,
  /(?<![а-яё])ключ(?:и|а|ей|ом|у|ами|ах)?(?![а-яё])|прав\S* доступ|(?<![а-яё])права(?![а-яё])/i,
  /бэкенд|баз\S* данн|рефактор|переимен/i,
  // Editing the content of a named file is the task; deleting the file itself is not.
  /(?:delet|remov|удал)\S*\s+(?:the\s+|this\s+|этот\s+)?(?:files?\b|файл)/i,
];

const cssNumber = /^\d+(?:\.\d+)?(?:px|rem|em|ex|ch|vh|vw|vmin|vmax|pt|pc|cm|mm|in|s|ms|deg|rad|turn|fr|dpi|x|%)?$/i;

/**
 * Words of the task that look like a file reference: anything with a slash,
 * or with a dot that is not sentence punctuation. `.env`, `обработчик.js`,
 * `a.7z`, `src/server` and `v1.2` all count; each must then be an allowed path
 * or, next to a proven file, a class selector.
 */
function pathLike(task) {
  return (
    task
      .split(/[\s"'`()[\]{}<>,«»‘’“”]+/)
      .map(word => word.replace(/[.,;:!?]+$/, ''))
      // A plain number with an optional CSS unit (`0.8`, `1.5rem`, `50%`) is a value, not a file.
      // Any other suffix (`2.7z`, `1.0a`) still looks like a file.
      .filter(word => (word.includes('/') || word.includes('.')) && !cssNumber.test(word))
  );
}

/** The single index entry of `name`, or none. */
async function indexEntries(cwd, name) {
  const tracked = await execute('git', ['ls-files', '-s', '--', name], { cwd, allowFailure: true });
  return tracked.code === 0 ? tracked.stdout.split('\n').filter(Boolean) : [];
}

/** A leading-dot word that is neither a known dot-file, a secret name, tracked nor present. */
async function selector(cwd, word) {
  if (!classSelector.test(word) || dotFile.test(word) || secretFile(word)) return false;
  if ((await indexEntries(cwd, word)).length) return false;
  try {
    await lstat(path.join(cwd, word));
    return false;
  } catch {
    return true;
  }
}

/** @typedef {{ fastPath: boolean, reason: string, files?: string[] }} LocalTaskDecision `files` is set when `fastPath` is true. */

/** @returns {LocalTaskDecision} */
const doubt = reason => ({ fastPath: false, reason });

/**
 * Decide whether `task` is provably a small change of a few existing files: style files only
 * (`style_only`) or one to three small source files (`small_local`).
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
  const named = [];
  for (const word of new Set(pathLike(task))) {
    // A class selector is not a file; it never counts as one and proves nothing by itself.
    if (!word.includes('/') && (await selector(cwd, word))) continue;
    if (!plainPath.test(word) || generated.test(word) || secretFile(word)) return doubt('non_style_path');
    named.push(word);
  }
  if (!named.length) return doubt('no_paths');
  if (named.length > FAST_PATH_LIMITS.files) return doubt('too_many_files');
  for (const name of named) {
    // The index entry must be a regular file: mode 120000 is a symbolic link even where the
    // working tree shows it as a plain file, 160000 is a submodule.
    const entries = await indexEntries(cwd, name);
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
  const style = named.every(name => STYLE_EXTENSIONS.includes(path.extname(name).toLowerCase()));
  return { fastPath: true, reason: style ? 'style_only' : 'small_local', files: named.toSorted() };
}

/** A literal test file inside the test locations: no glob, no hidden or parent segment. */
const testFile = scope =>
  !/[*?[\]{}]/.test(scope) &&
  scope.split('/').every(segment => segment && !segment.startsWith('.')) &&
  !secretFile(scope) &&
  ownsPath(FAST_PATH_TEST_SCOPES, scope);

/**
 * The plan stays inside the proof: every write scope is one of the proven files, literally; a
 * `small_local` plan may also write tests (the fixed test scopes or a literal test file).
 * @param {any} plan
 * @param {string[]} files
 * @param {string} [reason] The proof kind; a saved proof without one is `style_only`.
 */
export function fastPathAllowsPlan(plan, files, reason = 'style_only') {
  const allowed = new Set([...files, ...(reason === 'small_local' ? FAST_PATH_TEST_SCOPES : [])]);
  const code = reason === 'small_local';
  return (
    Array.isArray(plan?.tasks) &&
    plan.tasks.length > 0 &&
    plan.tasks.every(
      task =>
        Array.isArray(task?.writePaths) &&
        task.writePaths.length > 0 &&
        task.writePaths.every(scope => allowed.has(scope) || (code && typeof scope === 'string' && testFile(scope))),
    )
  );
}

/**
 * The plan of a proven fast path, built locally and deterministically: one developer node that
 * owns the named files (and, for code, the test locations). No planner session is needed.
 * @param {string} task
 * @param {{ reason: string, files: string[] }} proof
 */
export function fastPathPlan(task, { reason, files }) {
  const code = reason === 'small_local';
  const named = files.join(', ');
  return {
    summary: `Fast path (${reason}): one developer change of ${named}`,
    tasks: [
      {
        id: 'change',
        role: 'developer',
        description:
          `Make the requested change in the named files only: ${named}. ` +
          (code
            ? 'Keep the change local; a behaviour change gets a regression test in a test location.'
            : 'This is a style change: do not add test or documentation files.') +
          `\nTask: ${task}`,
        dependsOn: [],
        writePaths: code ? [...files, ...FAST_PATH_TEST_SCOPES] : [...files],
        acceptance: [
          `The requested change is made in ${named} and nowhere else outside the allowed write paths.`,
          ...(code
            ? [
                'If the change alters behaviour, a regression test is added or updated in a test location (test/, tests/, __tests__/, *.test.*, *.spec.*) that fails without the change and passes with it; otherwise the report states why no test is needed.',
              ]
            : []),
          'The configured project checks pass.',
        ],
        parallel: false,
      },
    ],
  };
}
