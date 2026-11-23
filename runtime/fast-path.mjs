/** Deterministic fast path: a local proof, made without any model, that a task
 * is a small change of a few named files — style files only (`style_only`) or
 * one to three small source files (`small_local`). Only a positive proof
 * selects it; every doubt or ambiguity returns the ordinary route (Jev
 * assessment, then quick/standard/deep). The proof writes exactly the files it
 * names; it is re-checked against the plan and the actual diff.
 */
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { execute } from './command.mjs';
import { secretFile } from './security.mjs';

/** 3: the write list is exactly the named files, also for `small_local`. */
export const FAST_PATH_VERSION = 3;
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
/** An exclusion or negation: which files must stay is not read, so it is doubt. */
const exclusion =
  /\b(?:except|excluding|exclude|without\s+(?:touching|changing|modifying|editing)|do(?:n't|\s+not)\s+(?:change|modify|touch|edit|alter)|leave\s+\S+(?:\s+\S+)?\s+(?:untouched|unchanged|as\s+is))\b|(?<![а-яё])кроме(?![а-яё])|не\s+(?:меняй|трогай|изменяй|редактируй|правь|затрагивай)|без\s+изменени/i;

const cssNumber = /^\d+(?:\.\d+)?(?:px|rem|em|ex|ch|vh|vw|vmin|vmax|pt|pc|cm|mm|in|s|ms|deg|rad|turn|fr|dpi|x|%)?$/i;

/**
 * The words of the task, the single tokenization of every rule: quotes, brackets, backticks and
 * commas separate words, sentence punctuation is not part of a word. A word that looks like a file
 * reference has a slash or a dot that is not sentence punctuation: `.env`, `обработчик.js`, `a.7z`,
 * `src/server` and `v1.2` all count; a plain number with an optional CSS unit does not.
 */
function wordsOf(task) {
  return [...task.matchAll(/[^\s"'`()[\]{}<>,«»‘’“”]+/g)].map(match => ({
    raw: match[0],
    word: match[0].replace(/[.,;:!?]+$/, ''),
    start: match.index,
    end: match.index + match[0].length,
  }));
}
const fileLike = word => (word.includes('/') || word.includes('.')) && !cssNumber.test(word);

const runVerb = /^(?:run|execute|exec|запусти(?:те)?|запустить|выполни(?:те)?|выполнить)$/i;
const interpreter = /^(?:node|deno|bun|tsx|ts-node|python3?)$/i;
const packageManager = /^(?:npm|pnpm|yarn)$/i;
const option = /^--?[A-Za-z][\w-]*(?:=\S*)?$/;
const conjunction = /^(?:and|then|after|before|but|и|а|но|затем|потом|после|перед)$/i;
const deleteVerb = /^(?:delete|remove|drop|erase|rm|удали(?:те)?|удалить|сотри(?:те)?|стереть|стери)$/i;
const createVerb = /^(?:add|create|new|touch|создай(?:те)?|создать|добавь(?:те)?|добавить|нов(?:ый|ая|ое|ые))$/i;
const filler = /^(?:the|this|that|a|an|file|files|module|файл|файлы|модуль|-\S*)$/i;

/** The last word of a command that starts at `start`: before a conjunction, at sentence end, a comma or a line break. */
function commandEnd(list, task, start) {
  for (let index = start; index < list.length; index++) {
    if (index > start && conjunction.test(list[index].word)) return index - 1;
    const gap = list[index + 1] ? task.slice(list[index].end, list[index + 1].start) : '';
    if (/[.;:!?]$/.test(list[index].raw) || /[,;\n]/.test(gap)) return index;
  }
  return list.length - 1;
}

/**
 * The words inside commands a known tool runs: an interpreter with its script (`node verify.cjs`)
 * and a package manager with its script (`npm run check`, `npm test`), also after a run verb.
 * `unknown` is set when a name is run some other way: a run verb before anything else, or an
 * unknown tool with options (`eslint --fix X`). That is doubt, not a guess.
 */
function commands(list, task) {
  const inside = new Set();
  for (let index = 0; index < list.length; index++) {
    const word = list[index].word,
      next = list[index + 1]?.word ?? '';
    let start = -1;
    if (runVerb.test(word) && !interpreter.test(next) && !packageManager.test(next)) {
      const end = commandEnd(list, task, index + 1);
      if (list.slice(index + 1, end + 1).some(item => fileLike(item.word))) return { inside, unknown: true };
      continue;
    }
    if (interpreter.test(word) && (fileLike(next) || option.test(next))) start = index;
    else if (packageManager.test(word) && next) start = index;
    else if (/^[a-z][\w-]*$/.test(word) && option.test(next)) {
      const end = commandEnd(list, task, index);
      if (list.slice(index, end + 1).some(item => fileLike(item.word))) return { inside, unknown: true };
      continue;
    }
    if (start < 0) continue;
    const end = commandEnd(list, task, start);
    for (let item = start; item <= end; item++) inside.add(item);
    index = end;
  }
  return { inside, unknown: false };
}

/** The verb that governs the word at `index` over articles, `file` and options: `delete`, `create`… */
function governing(list, index) {
  for (let item = index - 1; item >= 0; item--) {
    const word = list[item].word;
    if (deleteVerb.test(word) || createVerb.test(word)) return word;
    if (!filler.test(word)) return null;
  }
  return null;
}

/**
 * The index entries of `name`. With `core.ignorecase` a name is looked up regardless of case, so
 * the caller can use the one canonical index name and compare literally from then on.
 */
async function indexEntries(cwd, name) {
  const ignoreCase = await execute('git', ['config', '--bool', 'core.ignorecase'], { cwd, allowFailure: true });
  const icase = ignoreCase.code === 0 && ignoreCase.stdout.trim() === 'true';
  const tracked = await execute('git', ['ls-files', '-s', '--', `:(${icase ? 'icase,literal' : 'literal'})${name}`], {
    cwd,
    allowFailure: true,
  });
  const entries = tracked.code === 0 ? tracked.stdout.split('\n').filter(Boolean) : [];
  // A pathspec also matches the contents of a directory with that name: only the entry of the
  // name itself counts; contents alone mean a directory.
  const same = entry => {
    const entryName = entry.slice(entry.indexOf('\t') + 1);
    return icase ? entryName.toLowerCase() === name.toLowerCase() : entryName === name;
  };
  return { entries: entries.filter(same), directory: entries.some(entry => !same(entry)) };
}

/** A leading-dot word that is neither a known dot-file, a secret name, tracked nor present. */
async function selector(cwd, word) {
  if (!classSelector.test(word) || dotFile.test(word) || secretFile(word)) return false;
  const tracked = await indexEntries(cwd, word);
  if (tracked.entries.length || tracked.directory) return false;
  try {
    await lstat(path.join(cwd, word));
    return false;
  } catch {
    return true;
  }
}

/** @typedef {{ fastPath: boolean, reason: string, files?: string[], writePaths?: string[] }} LocalTaskDecision `files` and `writePaths` are set when `fastPath` is true. */

/** @returns {LocalTaskDecision} */
const doubt = reason => ({ fastPath: false, reason });

/**
 * The canonical tracked name of one named file, or the reason of doubt: one regular index entry
 * (not a link `120000` or a submodule `160000`), a regular file at the same place inside the
 * worktree (no linked directory on the way), at most 64 KB.
 */
async function trackedFile(cwd, name) {
  const { entries, directory } = await indexEntries(cwd, name);
  if (!entries.length) return { reason: directory ? 'path_not_file' : 'path_untracked' };
  if (entries.length !== 1) return { reason: 'path_ambiguous' };
  if (!/^100(?:644|755) /.test(entries[0])) return { reason: 'path_not_file' };
  const canonical = entries[0].slice(entries[0].indexOf('\t') + 1);
  let info;
  try {
    info = await lstat(path.join(cwd, canonical));
  } catch {
    return { reason: 'path_missing' };
  }
  if (!info.isFile() || info.isSymbolicLink()) return { reason: 'path_not_file' };
  const [root, file] = await Promise.all([realpath(cwd), realpath(path.join(cwd, canonical))]);
  if (path.relative(root, file).split(path.sep).join('/') !== canonical) return { reason: 'path_outside' };
  if (info.size > FAST_PATH_LIMITS.fileBytes) return { reason: 'file_too_large' };
  return { name: canonical };
}

/**
 * Decide whether `task` is provably a small change of a few existing files: style files only
 * (`style_only`) or one to three small source files (`small_local`). The proof writes exactly the
 * named files (`writePaths`); a test is writable only when it is named as a target.
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
  // Several words in backticks are a command whose meaning is not read; an exclusion is not read.
  if ([...task.matchAll(/`([^`]*)`/g)].some(match => /\s/.test(match[1].trim())) || exclusion.test(task))
    return doubt('ambiguous');
  const list = wordsOf(task);
  // Deleting or creating a named file is never a small local edit.
  if (list.some((item, index) => fileLike(item.word) && governing(list, index))) return doubt('risk_marker');
  const { inside, unknown } = commands(list, task);
  if (unknown) return doubt('ambiguous');
  const named = [];
  let selectors = 0;
  const targets = list.filter((item, index) => !inside.has(index) && fileLike(item.word)).map(item => item.word);
  for (const word of new Set(targets)) {
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
  const canonical = [];
  for (const name of named) {
    const tracked = await trackedFile(cwd, name);
    if (tracked.reason) return doubt(tracked.reason);
    canonical.push(tracked.name);
  }
  const files = [...new Set(canonical)].toSorted();
  return { fastPath: true, reason: style ? 'style_only' : 'small_local', files, writePaths: files };
}

/**
 * A saved proof that no longer holds: a code proof of an unreleased intermediate format, whose
 * write list was missing or wider than its files. A style proof always wrote only its files.
 * @param {{ version?: number, reason?: string, files: string[], writePaths?: string[] }} proof
 */
export function fastPathOutdated(proof) {
  if ((proof.reason ?? 'style_only') === 'style_only') return false;
  return (
    proof.version !== FAST_PATH_VERSION ||
    !Array.isArray(proof.writePaths) ||
    proof.writePaths.length !== proof.files.length ||
    proof.writePaths.some(name => !proof.files.includes(name))
  );
}

/**
 * The write list of a proof: exactly its files.
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

const testName = /(?:^|\/)(?:tests?|__tests__)\/|\.(?:test|spec)\.[^./]+$/i;

/**
 * The plan of a proven fast path, built locally and deterministically: one developer node that
 * owns exactly the named files. No planner session is needed.
 * @param {string} task
 * @param {{ reason?: string, files: string[], writePaths?: string[] }} proof A saved proof without a kind is `style_only`.
 */
export function fastPathPlan(task, proof) {
  const reason = proof.reason ?? 'style_only';
  const writePaths = [...fastPathScope(proof)];
  const tests = writePaths.filter(name => testName.test(name));
  const named = writePaths.join(', ');
  return {
    summary: `Fast path (${reason}): one developer change within ${named}`,
    tasks: [
      {
        id: 'change',
        role: 'developer',
        description:
          `Make the requested change. Change only what the task needs among the named files (${named}); a named file that needs no change stays as it is. Do not add, delete or rename files.` +
          `\nTask: ${task}`,
        dependsOn: [],
        writePaths,
        acceptance: [
          'The requested change is made, and only the named files change.',
          ...(tests.length
            ? [
                `If the change alters behaviour, the named test ${tests.join(', ')} covers it: it fails without the change and passes with it.`,
              ]
            : []),
          'The configured project checks pass.',
        ],
        parallel: false,
      },
    ],
  };
}
