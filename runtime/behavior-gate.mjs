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
const regexKeywords = new Set('return typeof case in of delete void throw new else do await yield'.split(' '));

/**
 * Remembers the last code token, to tell a regex literal from a division.
 * Constant work per character, so a scan stays linear in the file size.
 */
function lastToken() {
  let last = '',
    word = '',
    dotted = false,
    gap = false;
  return {
    literal() {
      last = MARK;
      word = '';
      gap = false;
    },
    code(char) {
      if (/\s/.test(char)) {
        gap = true;
        return;
      }
      if (/[\w$]/.test(char)) {
        if (gap || !word) {
          dotted = last === '.';
          word = '';
        }
        // No keyword is this long; a longer word only has to stay a non-keyword.
        if (word.length < 12) word += char;
      } else word = '';
      last = char;
      gap = false;
    },
    // Not after `<`: there a slash closes a JSX tag far more often than it opens a regex literal.
    // Nor in `} />`: that ends a JSX tag whose last attribute is an expression.
    regexAllowed: next =>
      last === '' ||
      ('(,=:[!&|?{};+-*%>~^'.includes(last) && !(last === '}' && next === '>')) ||
      (!dotted && regexKeywords.has(word)),
  };
}

/** Index of the quote that closes the string opened at `start`, or of the end of its line. */
function quoteEnd(source, start) {
  const quote = source[start];
  let end = start + 1;
  while (end < source.length && source[end] !== quote && source[end] !== '\n') end += source[end] === '\\' ? 2 : 1;
  return end;
}

/** Index of the slash that closes the regex literal opened at `start`, or of the end of its line. */
function regexEnd(source, start) {
  let end = start + 1,
    inClass = false;
  for (; end < source.length && source[end] !== '\n'; end++) {
    const inner = source[end];
    if (inner === '\\') end++;
    else if (inner === '[') inClass = true;
    else if (inner === ']') inClass = false;
    else if (inner === '/' && !inClass) break;
  }
  return end;
}

/** Where the code continues after the comment that opens at `index`. */
function commentEnd(source, index) {
  const line = source[index + 1] === '/';
  const end = source.indexOf(line ? '\n' : '*/', index + 2);
  if (end < 0) return source.length;
  return line ? end : end + 2;
}

/**
 * Index of the backtick that closes the template literal opened at `start`.
 * Inside `${…}` the text is code again: its strings, comments, regex literals
 * and nested templates are stepped over, so a brace or a backtick inside them
 * closes nothing.
 */
function templateEnd(source, start) {
  const length = source.length,
    depths = [], // brace depth of every open `${`, innermost last
    seen = lastToken();
  // Open templates. The scan is in template text while there are fewer open `${` than templates.
  let open = 1,
    index = start + 1;
  while (index < length) {
    const char = source[index],
      next = source[index + 1];
    if (depths.length < open) {
      if (char === '\\') index += 2;
      else if (char === '`') {
        open--;
        if (open === 0) return index;
        seen.literal();
        index++;
      } else if (char === '$' && next === '{') {
        depths.push(0);
        seen.code('{');
        index += 2;
      } else index++;
    } else if (char === '`') {
      open++;
      index++;
    } else if (char === '"' || char === "'") {
      index = quoteEnd(source, index) + 1;
      seen.literal();
    } else if (char === '/' && (next === '/' || next === '*')) index = commentEnd(source, index);
    else if (char === '/' && seen.regexAllowed(next)) {
      index = regexEnd(source, index) + 1;
      seen.literal();
    } else {
      if (char === '{') depths[depths.length - 1] += 1;
      else if (char === '}') {
        if (depths[depths.length - 1] === 0) depths.pop();
        else depths[depths.length - 1] -= 1;
      }
      seen.code(char);
      index++;
    }
  }
  return length;
}

/**
 * JS/TS source as code only: comments are removed and every string, template
 * and regex literal becomes a numbered placeholder. So a `/*` inside a string
 * opens no comment, a commented-out test is gone, and test code quoted inside
 * a string (a fixture) is not a test. A scanner, not a parser: enough to find
 * calls, their first argument and where a call ends.
 * @param {string} source
 */
function scanJs(source) {
  const strings = [],
    length = source.length,
    seen = lastToken();
  let code = '',
    index = 0;
  const literal = (start, end) => {
    strings.push(source.slice(start + 1, end));
    seen.literal();
    code += `${MARK}${strings.length - 1}${MARK}`;
    return end + 1;
  };
  while (index < length) {
    const char = source[index],
      next = source[index + 1];
    if (char === '/' && (next === '/' || next === '*')) {
      index = commentEnd(source, index);
      if (next === '*') code += ' ';
    } else if (char === '"' || char === "'") index = literal(index, quoteEnd(source, index));
    else if (char === '`') index = literal(index, templateEnd(source, index));
    else if (char === '/' && seen.regexAllowed(next)) index = literal(index, regexEnd(source, index));
    else {
      code += char;
      seen.code(char);
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

/** Call modifiers that still make a test case or a group; anything else (`each`, `step`, hooks) is not one. */
const jsModifiers = new Set(
  'skip only todo fixme fails failing concurrent serial parallel sequential skipIf runIf'.split(' '),
);
/** Modifiers that keep the case, or every case of the group, from running. */
const jsSkips = new Set('skip todo fixme fails failing skipIf runIf'.split(' '));
const jsGroups = new Set(['describe', 'suite', 'context']);
/** A case or a group up to its opening parenthesis. Every repetition is bounded: the scan stays linear. */
const jsCall = /(?<![.\w$])(x?)(test|it|specify|describe|suite|context)((?:\s*\.\s*[A-Za-z]+){0,4})\s*\(/g;
const jsOpen = /\s*\(/y;
/** The first argument: a literal name with an optional options object, or the start of an expression. */
const jsName = new RegExp(`\\s*(?:${MARK}(\\d+)${MARK}((?:\\s*,\\s*\\{[^{}]{0,2000}\\})?)|([A-Za-z_$]))`, 'y');
const jsSubtest = new RegExp(
  `(?<![\\w$])t\\s*\\.\\s*test\\s*\\(\\s*${MARK}(\\d+)${MARK}((?:\\s*,\\s*\\{[^{}]{0,2000}\\})?)`,
  'g',
);
/** `skip: <anything but false>`, `todo: …`, or the shorthand `{ skip }`. */
const skipOption = /\b(?:skip|todo)\s*(?:[,}]|:\s*(?!false\b)[^\s,}])/;
const count = (text, pattern) => (text.match(pattern) || []).length;
/** `'it\'s'` and `"it's"` are the same name. */
const unescapeQuotes = name => name.replace(/\\(['"`])/g, '$1');

/** Index of the `)` that closes the call whose arguments start at `from`, or -1 within `limit` characters. */
function callEnd(code, from, limit = code.length) {
  const stop = Math.min(code.length, from + limit);
  let depth = 1;
  for (let index = from; index < stop; index++) {
    if (code[index] === '(') depth++;
    else if (code[index] === ')') {
      depth--;
      if (depth === 0) return index;
    }
  }
  return -1;
}

/**
 * JS/TS cases. A case is switched off by its own modifier or options, or by a
 * group around it (`describe.skip`, `xdescribe`, `describe('…', { skip: true })`,
 * Playwright `test.describe.skip`). `.only` on a case or a group is counted:
 * it stops the other tests of the file.
 * @param {string} source
 */
function jsCases(source) {
  const { code, strings } = scanJs(source),
    cases = [],
    off = []; // [start, end] of the groups that are switched off: in source order, never nested
  let dynamic = 0,
    onlys = 0,
    bodySkips = 0;
  const inside = index => off.length > 0 && index < off[off.length - 1][1];
  for (const match of code.matchAll(jsCall)) {
    const modifiers = match[3]
      .split('.')
      .map(part => part.trim())
      .filter(Boolean);
    let group = jsGroups.has(match[2]);
    if (!group && modifiers[0] === 'describe') {
      group = true;
      modifiers.shift();
    }
    if (modifiers.some(modifier => !jsModifiers.has(modifier))) continue;
    let from = match.index + match[0].length;
    if (['skipIf', 'runIf'].includes(modifiers[modifiers.length - 1])) {
      // `test.skipIf(condition)('name', …)`: the name is in the second call.
      const end = callEnd(code, from, 2000);
      jsOpen.lastIndex = end + 1;
      if (end < 0 || !jsOpen.test(code)) continue;
      from = jsOpen.lastIndex;
    }
    jsName.lastIndex = from;
    const name = jsName.exec(code);
    const switchedOff = match[1] === 'x' || modifiers.some(modifier => jsSkips.has(modifier));
    if (!name) {
      // `test.fixme()` or `test.skip(!isMobile, 'why')` inside a body (Playwright): a skip call without a name.
      if (switchedOff && !group) bodySkips++;
      continue;
    }
    const only = modifiers.includes('only'),
      skipped = switchedOff || skipOption.test(name[2] ?? '');
    if (only) onlys++;
    if (group) {
      if (skipped && !inside(match.index)) {
        const end = callEnd(code, from);
        off.push([match.index, end < 0 ? code.length : end]);
      }
    } else if (name[1] === undefined) {
      // `test.skip(condition, 'why')` inside a body (Playwright) is a skip call, not a case.
      if (skipped) bodySkips++;
      else dynamic++;
    } else
      cases.push({
        name: unescapeQuotes(strings[Number(name[1])]),
        skipped: skipped || only || inside(match.index),
      });
  }
  let range = 0;
  for (const match of code.matchAll(jsSubtest)) {
    while (range < off.length && off[range][1] < match.index) range++;
    cases.push({
      name: unescapeQuotes(strings[Number(match[1])]),
      skipped: skipOption.test(match[2]) || (range < off.length && off[range][0] <= match.index),
    });
  }
  return { code, cases, dynamic, onlys, bodySkips };
}

const pySkip = /^@(?:[\w.]*\.)?(?:skip\w*|xfail|expectedFailure)\b/i;
const brackets = text => count(text, /[([{]/g) - count(text, /[)\]}]/g);

/**
 * Python cases, read line by line. A skip decorator on a class covers the
 * tests in it. `pytestmark` with a skip covers the whole file at module level
 * and the whole class when it stands directly in a class body; it may be a
 * list over several lines.
 * @param {string} source
 */
function pythonCases(source) {
  const code = scanPython(source),
    cases = [],
    classes = [];
  let decorators = [],
    pending = 0,
    mark = null,
    moduleSkip = false;
  const applyMark = () => {
    if (/\b(?:skip\w*|xfail)\b/i.test(mark.text)) {
      const owner = classes[classes.length - 1];
      if (mark.indent === 0) moduleSkip = true;
      else if (owner && owner.body === mark.indent) {
        // Directly in a class body: the mark covers the class, also the tests above the line.
        owner.skipped = true;
        for (let index = owner.from; index < cases.length; index++) cases[index].skipped = true;
      }
    }
    mark = null;
  };
  for (const raw of code.split('\n')) {
    const text = raw.trim();
    if (!text) continue;
    if (pending > 0) {
      // A decorator, a class header or a `pytestmark` list that continues over several lines.
      pending += brackets(text);
      if (mark) {
        mark.text += ` ${text}`;
        if (pending <= 0) applyMark();
      }
      continue;
    }
    const indent = raw.length - raw.trimStart().length;
    while (classes.length && classes[classes.length - 1].indent >= indent) classes.pop();
    const inner = classes[classes.length - 1];
    if (inner && inner.body === undefined) inner.body = indent;
    if (text.startsWith('@')) {
      decorators.push(text);
      pending = brackets(text);
      continue;
    }
    const skipped = decorators.some(line => pySkip.test(line)) || classes.some(item => item.skipped);
    const named = /^(?:async\s+)?def\s+(test\w*)\s*\(/.exec(text);
    if (/^class\s/.test(text)) {
      classes.push({ indent, skipped, from: cases.length });
      pending = brackets(text);
    } else if (named) cases.push({ name: named[1], skipped });
    else if (/^pytestmark\s*(?::[^=]*)?=/.test(text)) {
      mark = { text, indent };
      pending = brackets(text);
      if (pending <= 0) applyMark();
    }
    decorators = [];
  }
  return { code, cases: moduleSkip ? cases.map(item => ({ ...item, skipped: true })) : cases };
}

const rustAttribute = /\s*#\[[^\]\n]*\]/y;
const rustFn = /\s*(?:pub(?:\([^)\n]*\))?\s+)?(?:(?:async|unsafe|const)\s+)*fn\s+(\w+)/y;

/** Rust tests by line: attributes, also over several lines and with comments between, then the function. */
function rustCases(source) {
  const cases = [];
  let attributes = '';
  for (const line of source.split('\n')) {
    const text = line.trim();
    if (!text || text.startsWith('//')) continue;
    let at = 0;
    rustAttribute.lastIndex = 0;
    for (let found = rustAttribute.exec(line); found; found = rustAttribute.exec(line)) {
      attributes += found[0];
      at = rustAttribute.lastIndex;
    }
    // Attributes only: the function is on a later line.
    if (at > 0 && !line.slice(at).trim()) continue;
    rustFn.lastIndex = at;
    const named = rustFn.exec(line);
    if (named && /\btest\b/.test(attributes)) cases.push({ name: named[1], skipped: /\bignore\b/.test(attributes) });
    attributes = '';
  }
  return cases;
}

/** Where the code continues after the block comment that opens at `index`. Kotlin comments nest. */
function blockCommentEnd(source, index, nested) {
  if (!nested) return commentEnd(source, index);
  let depth = 0,
    at = index;
  while (at < source.length) {
    if (source[at] === '/' && source[at + 1] === '*') {
      depth++;
      at += 2;
    } else if (source[at] === '*' && source[at + 1] === '/') {
      depth--;
      at += 2;
      if (depth === 0) return at;
    } else at++;
  }
  return source.length;
}

/**
 * Java and Kotlin source as code only: string and character literals are
 * emptied, comments are removed. One pass over the text.
 * @param {string} source
 * @param {boolean} kotlin Block comments nest.
 */
function scanJava(source, kotlin) {
  const length = source.length;
  let code = '',
    index = 0;
  while (index < length) {
    const char = source[index],
      next = source[index + 1];
    if (char === '/' && (next === '/' || next === '*')) {
      index = next === '*' ? blockCommentEnd(source, index, kotlin) : commentEnd(source, index);
      code += ' ';
    } else if (char === '"' && source.startsWith('"""', index)) {
      // A text block or a raw string: it may span lines.
      const end = source.indexOf('"""', index + 3);
      index = end < 0 ? length : end + 3;
      code += '""';
    } else if (char === '"') {
      const end = quoteEnd(source, index);
      index = source[end] === '"' ? end + 1 : end;
      code += '""';
    } else if (char === "'") {
      // A character literal is a few characters long ('a', '\n', 'A'). The look-ahead is
      // bounded, so a file of apostrophes costs no more than its length; anything else stays as it is.
      let end = index + (next === '\\' ? 3 : 2);
      while (end <= index + 8 && end < length && source[end] !== "'" && source[end] !== '\n') end++;
      const literal = end <= index + 8 && source[end] === "'";
      index = literal ? end + 1 : index + 1;
      code += literal ? "''" : char;
    } else {
      code += char;
      index++;
    }
  }
  return code;
}

const javaTests = new Set(['Test', 'ParameterizedTest', 'RepeatedTest']);
const javaOffs = new Set(['Disabled', 'Ignore']);
const isWord = char => char !== undefined && /[\w$]/.test(char);
const isSpace = char => char !== undefined && /\s/.test(char);
/** How far a name in backticks or a `<…>` list is looked for: both are short. */
const JAVA_LOOKAHEAD = 200;

/**
 * Java and Kotlin tests, read token by token in one pass; no pattern is
 * matched against the text, so there is nothing to backtrack over.
 *
 * The annotations seen since the last `;`, `{`, `}` or declaration belong to
 * the next `void name(` or `fun name(`: with `@Test` it is a case, with
 * `@Disabled` or `@Ignore` a switched-off one. The same annotations before
 * `class` or `object` are read as covering every test of the file.
 * @param {string} source
 * @param {boolean} kotlin
 */
function javaCases(source, kotlin) {
  const code = scanJava(source, kotlin),
    length = code.length,
    cases = [];
  let test = false,
    off = false,
    classOff = false,
    last = '',
    index = 0;
  const forget = () => {
    test = false;
    off = false;
  };
  const afterSpace = at => {
    while (isSpace(code[at])) at++;
    return at;
  };
  const wordEnd = at => {
    while (isWord(code[at])) at++;
    return at;
  };
  /** The name that follows `void` or `fun`, with the position after it: `[name, at]`. */
  const nameAt = from => {
    let at = afterSpace(from);
    if (code[at] === '<') {
      // Type parameters: `fun <T> name(`.
      const stop = Math.min(length, at + JAVA_LOOKAHEAD);
      while (at < stop && code[at] !== '>') at++;
      at = afterSpace(at + 1);
    }
    if (code[at] === '`') {
      const stop = Math.min(length, at + JAVA_LOOKAHEAD);
      let end = at + 1;
      while (end < stop && code[end] !== '`' && code[end] !== '\n') end++;
      return code[end] === '`' ? [code.slice(at + 1, end), end + 1] : ['', at + 1];
    }
    const end = wordEnd(at);
    return [code.slice(at, end), Math.max(end, at)];
  };
  while (index < length) {
    const char = code[index];
    if (char === '@') {
      // A qualified name or a Kotlin use-site target (`@field:Disabled`): the last part names the annotation.
      let end = wordEnd(index + 1);
      while ((code[end] === '.' || code[end] === ':') && isWord(code[end + 1])) end = wordEnd(end + 1);
      let start = end;
      while (start > index + 1 && isWord(code[start - 1])) start--;
      const name = code.slice(start, end);
      if (javaTests.has(name)) test = true;
      else if (javaOffs.has(name)) off = true;
      // Its arguments are not code of the class: skipped whole, whatever they hold.
      const open = afterSpace(end);
      if (code[open] === '(') {
        const close = callEnd(code, open + 1);
        index = close < 0 ? length : close + 1;
      } else index = end;
      last = '@';
    } else if (isWord(char)) {
      const end = wordEnd(index),
        word = code.slice(index, end);
      index = end;
      if (word === 'void' || word === 'fun') {
        const [name, at] = nameAt(end);
        if (test && name && code[afterSpace(at)] === '(') cases.push({ name, skipped: off });
        index = at;
        forget();
      } else if ((word === 'class' || word === 'object') && last !== '.' && last !== ':') {
        if (off) classOff = true;
        forget();
      } else if (word === 'val' || word === 'var') forget();
      // Modifiers, return types and other words between the annotations and the declaration keep them.
      last = 'w';
    } else {
      if (char === ';' || char === '{' || char === '}') forget();
      if (!isSpace(char)) last = char;
      index++;
    }
  }
  return classOff ? cases.map(item => ({ ...item, skipped: true })) : cases;
}

/**
 * The test cases of one file: `{ name, skipped }` for each case named by a
 * literal, the number of cases named by an expression and of `.only` calls.
 * Null for a language this gate does not read.
 * @param {string} file
 * @param {string} source
 */
function casesOf(file, source) {
  const language = languageOf(file);
  let parsed;
  if (language === 'js') parsed = jsCases(source);
  else if (language === 'py') parsed = pythonCases(source);
  else if (language === 'rs') parsed = { cases: rustCases(source) };
  else if (language === 'go')
    parsed = {
      cases: [...source.matchAll(/^func\s+(Test\w+)\s*\(/gm)].map(match => ({ name: match[1], skipped: false })),
    };
  else if (language === 'java') parsed = { cases: javaCases(source, file.toLowerCase().endsWith('.kt')) };
  else return null;
  const code = parsed.code ?? source;
  return {
    cases: parsed.cases,
    dynamic: parsed.dynamic ?? 0,
    onlys: parsed.onlys ?? 0,
    assertions: count(code, /\bassert\w*|\bexpect\s*\(/g),
    // Skips called from inside a test body; they cannot be tied to one case without a parser.
    bodySkips:
      (parsed.bodySkips ?? 0) +
      count(
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

/** How many cases carry each name, over the given files. */
function tally(entries, pick = _item => true) {
  const names = new Map();
  for (const entry of entries)
    for (const item of entry.cases) if (pick(item)) names.set(item.name, (names.get(item.name) ?? 0) + 1);
  return names;
}

/** `test_skipped` findings: cases switched off, `.only` added, skip calls added inside existing tests. */
function skipFindings(base, head) {
  const found = [];
  // A case that ran on the base and runs in fewer places now, with a switched-off copy here. A new
  // case born skipped is not weakening, and neither is a skipped namesake of a case that still runs.
  const known = tally(base),
    activeBefore = tally(base, item => !item.skipped),
    activeAfter = tally(head, item => !item.skipped);
  for (const entry of head) {
    const names = [...new Set(entry.cases.filter(item => item.skipped).map(item => item.name))].filter(
      name => (activeAfter.get(name) ?? 0) < (activeBefore.get(name) ?? 0),
    );
    if (names.length)
      found.push({ rule: 'test_skipped', file: entry.file, detail: `switched off: ${listNames(names)}` });
  }
  const sameFile = new Map(base.filter(entry => !entry.gone).map(entry => [entry.at, entry]));
  // `.only` on a case or a group stops the other tests of the file. A file of new tests only is left alone.
  for (const entry of head) {
    const before = sameFile.get(entry.file)?.onlys ?? 0;
    if (
      entry.onlys > before &&
      entry.cases.some(item => known.has(item.name)) &&
      !found.some(item => item.rule === 'test_skipped' && item.file === entry.file)
    )
      found.push({
        rule: 'test_skipped',
        file: entry.file,
        detail: `focused with .only ${before} -> ${entry.onlys}: the other tests of the file stop running`,
      });
  }
  // A skip call added to a file that gained no case was added to an existing test.
  for (const entry of head) {
    const before = sameFile.get(entry.file);
    if (!before || entry.bodySkips <= before.bodySkips || entry.dynamic > before.dynamic) continue;
    const names = new Set(before.cases.map(item => item.name));
    if (entry.cases.every(item => names.has(item.name)))
      found.push({
        rule: 'test_skipped',
        file: entry.file,
        detail: `skip calls inside existing tests ${before.bodySkips} -> ${entry.bodySkips}`,
      });
  }
  return found;
}

/**
 * Tests that existed on the base and were removed or switched off.
 *
 * Cases are compared by name across all changed test files: a case that moved
 * to another file, or a file that was split or renamed, is still there; a case
 * whose name is gone is removed, whatever was added in its place. Comments and
 * string contents are not code, so a commented-out test is a removed one. A
 * case that ran on the base and no longer does is switched off: by its own
 * skip (`.skip`, `.only`, `.todo`, `xit`, an options object with `skip:`, a
 * decorator or attribute) or by one on its group, class or module
 * (`describe.skip`, `xdescribe`, a decorator on a class, `pytestmark`).
 * `.only` added to a file with existing tests stops the others.
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
  // Every base case must still exist among the changed test files. A case is first looked for
  // in its own file, and only what is missing there can have moved: with the same name in two
  // files, the file that lost the case is the one reported, and the one a permission must name.
  const pools = new Map(head.map(entry => [entry.file, tally([entry])]));
  const take = (pool, name) => {
    const left = pool?.get(name) ?? 0;
    if (left > 0) pool.set(name, left - 1);
    return left > 0;
  };
  const missing = base.map(entry =>
    entry.cases.map(item => item.name).filter(name => !take(pools.get(entry.at), name)),
  );
  const moved = name => [...pools.values()].some(pool => take(pool, name));
  for (const [index, entry] of base.entries()) {
    const removed = missing[index].filter(name => !moved(name));
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
  skipFindings(base, head).forEach(report);
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
