/** Behaviour gate: deterministic, model-free checks of the final head that
 * outrank a reviewer's report.
 *
 * 1. QualityPolicy: the change is classified by its changed paths, and each
 *    type names the gates it needs. A needed gate that is disabled is a
 *    recorded gap, never a PASS.
 * 2. Test protection: tests that existed on the base may not be deleted,
 *    skipped, focused or stripped of their cases and assertions.
 * 3. Behavioural oracles: project-owned commands (contract tests, comparison
 *    with a reference tool) run by the coordinator. The files an oracle
 *    protects must be byte-identical to the base.
 *
 * The receipt is bound to the exact head, base and configuration.
 */
import { createHash } from 'node:crypto';
import { ownsPath } from './contracts.mjs';
import { execute } from './command.mjs';
import { workerEnvironment } from './security.mjs';

export const BEHAVIOR_GATE_VERSION = 1;
const hash = value => createHash('sha256').update(value).digest('hex');

/** @returns {never} */
function invalid(message) {
  throw Object.assign(new Error(`Некорректная конфигурация Kodo: verification: ${message}`), {
    code: 'configuration',
  });
}

const relativeScope = scope =>
  typeof scope === 'string' &&
  Boolean(scope) &&
  !scope.includes('\\') &&
  !scope.startsWith('/') &&
  !scope.includes(':') &&
  !scope.split('/').includes('..');

/**
 * @typedef {object} VerificationConfig
 * @property {boolean} baseline Run the check commands on the base commit before any edit.
 * @property {boolean} testProtection Refuse removed and switched-off tests.
 * @property {string[]} testRemovalAllowed Test paths (globs) this run may delete or reduce: an explicit, narrow exception.
 * @property {boolean} strictGates A gate the policy needs but the project disabled fails the gate.
 * @property {{ id: string, command: string, args: string[], timeoutMs?: number, protect: string[] }[]} oracles
 */

/**
 * @param {unknown} [value]
 * @returns {VerificationConfig}
 */
export function normalizeVerificationConfig(value = undefined) {
  const input = /** @type {Record<string, any>} */ (value === undefined ? {} : value);
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid('an object is expected');
  const known = ['baseline', 'testProtection', 'testRemovalAllowed', 'strictGates', 'oracles'];
  for (const key of Object.keys(input)) if (!known.includes(key)) invalid(`unknown key ${key}`);
  for (const key of ['baseline', 'testProtection', 'strictGates'])
    if (input[key] !== undefined && typeof input[key] !== 'boolean') invalid(`${key} must be boolean`);
  const allowed = input.testRemovalAllowed ?? [];
  if (!Array.isArray(allowed) || allowed.length > 64 || allowed.some(scope => !relativeScope(scope)))
    invalid('testRemovalAllowed must be a short list of repository-relative paths');
  const oracles = input.oracles ?? [];
  if (!Array.isArray(oracles) || oracles.length > 8) invalid('oracles must be a list of at most 8');
  const ids = new Set();
  const normalized = oracles.map(oracle => {
    if (!oracle || typeof oracle !== 'object' || Array.isArray(oracle)) invalid('an oracle must be an object');
    for (const key of Object.keys(oracle))
      if (!['id', 'command', 'args', 'timeoutMs', 'protect'].includes(key)) invalid(`unknown oracle key ${key}`);
    if (typeof oracle.id !== 'string' || !/^[a-z][a-z0-9-]{0,47}$/.test(oracle.id) || ids.has(oracle.id))
      invalid('oracle id must be a unique slug');
    ids.add(oracle.id);
    if (typeof oracle.command !== 'string' || !oracle.command.trim()) invalid(`oracle ${oracle.id} has no command`);
    const args = oracle.args ?? [];
    if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string')) invalid(`oracle ${oracle.id} args`);
    const protect = oracle.protect ?? [];
    if (
      !Array.isArray(protect) ||
      !protect.length ||
      protect.length > 64 ||
      protect.some(
        scope =>
          typeof scope !== 'string' ||
          !scope ||
          scope.includes('\\') ||
          scope.startsWith('/') ||
          scope.includes(':') ||
          scope.split('/').includes('..'),
      )
    )
      invalid(`oracle ${oracle.id} must protect repository-relative paths`);
    if (
      oracle.timeoutMs !== undefined &&
      (!Number.isInteger(oracle.timeoutMs) || oracle.timeoutMs < 0 || oracle.timeoutMs > 2147483647)
    )
      invalid(`oracle ${oracle.id} timeoutMs`);
    return {
      id: oracle.id,
      command: oracle.command,
      args: [...args],
      ...(oracle.timeoutMs === undefined ? {} : { timeoutMs: oracle.timeoutMs }),
      protect: [...protect],
    };
  });
  return {
    baseline: input.baseline ?? false,
    testProtection: input.testProtection ?? true,
    testRemovalAllowed: [...allowed],
    strictGates: input.strictGates ?? false,
    oracles: normalized,
  };
}

export const verificationConfigHash = config =>
  hash(JSON.stringify({ version: BEHAVIOR_GATE_VERSION, config: normalizeVerificationConfig(config) }));

/** @type {[string, RegExp][]} */
const changeTypes = [
  [
    'ci',
    /(^|\/)\.github\/(?:workflows|actions)\/|(^|\/)\.github\/dependabot\.ya?ml$|(^|\/)\.gitlab-ci\.yml$|(^|\/)azure-pipelines\.yml$|(^|\/)Jenkinsfile$|(^|\/)\.circleci\/|(^|\/)Dockerfile[^/]*$|(^|\/)docker-compose[^/]*\.ya?ml$|\.tf$/i,
  ],
  [
    'release',
    /(^|\/)(?:CHANGELOG[^/]*|\.releaserc[^/]*|release[^/]*\.(?:json|ya?ml|[cm]?js))$|(^|\/)scripts\/release/i,
  ],
  ['schema', /(^|\/)(?:migrations?|schema|prisma|db)\/|\.sql$|(^|\/)schema\.[a-z]+$/i],
  [
    'security',
    // Whole words only: `AUTHORS.md` and `src/author.ts` are not authentication.
    /(^|\/)(?:auth|authn|authz|authentication|authorization|oauth\d?|login|security|crypto|cryptography|permissions?|secrets?|sessions?|acl)(?:\/|\.|-|_|$)|(^|\/)\.env[^/]*$/i,
  ],
  [
    'api',
    /(^|\/)(?:api|routes?|controllers?|handlers?|graphql|proto)\/|\.(?:proto|graphql)$|openapi[^/]*\.(?:ya?ml|json)$/i,
  ],
  [
    'tests',
    /(^|\/)(?:tests?|__tests__|spec)\/|\.(?:test|spec)\.[cm]?[jt]sx?$|_test\.(?:go|py|rs)$|(^|\/)test_[^/]+\.py$/i,
  ],
  ['style', /\.(?:css|scss|sass|less|styl|pcss)$/i],
  // By extension only: a script under docs/ is code.
  [
    'content',
    /\.(?:md|mdx|rst|adoc)$|(^|\/)LICENSE[^/]*$|(^|\/)(?!CMakeLists\.txt$|requirements[^/]*\.txt$)[^/]+\.txt$/i,
  ],
  [
    'config',
    /(^|\/)(?:package(?:-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.(?:toml|lock)|go\.(?:mod|sum)|pyproject\.toml|requirements[^/]*\.txt|CMakeLists\.txt|Makefile|kodo\.config\.json|tsconfig[^/]*\.json|(?:jest|vitest|vite|webpack|rollup|babel|eslint|prettier|playwright)\.config\.[cm]?[jt]s|\.[a-z]+rc(?:\.[a-z]+)?)$/i,
  ],
];
const isTestFile = file => changeTypes.find(([type]) => type === 'tests')[1].test(file);
const highRisk = new Set(['ci', 'release', 'schema', 'security']);
const lowRisk = new Set(['style', 'content', 'tests']);
/** Gates each change type needs. `oracle` means at least one configured behavioural oracle. */
const neededGates = {
  style: ['ui'],
  security: ['security'],
  ci: ['security'],
  release: ['security'],
  config: ['security'],
  schema: ['oracle'],
  api: ['architecture'],
};

/**
 * Change types of a set of changed paths. A path with no specific type is `code`.
 * @param {string[]} paths
 * @returns {string[]} Sorted unique types.
 */
export function classifyChange(paths) {
  const types = new Set();
  for (const file of paths) {
    const matched = changeTypes.filter(([, pattern]) => pattern.test(file)).map(([type]) => type);
    for (const type of matched.length ? matched : ['code']) types.add(type);
  }
  return [...types].sort();
}

/**
 * What a change of these types requires and what the project cannot verify.
 * @param {{ types: string[], config: Record<string, any>, verification: VerificationConfig }} input
 */
export function qualityPolicy({ types, config, verification }) {
  const enabled = {
    ui: config.uiVerification?.enabled === true,
    security: config.security?.enabled === true,
    architecture: config.architecture?.enabled === true,
    oracle: verification.oracles.length > 0,
  };
  const required = [...new Set(types.flatMap(type => neededGates[type] ?? []))].sort();
  const risk = types.some(type => highRisk.has(type))
    ? 'high'
    : types.length && types.every(type => lowRisk.has(type))
      ? 'low'
      : 'medium';
  return {
    risk,
    types,
    // Local checks and the independent review are always required and enforced by the Engine.
    required: ['checks', 'review', ...required],
    // `disabled` is a gap, never a PASS.
    gaps: required.filter(gate => !enabled[gate]).map(gate => ({ gate, reason: 'disabled' })),
  };
}

/** Files larger than this are not inspected; the receipt says so. */
const MAX_INSPECTED_BYTES = 262144;
const MARK = '\u0001';
const languages = {
  ...Object.fromEntries('js mjs cjs jsx ts mts cts tsx'.split(' ').map(ext => [ext, 'js'])),
  py: 'py',
  rs: 'rs',
  go: 'go',
  java: 'java',
  kt: 'java',
};
const languageOf = file => languages[file.slice(file.lastIndexOf('.') + 1).toLowerCase()];
/** A file that names itself a test, whatever its language. */
const namedTest = /\.(?:test|spec)\.[^/]+$|_test\.[^/]+$|(^|\/)test_[^/]+$/i;
const regexAfterWord = /(?:^|[^\w$.])(?:return|typeof|case|in|of|delete|void|throw|new|else|do|await|yield)$/;

/**
 * JS/TS source as code only: comments are removed and every string, template
 * and regex literal becomes a numbered placeholder. So a `/*` inside a string
 * opens no comment, a commented-out test is gone, and test code quoted inside
 * a string (a fixture) is not a test. A scanner, not a parser: enough to find
 * calls and their first argument.
 * @param {string} source
 */
function scanJs(source) {
  const strings = [],
    length = source.length;
  let code = '',
    last = '',
    index = 0;
  const literal = text => {
    strings.push(text);
    last = MARK;
    return `${MARK}${strings.length - 1}${MARK}`;
  };
  while (index < length) {
    const char = source[index],
      next = source[index + 1];
    if (char === '/' && next === '/') {
      while (index < length && source[index] !== '\n') index++;
    } else if (char === '/' && next === '*') {
      const end = source.indexOf('*/', index + 2);
      index = end < 0 ? length : end + 2;
      code += ' ';
    } else if (char === '"' || char === "'") {
      let end = index + 1;
      while (end < length && source[end] !== char && source[end] !== '\n') end += source[end] === '\\' ? 2 : 1;
      code += literal(source.slice(index + 1, end));
      index = end + 1;
    } else if (char === '`') {
      let end = index + 1,
        depth = 0;
      for (; end < length; end++) {
        const inner = source[end];
        if (inner === '\\') end++;
        else if (inner === '`' && depth === 0) break;
        else if (inner === '$' && source[end + 1] === '{') {
          depth++;
          end++;
        } else if (inner === '{' && depth > 0) depth++;
        else if (inner === '}' && depth > 0) depth--;
      }
      code += literal(source.slice(index + 1, end));
      index = end + 1;
    } else if (
      char === '/' &&
      (last === '' || '(,=:[!&|?{};+-*%<>~^'.includes(last) || regexAfterWord.test(code.trimEnd()))
    ) {
      // A regex literal: it may hold quotes and slashes that are not code.
      let end = index + 1,
        inClass = false;
      for (; end < length && source[end] !== '\n'; end++) {
        const inner = source[end];
        if (inner === '\\') end++;
        else if (inner === '[') inClass = true;
        else if (inner === ']') inClass = false;
        else if (inner === '/' && !inClass) break;
      }
      code += literal(source.slice(index + 1, end));
      index = end + 1;
    } else {
      code += char;
      if (!/\s/.test(char)) last = char;
      index++;
    }
  }
  return { code, strings };
}

/** Python source as code only: comments removed, string literals (also triple-quoted) blanked. */
function scanPython(source) {
  const length = source.length;
  let code = '',
    index = 0;
  while (index < length) {
    const char = source[index];
    if (char === '#') {
      while (index < length && source[index] !== '\n') index++;
    } else if (char === '"' || char === "'") {
      const triple = source.startsWith(char.repeat(3), index),
        quote = triple ? char.repeat(3) : char;
      let end = index + quote.length;
      while (end < length && !source.startsWith(quote, end) && (triple || source[end] !== '\n'))
        end += source[end] === '\\' ? 2 : 1;
      code += MARK;
      index = Math.min(length, end + quote.length);
    } else {
      code += char;
      index++;
    }
  }
  return code;
}

/** Call modifiers that still make a test case; anything else (`describe`, `step`, hooks) is not one. */
const jsModifiers = new Set(
  'skip only todo fixme fails failing concurrent serial parallel sequential skipIf runIf'.split(' '),
);
/** Modifiers that keep the case, or every other case, from running. */
const jsSkips = new Set('skip only todo fixme fails failing skipIf runIf'.split(' '));
const jsCall = new RegExp(
  `(?<![.\\w$])(x?)(test|it|specify)((?:\\s*\\.\\s*[A-Za-z]+)*)\\s*\\(\\s*(?:${MARK}(\\d+)${MARK}((?:\\s*,\\s*\\{[^{}]*\\})?)|([A-Za-z_$]))`,
  'g',
);
const jsSubtest = new RegExp(`(?<![\\w$])t\\s*\\.\\s*test\\s*\\(\\s*${MARK}(\\d+)${MARK}`, 'g');
const skipOption = new RegExp(`\\b(?:skip|todo)\\s*:\\s*(?!false\\b)[^\\s,}]`);
const count = (text, pattern) => (text.match(pattern) || []).length;

/**
 * The test cases of one file: `{ name, skipped }` for each case named by a
 * literal, and the number of cases named by an expression. Null for a language
 * this gate does not read.
 * @param {string} file
 * @param {string} source
 */
function casesOf(file, source) {
  const cases = [];
  let dynamic = 0,
    code = source;
  const language = languageOf(file);
  if (language === 'js') {
    const scanned = scanJs(source);
    code = scanned.code;
    for (const match of code.matchAll(jsCall)) {
      const modifiers = match[3]
        .split('.')
        .map(part => part.trim())
        .filter(Boolean);
      if (modifiers.some(modifier => !jsModifiers.has(modifier))) continue;
      if (match[4] === undefined) dynamic++;
      else
        cases.push({
          name: scanned.strings[Number(match[4])],
          skipped:
            match[1] === 'x' || modifiers.some(modifier => jsSkips.has(modifier)) || skipOption.test(match[5] || ''),
        });
    }
    for (const match of code.matchAll(jsSubtest))
      cases.push({ name: scanned.strings[Number(match[1])], skipped: false });
  } else if (language === 'py') {
    code = scanPython(source);
    for (const match of code.matchAll(/((?:^[ \t]*@.*\n)*)^[ \t]*(?:async[ \t]+)?def[ \t]+(test\w*)[ \t]*\(/gm))
      cases.push({ name: match[2], skipped: /@(?:[\w.]*\.)?(?:skip\w*|xfail)\b/i.test(match[1]) });
  } else if (language === 'rs') {
    for (const match of source.matchAll(/((?:#\[[^\]\n]*\]\s*)+)(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+(\w+)/g))
      if (/\btest\b/.test(match[1])) cases.push({ name: match[2], skipped: /\bignore\b/.test(match[1]) });
  } else if (language === 'go') {
    for (const match of source.matchAll(/^func\s+(Test\w+)\s*\(/gm)) cases.push({ name: match[1], skipped: false });
  } else if (language === 'java') {
    for (const match of source.matchAll(
      /@(?:Test|ParameterizedTest|RepeatedTest)\b([\s\S]{0,300}?)\b(?:void|fun)\s+(\w+)\s*\(/g,
    ))
      cases.push({
        name: match[2],
        skipped: /@(?:Disabled|Ignore)\b/.test(source.slice(Math.max(0, match.index - 160), match.index) + match[1]),
      });
  } else return null;
  return {
    cases,
    dynamic,
    assertions: count(code, /\bassert\w*|\bexpect\s*\(/g),
    // Skips called from inside a test body; they cannot be tied to one case without a parser.
    bodySkips: count(
      code,
      /(?<![\w$])(?:t|this|ctx|context)\s*\.\s*(?:skip|todo)\s*\(|\bpytest\.skip\s*\(|\bself\.skipTest\s*\(|\bt\.Skip(?:f|Now)?\(/g,
    ),
  };
}

/** The cases of one revision of a file, or the reason it was not inspected. Never throws. */
async function inspect(cwd, revision, file) {
  let result;
  try {
    result = await execute('git', ['show', `${revision}:${file}`], { cwd, allowFailure: true, rawOutput: true });
  } catch {
    return { reason: 'unreadable' };
  }
  if (result.code !== 0) return { reason: 'unreadable' };
  if (Buffer.byteLength(result.stdout) > MAX_INSPECTED_BYTES) return { reason: 'too_large' };
  return casesOf(file, result.stdout) ?? { reason: 'unsupported_language' };
}

/** Changed files between base and head as `{ status, from, to }`, renames followed. */
async function changes(cwd, baseSha, headSha) {
  const output = (await execute('git', ['diff', '--name-status', '-M', '-z', `${baseSha}...${headSha}`], { cwd }))
    .stdout;
  const fields = output.split('\0').filter(Boolean),
    rows = [];
  for (let index = 0; index < fields.length;) {
    const status = fields[index++][0];
    const from = fields[index++];
    const to = status === 'R' || status === 'C' ? fields[index++] : from;
    rows.push({ status, from, to });
  }
  return rows;
}

const listNames = names =>
  `${names
    .slice(0, 5)
    .map(name => JSON.stringify(String(name).slice(0, 80)))
    .join(', ')}${names.length > 5 ? `, and ${names.length - 5} more` : ''}`;

/**
 * Tests that existed on the base and were removed or switched off.
 *
 * Cases are compared by name across all changed test files: a case that moved
 * to another file, or a file that was split or renamed, is still there; a case
 * whose name is gone is removed, whatever was added in its place. Comments and
 * string contents are not code, so a commented-out test is a removed one. A
 * case that gains a skip (`.skip`, `.only`, `.todo`, `xit`, an options object
 * with `skip:`, a skip decorator or attribute) is switched off.
 *
 * What it cannot see is in the docs: a body emptied under the same name, an
 * early `return`, a skip called inside the body, a renamed case (reported as
 * removed).
 * @param {{ cwd: string, baseSha: string, headSha: string, allowed?: string[] }} input
 *   `allowed`: test paths this run may delete or reduce.
 */
export async function testWeakening({ cwd, baseSha, headSha, allowed = [] }) {
  const base = [],
    head = [],
    unchecked = [],
    findings = [],
    permitted = [],
    warnings = [];
  const report = finding =>
    (finding.rule !== 'test_skipped' && ownsPath(allowed, finding.file) ? permitted : findings).push(finding);
  for (const { status, from, to } of await changes(cwd, baseSha, headSha)) {
    // A test renamed to a path no runner would pick up is gone.
    const gone = status === 'D' || !isTestFile(to);
    if (status !== 'A' && status !== 'C' && isTestFile(from)) {
      const before = await inspect(cwd, baseSha, from);
      if (!before.reason)
        base.push({ file: from, at: gone ? from : to, gone, renamedTo: status === 'D' ? null : to, ...before });
      else if (before.reason !== 'unsupported_language' || namedTest.test(from)) {
        unchecked.push({ file: from, reason: before.reason });
        // A removed test file is a removed test even when its cases could not be read.
        if (gone && languageOf(from))
          report({ rule: 'test_deleted', file: from, detail: `removed and not inspected (${before.reason})` });
      }
    }
    if (status !== 'D' && isTestFile(to)) {
      const after = await inspect(cwd, headSha, to);
      if (!after.reason) head.push({ file: to, ...after });
      else if (after.reason !== 'unsupported_language' || namedTest.test(to))
        unchecked.push({ file: to, reason: after.reason });
    }
  }
  const tally = (entries, pick = _item => true) => {
    const names = new Map();
    for (const entry of entries)
      for (const item of entry.cases) if (pick(item)) names.set(item.name, (names.get(item.name) ?? 0) + 1);
    return names;
  };
  // Every base case must still exist somewhere among the changed test files.
  const remaining = tally(head);
  for (const entry of base) {
    const removed = [];
    for (const { name } of entry.cases) {
      const left = remaining.get(name) ?? 0;
      if (left > 0) remaining.set(name, left - 1);
      else removed.push(name);
    }
    if (removed.length)
      report(
        entry.gone
          ? {
              rule: 'test_deleted',
              file: entry.file,
              detail: `${entry.renamedTo ? `renamed to ${entry.renamedTo}, which no test runner picks up; ` : ''}${removed.length} test cases are gone: ${listNames(removed)}`,
            }
          : {
              rule: 'tests_removed',
              // The base path: it is what a permission names, and Git may pair a deleted file with a new one.
              file: entry.file,
              detail: `${entry.at === entry.file ? '' : `now ${entry.at}; `}test cases removed: ${listNames(removed)}`,
            },
      );
  }
  const dynamic = entries => entries.reduce((total, entry) => total + entry.dynamic, 0);
  if (dynamic(head) < dynamic(base)) {
    const entry = base.find(item => item.dynamic > 0);
    report({
      rule: 'tests_removed',
      file: entry.at,
      detail: `cases named by an expression: ${dynamic(base)} -> ${dynamic(head)} across changed tests`,
    });
  }
  // An existing case that gained a skip. A new case that is born skipped is not weakening.
  const known = tally(base),
    skippedBefore = tally(base, item => item.skipped);
  for (const entry of head) {
    const names = [...new Set(entry.cases.filter(item => item.skipped).map(item => item.name))].filter(
      name =>
        known.has(name) &&
        tally([entry], item => item.skipped && item.name === name).get(name) > (skippedBefore.get(name) ?? 0),
    );
    if (names.length) report({ rule: 'test_skipped', file: entry.file, detail: `switched off: ${listNames(names)}` });
  }
  // A skip call added to a file that gained no case was added to an existing test.
  const sameFile = new Map(base.filter(entry => !entry.gone).map(entry => [entry.at, entry]));
  for (const entry of head) {
    const before = sameFile.get(entry.file);
    if (!before || entry.bodySkips <= before.bodySkips || entry.dynamic > before.dynamic) continue;
    const names = new Set(before.cases.map(item => item.name));
    if (entry.cases.every(item => names.has(item.name)))
      report({
        rule: 'test_skipped',
        file: entry.file,
        detail: `skip calls inside existing tests ${before.bodySkips} -> ${entry.bodySkips}`,
      });
  }
  const total = (entries, field) =>
    entries.reduce((sum, entry) => sum + (field ? entry[field] : entry.cases.length), 0);
  if (total(head, 'assertions') < total(base, 'assertions') && total(head) <= total(base))
    warnings.push({
      rule: 'assertions_removed',
      file: null,
      detail: `assertions ${total(base, 'assertions')} -> ${total(head, 'assertions')} across changed tests`,
    });
  return { findings, allowed: permitted, warnings, unchecked };
}

/** Findings a repair session cannot fix: only a person can change the configuration. */
const unrepairable = new Set(['required_gate_disabled']);

/** Run one oracle; a crash or a timeout is a failure with its own evidence. */
async function runOracle(oracle, { cwd, signal, secrets, runner, persist }) {
  let exitCode = null,
    reason,
    output;
  try {
    const result = await runner(oracle.command, oracle.args, {
      cwd,
      signal,
      env: workerEnvironment(),
      secrets,
      timeoutMs: oracle.timeoutMs,
      allowFailure: true,
    });
    exitCode = result.code;
    output = (result.stdout + result.stderr).slice(-24000);
  } catch (error) {
    if (signal?.aborted || error.code === 'cancelled') throw error;
    // An oracle that did not finish proves nothing: it is a failure, not a pass.
    reason = ['timeout', 'ENOENT', 'EACCES', 'EPERM'].includes(error.code) ? error.code : 'execution_failed';
    output = `not completed: ${reason}`;
  }
  const evidence = persist
    ? await persist('oracle', { id: oracle.id, command: oracle.command, args: oracle.args, exitCode, output })
    : null;
  return {
    receipt: {
      id: oracle.id,
      status: exitCode === 0 ? 'passed' : 'failed',
      ...(reason ? { reason } : {}),
      exitCode,
      ...(evidence ? { outputPath: evidence.path, outputHash: evidence.sha256 } : {}),
    },
    detail: reason ? `${oracle.id}: ${reason}` : `${oracle.id} exit ${exitCode}: ${output.slice(-2000)}`,
  };
}

/**
 * Run the behaviour gate on a clean checkout of `headSha`.
 * @param {{ cwd: string, headSha: string, baseSha: string, config: Record<string, any>, signal?: AbortSignal,
 *   secrets?: Record<string, string>, runner?: typeof execute, isClean?: () => Promise<boolean>,
 *   persist?: (kind: string, value: any) => Promise<{ sha256: string, path: string }> }} input
 */
export async function runBehaviorGate({
  cwd,
  headSha,
  baseSha,
  config,
  signal,
  secrets = {},
  runner = execute,
  isClean,
  persist,
}) {
  const verification = normalizeVerificationConfig(config.verification);
  const rows = await changes(cwd, baseSha, headSha);
  const paths = [...new Set(rows.flatMap(row => [row.from, row.to]))].sort();
  const policy = qualityPolicy({ types: classifyChange(paths), config, verification });
  const findings = [],
    allowed = [],
    warnings = [],
    unchecked = [];
  if (verification.strictGates)
    for (const gap of policy.gaps)
      findings.push({
        rule: 'required_gate_disabled',
        file: null,
        detail: `${gap.gate} gate is required for this change`,
      });
  if (verification.testProtection) {
    const tests = await testWeakening({ cwd, baseSha, headSha, allowed: verification.testRemovalAllowed });
    findings.push(...tests.findings);
    // Removals this run was explicitly allowed; the receipt still shows them.
    allowed.push(...tests.allowed);
    warnings.push(...tests.warnings);
    unchecked.push(...tests.unchecked);
  }
  const oracles = [];
  for (const oracle of verification.oracles) {
    // An implementation may not edit the oracle that judges it.
    const touched = paths.filter(file => ownsPath(oracle.protect, file));
    for (const file of touched)
      findings.push({ rule: 'oracle_modified', file, detail: `protected by oracle ${oracle.id}` });
    if (touched.length) {
      oracles.push({ id: oracle.id, status: 'not_run', reason: 'oracle_modified', exitCode: null });
      continue;
    }
    const { receipt, detail } = await runOracle(oracle, { cwd, signal, secrets, runner, persist });
    oracles.push(receipt);
    if (receipt.status !== 'passed') findings.push({ rule: 'oracle_failed', file: null, detail });
    // An oracle observes; one that changes the checked tree invalidates everything after it.
    if (isClean && !(await isClean())) {
      findings.push({ rule: 'oracle_dirty_worktree', file: null, detail: `${oracle.id} changed the checked worktree` });
      break;
    }
  }
  return {
    schemaVersion: BEHAVIOR_GATE_VERSION,
    headSha,
    baseSha,
    configHash: verificationConfigHash(config.verification),
    status: findings.length ? 'failed' : 'passed',
    passed: findings.length === 0,
    // Nothing a repair session could change: the run stops for a person instead of spending sessions.
    // One finding only a person can fix means no repair can make the gate pass.
    repairable: !findings.some(finding => unrepairable.has(finding.rule)),
    policy,
    findings,
    allowed,
    warnings,
    unchecked,
    oracles,
  };
}

/**
 * A receipt counts only for the exact head, base and verification configuration it was made for.
 * @param {any} receipt
 * @param {{ headSha?: string, baseSha?: string, config?: Record<string, any> }} [current]
 */
export function isCurrentBehaviorReceipt(receipt, { headSha, baseSha, config } = {}) {
  return (
    receipt?.schemaVersion === BEHAVIOR_GATE_VERSION &&
    typeof headSha === 'string' &&
    receipt.headSha === headSha &&
    receipt.baseSha === baseSha &&
    receipt.configHash === verificationConfigHash(config?.verification) &&
    receipt.passed === true &&
    receipt.status === 'passed' &&
    Array.isArray(receipt.findings) &&
    receipt.findings.length === 0
  );
}

/**
 * Compare final check results with the baseline taken on the base commit.
 * A failure that already existed is labelled, never ignored.
 * @param {{ results: { kind: string, command: any, exitCode: number | null }[] } | null | undefined} baseline
 * @param {{ kind: string, command: any, exitCode: number | null }[]} results
 */
export function compareWithBaseline(baseline, results) {
  if (!baseline || !Array.isArray(baseline.results)) return null;
  const key = row => JSON.stringify([row.kind, row.command]);
  const before = new Map(baseline.results.map(row => [key(row), row]));
  return results.map(row => {
    const base = before.get(key(row));
    const failed = row.exitCode !== 0,
      failedBefore = base ? base.exitCode !== 0 : null;
    // A baseline command that did not finish says nothing about the base.
    const classification =
      !base || base.exitCode === null
        ? 'no_baseline'
        : failed
          ? failedBefore
            ? 'pre_existing'
            : 'regression'
          : failedBefore
            ? 'fixed'
            : 'unchanged';
    return {
      kind: row.kind,
      command: row.command,
      baseline: base ? base.exitCode : null,
      final: row.exitCode,
      classification,
    };
  });
}
