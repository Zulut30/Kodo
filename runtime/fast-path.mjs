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

const extensions = [...STYLE_EXTENSIONS, ...SOURCE_EXTENSIONS].map(extension => extension.slice(1)).join('|');
/** A file named plainly: ASCII segments, no hidden segment, an allowed extension. */
const plainPath = new RegExp(`^[A-Za-z0-9_-][\\w.-]*(?:\\/[A-Za-z0-9_-][\\w.-]*)*\\.(?:${extensions})$`, 'i');
const generated = /(?:^|\/)(?:node_modules|vendor|dist|build|coverage)\//i;
/** Configuration and data names: never a selector, never a fast-path file. */
const configName = /\.(?:ya?ml|jsonc?|json5|toml|ini|env|cfg|conf|config|properties|xml|lock|plist)$/i;
/** A class selector chain with optional pseudo-classes: `.button`, `.card.is-active`, `.btn:hover`. */
const classSelector = /^(?:\.[A-Za-z_-][\w-]*)+(?::{1,2}[A-Za-z-]+)*$/;
/** Leading-dot names of configuration and tool files: never a selector. */
const dotFile =
  /^\.(?:env|git|npm|yarn|pnpm|nvm|node-version|tool-versions|docker|eslint|prettier|babel|stylelint|husky|vscode|idea|ssh|aws|kube|config|editorconfig|htaccess|htpasswd)|(?:rc|ignore)$/i;
/** Words that mean behaviour, data, access or delivery rather than a local edit. Doubt, not proof. */
const riskMarkers = [
  /auth|log-?in|passw|secret|token|credential|security|payment|billing/i,
  /migrat|deploy|releas|publish|install|upgrad|dependenc|permission|privileg|chmod|chown|sudo|\bkeys?\b/i,
  /backend|database|endpoint|refactor|renam|\bapi\b|\bnpx\b/i,
  // Running a project script is not a risk; changing what is installed is.
  /\b(?:npm|pnpm|yarn)\s+(?:i|add|up|update|upgrade|remove|rm|uninstall|audit|link|ci|exec|dlx)\b/i,
  /безопасн|парол|секрет|токен|оплат|плат[её]ж|миграц|депло|релиз|публик|установ|зависимост|пакет/i,
  /(?<![а-яё])ключ(?:и|а|ей|ом|у|ами|ах)?(?![а-яё])|прав\S* доступ|(?<![а-яё])права(?![а-яё])/i,
  /бэкенд|баз\S* данн|рефактор|переимен/i,
  // Editing the content of a named file is the task; deleting or creating a file is not.
  /(?:delet|remov|удал)\S*\s+(?:the\s+|this\s+|этот\s+)?(?:files?\b|файл)/i,
  /\b(?:add|create)\s+(?:an?\s+|the\s+)?(?:new\s+)?files?\b|\bnew\s+files?\b/i,
  /(?:созда|добав)\S*\s+(?:нов\S*\s+)?файл|(?<![а-яё])нов\S*\s+файл/i,
];
/** The task limits the edit: no test beyond the named files. */
const restricted =
  /\bonly\b|\bexclusively\b|\bnothing else\b|\bno other files?\b|\bdo(?:n't| not) (?:edit|change|modify|touch|add|create|write)\b|(?<![а-яё])(?:только|лишь|исключительно)(?![а-яё])|ничего (?:больше|другого|кроме)|не (?:трогай|меняй|изменяй|редактируй|добавляй|создавай|пиши)/i;

const cssNumber = /^\d+(?:\.\d+)?(?:px|rem|em|ex|ch|vh|vw|vmin|vmax|pt|pc|cm|mm|in|s|ms|deg|rad|turn|fr|dpi|x|%)?$/i;

/**
 * Words of the task that look like a file reference: anything with a slash,
 * or with a dot that is not sentence punctuation. `.env`, `обработчик.js`,
 * `a.7z`, `src/server` and `v1.2` all count; each must then be an allowed path
 * or, next to proven style files, a class selector.
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

const runVerb = /^(?:run|execute|exec|запусти(?:те)?|запустить|выполни(?:те)?|выполнить)$/i;
const interpreter = /^(?:node|deno|bun|tsx|ts-node|python3?)$/i;
const packageManager = /^(?:npm|pnpm|yarn|npx)$/i;
const conjunction = /^(?:and|then|after|before|but|и|а|но|затем|потом|после|перед)$/i;
const bare = token => token.replace(/^[("'«“‘]+|[)"'»”’.,;:!?]+$/g, '');

/**
 * The task without its commands: a multi-word command in backticks, an interpreter or package
 * manager with its arguments (`node verify.cjs`, `npm run check`), and a run verb with its
 * command (`run X`, «запусти X»). A command ends at sentence punctuation, a line break or a
 * conjunction. Names inside a command are arguments to run, never targets to write.
 */
function withoutCommands(task) {
  const text = task.replace(/`([^`]*)`/g, (whole, inner) =>
    /\s/.test(inner.trim()) ? ' '.repeat(whole.length) : whole,
  );
  const tokens = [...text.matchAll(/\S+/g)];
  const blank = new Set();
  const pathy = word => /[./]/.test(word) && !cssNumber.test(word);
  for (let index = 0; index < tokens.length; index++) {
    const word = bare(tokens[index][0]),
      next = tokens[index + 1] ? bare(tokens[index + 1][0]) : '';
    let start = -1;
    if (runVerb.test(word) && (interpreter.test(next) || packageManager.test(next) || pathy(next))) start = index + 1;
    else if (interpreter.test(word) && (pathy(next) || next.startsWith('-'))) start = index;
    else if (packageManager.test(word) && next) start = index;
    if (start < 0) continue;
    let end = start;
    for (; end < tokens.length; end++) {
      if (end > start && conjunction.test(bare(tokens[end][0]))) {
        end--;
        break;
      }
      blank.add(end);
      const after = tokens[end + 1];
      if (
        /[.;,!?]$/.test(tokens[end][0]) ||
        (after && text.slice(tokens[end].index + tokens[end][0].length, after.index).includes('\n'))
      )
        break;
    }
    index = Math.max(index, end);
  }
  let result = '',
    position = 0;
  for (const [index, token] of tokens.entries()) {
    result += text.slice(position, token.index) + (blank.has(index) ? ' '.repeat(token[0].length) : token[0]);
    position = token.index + token[0].length;
  }
  return result + text.slice(position);
}

/** Script sources by test family; markup and style files get no derived test. */
const testFamilies = { js: ['.js', '.mjs', '.cjs', '.jsx'], ts: ['.ts', '.mts', '.cts', '.tsx'] };
const familiesOf = {
  '.js': ['js'],
  '.mjs': ['js'],
  '.cjs': ['js'],
  '.jsx': ['js'],
  '.ts': ['ts'],
  '.mts': ['ts'],
  '.cts': ['ts'],
  '.tsx': ['ts'],
  '.vue': ['js', 'ts'],
  '.svelte': ['js', 'ts'],
};

/**
 * The literal paths of a regression test for one named source: `<base>.test<ext>` and
 * `<base>.spec<ext>` in `tests/`, `test/`, next to the source and in its `__tests__/`, for the
 * extensions of the source's family. No masks: configuration, manifests, helpers and fixtures are
 * never among them.
 * @param {string} file
 */
export function regressionTestPaths(file) {
  const extension = path.posix.extname(file).toLowerCase();
  const exts = (familiesOf[extension] ?? []).flatMap(family => testFamilies[family]);
  const directory = path.posix.dirname(file) === '.' ? '' : `${path.posix.dirname(file)}/`;
  const base = path.posix.basename(file, path.posix.extname(file));
  const result = new Set();
  for (const location of ['tests/', 'test/', directory, `${directory}__tests__/`])
    for (const kind of ['test', 'spec'])
      for (const ext of exts)
        if (`${location}${base}.${kind}${ext}` !== file) result.add(`${location}${base}.${kind}${ext}`);
  return [...result];
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

const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** The task deletes the named file itself, not something inside it. */
const deletes = (task, name) =>
  new RegExp(
    `(?:\\b(?:delet|remov|drop)\\S*|(?<![а-яё])(?:удал|сотр|стер)\\S*|\\b(?:git\\s+)?rm)\\s+(?:(?:-\\S+|the|this|file|файл)\\s+)*\`?${escape(name)}(?![\\w./-])`,
    'i',
  ).test(task);

/** @typedef {{ fastPath: boolean, reason: string, files?: string[], writePaths?: string[] }} LocalTaskDecision `files` and `writePaths` are set when `fastPath` is true. */

/** @returns {LocalTaskDecision} */
const doubt = reason => ({ fastPath: false, reason });

/**
 * Decide whether `task` is provably a small change of a few existing files: style files only
 * (`style_only`) or one to three small source files (`small_local`). `writePaths` is the one
 * list the plan and the diff may use: the files, plus the derived regression test paths of a code
 * change unless the task restricts the edit.
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
  let selectors = 0;
  for (const word of new Set(pathLike(withoutCommands(task)))) {
    if (configName.test(word)) return doubt('non_style_path');
    // A class selector is not a file; it never counts as one and proves nothing by itself.
    if (!word.includes('/') && (await selector(cwd, word))) {
      selectors++;
      continue;
    }
    if (!plainPath.test(word) || generated.test(word) || secretFile(word)) return doubt('non_style_path');
    named.push(word);
  }
  if (!named.length) return doubt('no_paths');
  const style = named.every(name => STYLE_EXTENSIONS.includes(path.extname(name).toLowerCase()));
  // A selector is read as one only next to style files: elsewhere it may hide a requested file.
  if (selectors && !style) return doubt('non_style_path');
  if (named.length > FAST_PATH_LIMITS.files) return doubt('too_many_files');
  if (named.some(name => deletes(task, name))) return doubt('risk_marker');
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
  const files = named.toSorted();
  const tests = style || restricted.test(task) ? [] : files.flatMap(regressionTestPaths);
  return {
    fastPath: true,
    reason: style ? 'style_only' : 'small_local',
    files,
    writePaths: [...new Set([...files, ...tests])],
  };
}

/**
 * The write list of a proof: the recorded one, or the files of a proof saved before it was recorded.
 * @param {{ files: string[], writePaths?: string[] }} proof
 */
export const fastPathScope = proof => proof.writePaths ?? proof.files;

/**
 * The plan stays inside the proof: every write scope is one of the listed paths, literally.
 * @param {any} plan
 * @param {string[]} allowed The proof's write list (`fastPathScope`).
 */
export function fastPathAllowsPlan(plan, allowed) {
  const listed = new Set(allowed);
  return (
    Array.isArray(plan?.tasks) &&
    plan.tasks.length > 0 &&
    plan.tasks.every(
      task =>
        Array.isArray(task?.writePaths) &&
        task.writePaths.length > 0 &&
        task.writePaths.every(scope => listed.has(scope)),
    )
  );
}

/**
 * The plan of a proven fast path, built locally and deterministically: one developer node that
 * owns exactly the proof's write list. No planner session is needed.
 * @param {string} task
 * @param {{ reason?: string, files: string[], writePaths?: string[] }} proof A saved proof without a kind is `style_only`.
 */
export function fastPathPlan(task, proof) {
  const reason = proof.reason ?? 'style_only';
  const writePaths = [...fastPathScope(proof)];
  const tests = writePaths.filter(name => !proof.files.includes(name));
  const named = proof.files.join(', ');
  return {
    summary: `Fast path (${reason}): one developer change within ${named}`,
    tasks: [
      {
        id: 'change',
        role: 'developer',
        description:
          `Make the requested change. Change only what the task needs among the named files (${named}); a named file that needs no change stays as it is. ` +
          (tests.length
            ? 'A regression test may go only to one of the test paths listed in writePaths.'
            : reason === 'style_only'
              ? 'This is a style change: do not add test or documentation files.'
              : 'The task restricts the edit: do not add tests or other files.') +
          `\nTask: ${task}`,
        dependsOn: [],
        writePaths,
        acceptance: [
          'The requested change is made, and only files from the allowed write paths change.',
          ...(tests.length
            ? [
                'If the change alters behaviour, a regression test at one of the listed test paths fails without the change and passes with it; otherwise the report states why no test is needed.',
              ]
            : []),
          'The configured project checks pass.',
        ],
        parallel: false,
      },
    ],
  };
}
