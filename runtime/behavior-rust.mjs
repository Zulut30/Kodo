/** Rust support of the behaviour gate.
 *
 * 1. A lexer and a token reader that find `#[test]` functions wherever they
 *    are, named as libtest names them (`cargo test -- --list`).
 * 2. The weak-test check: a changed test that cannot fail. Precision before
 *    reach: only unambiguous forms are refused.
 * 3. The test registry: the test executables Cargo builds, listed by libtest
 *    on the base and on the head, compared as a multiset of
 *    (package, target kind, target, test name).
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import path from 'node:path';
import { execute } from './command.mjs';
import { ownsPath } from './contracts.mjs';
import { stateHome, workerEnvironment } from './security.mjs';
import { withWorktreeLock } from './workspace.mjs';

const startPattern = /[\p{XID_Start}_]/u;
const wordPattern = /\p{XID_Continue}/u;
const isStart = char => char !== undefined && startPattern.test(char);
const isWord = char => char !== undefined && wordPattern.test(char);
const identifierPattern = /^(?:r#)?[\p{XID_Start}_]\p{XID_Continue}*$/u;
const isIdentifier = token => token !== undefined && identifierPattern.test(token);

/** A short fingerprint of a literal: equal literals stay equal, different ones differ. */
function fingerprint(text) {
  let value = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    value ^= text.charCodeAt(index);
    value = Math.imul(value, 0x01000193) >>> 0;
  }
  return value.toString(16).padStart(8, '0');
}

/** Index after the `"` that closes the string whose text starts at `at`; escapes are stepped over. */
function stringEnd(source, at) {
  while (at < source.length) {
    if (source[at] === '\\') at += 2;
    else if (source[at] === '"') return at + 1;
    else at++;
  }
  return source.length;
}

/**
 * Index after the character literal that opens at `index` (`'a'`, `'\n'`, `'\''`,
 * `'\u{1F600}'`, `'😀'`), or -1 for a lifetime or a label (`'a`, `'outer:`). The
 * look-ahead is bounded, so a file of apostrophes costs no more than its length.
 */
function charEnd(source, index) {
  const next = source[index + 1];
  if (next === undefined || next === '\n' || next === "'") return -1;
  if (next === '\\') {
    let end = index + 3;
    const stop = Math.min(source.length, index + 14);
    while (end < stop && source[end] !== "'" && source[end] !== '\n') end++;
    return source[end] === "'" ? end + 1 : -1;
  }
  const width = /** @type {number} */ (source.codePointAt(index + 1)) > 0xffff ? 2 : 1;
  return source[index + 1 + width] === "'" ? index + 2 + width : -1;
}

/** Index after the block comment that opens at `index`; Rust block comments nest. */
function commentEnd(source, index) {
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
 * Rust source as code only, in one pass. Comments are removed: `//`, doc
 * comments and block comments, which nest. Every literal becomes a placeholder
 * that keeps a fingerprint of its text: `"…"`, `b"…"`, `c"…"` and raw strings
 * with any number of `#` become `"xxxxxxxx"`; character and byte literals
 * become `'xxxxxxxx'`, while a lifetime or a label (`'a`) stays code. A raw
 * identifier (`r#fn`) stays one word. So a commented-out test is gone, a test
 * quoted in a string is not a test, and `"a"` is not `"b"`.
 * @param {string} source
 */
export function scanRust(source) {
  const length = source.length;
  let code = '',
    index = 0;
  const literal = (start, end, quote) => {
    code += `${quote}${fingerprint(source.slice(start, end))}${quote}`;
    index = end;
  };
  while (index < length) {
    const char = source[index],
      next = source[index + 1];
    if (char === '/' && next === '/') {
      const end = source.indexOf('\n', index + 2);
      index = end < 0 ? length : end;
      code += ' ';
    } else if (char === '/' && next === '*') {
      index = commentEnd(source, index);
      code += ' ';
    } else if (char === '"') literal(index, stringEnd(source, index + 1), '"');
    else if (char === "'") {
      const end = charEnd(source, index);
      if (end < 0) {
        code += char;
        index++;
      } else literal(index, end, "'");
    } else if (isStart(char) && !isWord(source[index - 1])) {
      let end = index + 1;
      while (isWord(source[end])) end++;
      const word = source.slice(index, end);
      if ((word === 'r' || word === 'br' || word === 'cr') && (source[end] === '"' || source[end] === '#')) {
        let open = end;
        while (source[open] === '#') open++;
        if (source[open] === '"') {
          // A raw string ends at the first `"` followed by as many `#` as it opened with.
          const close = `"${'#'.repeat(open - end)}`;
          const found = source.indexOf(close, open + 1);
          literal(index, found < 0 ? length : found + close.length, '"');
          continue;
        }
        if (word === 'r' && open === end + 1 && isStart(source[open])) {
          let stop = open + 1;
          while (isWord(source[stop])) stop++;
          code += source.slice(index, stop);
          index = stop;
          continue;
        }
      }
      if ((word === 'b' || word === 'c') && source[end] === '"') {
        literal(index, stringEnd(source, end + 1), '"');
        continue;
      }
      if (word === 'b' && source[end] === "'") {
        const close = charEnd(source, end);
        if (close > 0) {
          literal(index, close, "'");
          continue;
        }
      }
      code += word;
      index = end;
    } else {
      code += char;
      index++;
    }
  }
  return code;
}

const tokenPattern =
  /r#[\p{XID_Start}_]\p{XID_Continue}*|[\p{XID_Start}_]\p{XID_Continue}*|\d[\p{XID_Continue}.]*|"[0-9a-f]{8}"|'[0-9a-f]{8}'|'[\p{XID_Start}_]\p{XID_Continue}*|::|->|=>|==|!=|&&|\|\||\S/gu;

/** The tokens of scanned code: formatting is gone, literal values are kept. */
export const rustTokens = code => code.match(tokenPattern) ?? [];

const OPENING = new Set(['(', '[', '{']);
const CLOSING = new Set([')', ']', '}']);

/** Index of the token that closes the group opened at `open`, or the number of tokens. */
function groupEnd(tokens, open) {
  let depth = 0;
  for (let at = open; at < tokens.length; at++) {
    if (OPENING.has(tokens[at])) depth++;
    else if (CLOSING.has(tokens[at]) && --depth === 0) return at;
  }
  return tokens.length;
}

/** Tokens split at the top-level occurrences of `separator`. */
function split(tokens, separator = ',') {
  const parts = [[]];
  let depth = 0;
  for (const token of tokens) {
    if (OPENING.has(token)) depth++;
    else if (CLOSING.has(token)) depth--;
    if (token === separator && depth === 0) parts.push([]);
    else parts[parts.length - 1].push(token);
  }
  return parts.filter(part => part.length);
}

/**
 * The module path of a Rust file inside its crate, as libtest prints it:
 * `src/lib.rs`, `src/main.rs`, `src/bin/x.rs`, `src/bin/x/main.rs`, an
 * integration test `tests/x.rs` and `tests/x/main.rs` are crate roots;
 * `src/world/chunk.rs` and `src/world/chunk/mod.rs` are `world::chunk`. A file
 * next to `tests/x/main.rs` is a module of that crate (`nestedCrate`), any
 * other file under `tests/` a shared module (`tests/common/mod.rs` is
 * `common`). `#[path]` and `include!` are not followed: the registry sees them.
 * @param {string} file
 * @param {boolean} [nestedCrate] The file's first directory under `tests/`, `benches/` or `examples/` has a `main.rs`.
 * @returns {string[]}
 */
export function rustModulePath(file, nestedCrate = false) {
  const parts = file.split('/'),
    name = /** @type {string} */ (parts.pop()).replace(/\.rs$/i, '');
  let inner;
  const source = parts.lastIndexOf('src');
  if (source >= 0) {
    inner = parts.slice(source + 1);
    if (inner[0] === 'bin') {
      // `src/bin/x.rs` or `src/bin/x/main.rs`: a binary crate of its own.
      if (inner.length === 1) return [];
      inner = inner.slice(2);
      if (!inner.length && name === 'main') return [];
    } else if (!inner.length && (name === 'lib' || name === 'main')) return [];
  } else {
    const crateDir = Math.max(parts.lastIndexOf('tests'), parts.lastIndexOf('benches'), parts.lastIndexOf('examples'));
    if (crateDir < 0) return [];
    inner = parts.slice(crateDir + 1);
    if (!inner.length || (inner.length === 1 && name === 'main')) return [];
    if (nestedCrate) inner = inner.slice(1);
  }
  return name === 'mod' ? inner : [...inner, name];
}

/** The `main.rs` whose presence makes `file` part of a nested crate (`tests/x/main.rs`), or null. */
export function rustCrateRootProbe(file) {
  const parts = file.split('/');
  if (parts.includes('src')) return null;
  const crateDir = Math.max(parts.lastIndexOf('tests'), parts.lastIndexOf('benches'), parts.lastIndexOf('examples'));
  if (crateDir < 0 || parts.length - crateDir < 3) return null;
  return `${parts.slice(0, crateDir + 2).join('/')}/main.rs`;
}

/** The path of an attribute (`tokio::test`) and the tokens after it. */
function attributePath(attribute) {
  const parts = [];
  let at = attribute[0] === '::' ? 1 : 0;
  while (isIdentifier(attribute[at])) {
    parts.push(attribute[at++]);
    if (attribute[at] !== '::') break;
    at++;
  }
  return { path: parts, rest: attribute.slice(at) };
}

/** Configuration names that may be set when tests run; any other bare name is unset in a test build. */
const variableCfgs = new Set(['unix', 'windows', 'debug_assertions', 'target_thread_local']);

/**
 * A `cfg` predicate in a test build, three-valued: `T`, `F` or `U` (depends on
 * the platform, features or flags). `test` is set; `any()` is false, `all()` is
 * true; `feature = "…"` and `target_os = "…"` are unknown; another bare name
 * (`FALSE`, `miri`, `loom`) is unset, as rustc reads it without `--cfg`.
 * @param {string[]} tokens
 * @returns {'T'|'F'|'U'}
 */
function evaluateCfg(tokens, depth = 0) {
  const [head] = tokens;
  if (depth > 32) return 'U';
  if ((head === 'any' || head === 'all' || head === 'not') && tokens[1] === '(') {
    const values = split(tokens.slice(2, groupEnd(tokens, 1))).map(part => evaluateCfg(part, depth + 1));
    if (head === 'not') return values.length !== 1 ? 'U' : values[0] === 'T' ? 'F' : values[0] === 'F' ? 'T' : 'U';
    if (head === 'any') return values.includes('T') ? 'T' : values.includes('U') ? 'U' : 'F';
    return values.includes('F') ? 'F' : values.includes('U') ? 'U' : 'T';
  }
  if (tokens.length === 1 && isIdentifier(head)) return head === 'test' ? 'T' : variableCfgs.has(head) ? 'U' : 'F';
  return 'U';
}

/** `#[cfg(…)]` whose predicate is false in every test build. */
function cfgOff(attribute) {
  const { path: name, rest } = attributePath(attribute);
  return name.length === 1 && name[0] === 'cfg' && rest[0] === '(' && evaluateCfg(rest.slice(1, -1)) === 'F';
}

/** `#[ignore]`, or `#[cfg_attr(<predicate that may hold>, ignore)]`. */
function ignores(attribute) {
  const { path: name, rest } = attributePath(attribute);
  if (name.length === 1 && name[0] === 'ignore') return true;
  if (name.length !== 1 || name[0] !== 'cfg_attr' || rest[0] !== '(') return false;
  const [predicate, ...applied] = split(rest.slice(1, -1));
  return predicate !== undefined && evaluateCfg(predicate) !== 'F' && applied.some(part => part[0] === 'ignore');
}

/** `#[test]`, `#[tokio::test]`, `#[::tokio::test(…)]`: an attribute path that ends in `test`. */
function isTestAttribute(attribute) {
  const { path: name, rest } = attributePath(attribute);
  return name[name.length - 1] === 'test' && (!rest.length || rest[0] === '(');
}

/** `#[should_panic]` with its arguments as one string, or null. */
function panics(attributes) {
  const found = attributes.find(attribute => attributePath(attribute).path.join('::') === 'should_panic');
  return found ? found.join(' ') : null;
}

/**
 * Where the body of the function whose signature starts at `from` opens: the first
 * `{` outside the parameters, brackets and generic arguments (a const block in a
 * return type is not the body). `{ stop }` when a `;` or the end comes first.
 */
function bodyStart(tokens, from) {
  let angle = 0;
  for (let at = from; at < tokens.length; at++) {
    const token = tokens[at];
    if (token === '<') angle++;
    else if (token === '>' && angle > 0) angle--;
    else if (token === '(' || token === '[' || (token === '{' && angle > 0)) at = groupEnd(tokens, at);
    else if (token === '{') return { open: at };
    else if (token === ';') return { stop: at };
  }
  return { stop: tokens.length };
}

/** Statements of a body: they end at a top-level `;` or with a block that closes a block-like statement. */
function statements(tokens) {
  const list = [];
  let current = [],
    depth = 0;
  const blockLike = statement =>
    ['if', 'match', 'loop', 'while', 'for', 'unsafe', '{'].includes(statement[0]) ||
    (statement[1] === '!' && statement[2] === '{');
  for (let at = 0; at < tokens.length; at++) {
    const token = tokens[at];
    if (token === ';' && depth === 0) {
      list.push(current);
      current = [];
      continue;
    }
    current.push(token);
    if (OPENING.has(token)) depth++;
    else if (CLOSING.has(token)) {
      depth--;
      const next = tokens[at + 1];
      if (token === '}' && depth === 0 && blockLike(current) && !['else', '.', '?'].includes(next)) {
        list.push(current);
        current = [];
      }
    }
  }
  if (current.length) list.push(current);
  return list;
}

const trivialMacros = new Set(['assert', 'debug_assert', 'assert_eq', 'debug_assert_eq']);

/** `assert!(true)`, `assert!(!false)`, `assert!(x == x)`, `assert_eq!(x, x)`, with any delimiter. */
function trivialAssertion(statement) {
  if (!trivialMacros.has(statement[0]) || statement[1] !== '!' || !OPENING.has(statement[2])) return false;
  const close = groupEnd(statement, 2);
  if (close !== statement.length - 1) return false;
  const args = split(statement.slice(3, close)).map(part => part.join(' '));
  if (statement[0].endsWith('_eq')) return args.length >= 2 && args[0] === args[1];
  const first = split(statement.slice(3, close))[0] ?? [];
  const sides = split(first, '==');
  return (
    args[0] === 'true' || args[0] === '! false' || (sides.length === 2 && sides[0].join(' ') === sides[1].join(' '))
  );
}

/** The inner tokens of a block that always runs: `{ … }`, `if true { … }`, `unsafe { … }`, `loop { … }`. */
function unconditionalBlock(statement) {
  const open = statement[0] === '{' ? 0 : statement[0] === 'if' && statement[1] === 'true' ? 2 : 1;
  if (open === 1 && statement[0] !== 'unsafe' && statement[0] !== 'loop') return null;
  if (statement[open] !== '{' || groupEnd(statement, open) !== statement.length - 1) return null;
  return statement.slice(open + 1, -1);
}

/** A statement that can never check anything: dead `if false { … }`, or a closure nobody calls. */
function inert(statement, uses) {
  if (
    statement[0] === 'if' &&
    statement[1] === 'false' &&
    statement[2] === '{' &&
    groupEnd(statement, 2) === statement.length - 1
  )
    return true;
  const closureAt = at =>
    statement[at] === '|' ||
    statement[at] === '||' ||
    (statement[at] === 'move' && (statement[at + 1] === '|' || statement[at + 1] === '||'));
  if (closureAt(0)) return true;
  if (statement[0] !== 'let') return false;
  const name = statement[1] === 'mut' ? statement[2] : statement[1],
    equals = statement[1] === 'mut' ? 3 : 2;
  // Only the definition names it: the closure is never called or passed on.
  return (
    (name === '_' || (isIdentifier(name) && uses.get(name) === 1)) && statement[equals] === '=' && closureAt(equals + 1)
  );
}

/** `live` when the body may check something, `returns` or `nothing` when it cannot. */
function verdict(tokens, uses, level = 0) {
  for (const statement of statements(tokens)) {
    if (!statement.length || trivialAssertion(statement) || inert(statement, uses)) continue;
    if (statement[0] === 'return') return 'returns';
    const block = level < 16 ? unconditionalBlock(statement) : null;
    if (block) {
      const inner = verdict(block, uses, level + 1);
      if (inner === 'nothing') continue;
      return inner;
    }
    return 'live';
  }
  return 'nothing';
}

/**
 * Why a Rust test cannot fail, or null. Precision before reach: only an empty
 * body (or comments only), a body of assertions that cannot fail (`assert!(true)`,
 * `assert_eq!(x, x)`, compared by tokens with literal values kept), dead
 * `if false { … }` blocks and closures never called, or a `return` before the
 * first statement (also in `{ … }`, `if true { … }`, `loop { … }`) is refused.
 * Any other statement, a call to an unknown helper included, may check.
 * @param {string[]} body Tokens of the body.
 */
export function rustWeakness(body) {
  if (!body.some(token => token !== ';')) return 'empty body';
  const uses = new Map();
  for (const token of body) if (isIdentifier(token)) uses.set(token, (uses.get(token) ?? 0) + 1);
  const found = verdict(body, uses);
  return found === 'live' ? null : found === 'returns' ? 'returns before any check' : 'only checks that cannot fail';
}

/**
 * Rust tests of one file, read token by token: the attributes since the last
 * `;`, `{` or `}` belong to the next `fn`. With a test attribute it is a case
 * named as libtest prints it: the module path of the file, the inline `mod`
 * blocks around it, the function. `#[ignore]` (also through `cfg_attr` with a
 * predicate that may hold) and a `cfg` that is false in a test build, on the
 * function, a module around it or the file (`#![cfg(…)]`), switch it off. A
 * `macro_rules!` body is a template, not tests. Each case keeps its body as
 * tokens and its `should_panic`.
 * @param {string} file
 * @param {string} source
 * @param {{ nestedCrate?: boolean }} [options]
 */
export function rustCases(file, source, { nestedCrate = false } = {}) {
  const tokens = rustTokens(scanRust(source)),
    length = tokens.length,
    prefix = rustModulePath(file, nestedCrate),
    cases = [],
    bodies = [],
    scopes = [{ name: '', depth: 0, off: false }];
  let depth = 0,
    attributes = [],
    pending = null,
    index = 0;
  while (index < length) {
    const token = tokens[index];
    if (token === '#' && (tokens[index + 1] === '[' || (tokens[index + 1] === '!' && tokens[index + 2] === '['))) {
      const inner = tokens[index + 1] === '!',
        open = inner ? index + 2 : index + 1,
        close = groupEnd(tokens, open),
        attribute = tokens.slice(open + 1, close);
      // An inner attribute (`#![cfg(…)]`) belongs to the module or file it stands in.
      if (inner) scopes[scopes.length - 1].off ||= cfgOff(attribute);
      else attributes.push(attribute);
      index = close + 1;
    } else if (token === 'macro_rules' && tokens[index + 1] === '!') {
      let open = index + 2;
      if (isIdentifier(tokens[open])) open++;
      index = OPENING.has(tokens[open]) ? groupEnd(tokens, open) + 1 : open;
      attributes = [];
    } else if (token === '{') {
      depth++;
      if (pending) scopes.push({ ...pending, depth });
      pending = null;
      attributes = [];
      index++;
    } else if (token === '}') {
      if (scopes.length > 1 && scopes[scopes.length - 1].depth === depth) scopes.pop();
      depth = Math.max(0, depth - 1);
      pending = null;
      attributes = [];
      index++;
    } else if (token === ';') {
      pending = null;
      attributes = [];
      index++;
    } else if (token === 'mod') {
      const name = tokens[index + 1];
      pending = isIdentifier(name) ? { name, off: attributes.some(cfgOff) } : null;
      attributes = [];
      index += 2;
    } else if (token === 'fn') {
      const name = tokens[index + 1],
        own = attributes;
      attributes = [];
      index += 2;
      if (!isIdentifier(name) || !own.some(isTestAttribute)) continue;
      const { open, stop } = bodyStart(tokens, index);
      if (open === undefined) {
        index = /** @type {number} */ (stop) + 1;
        continue;
      }
      const close = groupEnd(tokens, open),
        body = tokens.slice(open + 1, close);
      bodies.push(body.join(' '));
      cases.push({
        name: [...prefix, ...scopes.slice(1).map(scope => scope.name), name].join('::'),
        skipped: own.some(ignores) || own.some(cfgOff) || scopes.some(scope => scope.off),
        body: body.join(' '),
        weak: rustWeakness(body),
        panics: panics(own),
      });
      index = close + 1;
    } else index++;
  }
  // Assertions are counted in the test bodies only: production code may assert too.
  return { code: bodies.join('\n'), cases };
}

/**
 * The Rust tests of a file as `{ name, skipped }`, named as libtest prints them.
 * @param {string} file Repository-relative path: it gives the module path.
 * @param {string} source
 * @param {{ nestedCrate?: boolean }} [options]
 */
export const rustTestCases = (file, source, options = {}) =>
  rustCases(file, source, options).cases.map(({ name, skipped }) => ({ name, skipped }));

/** The package name in a Cargo package id: `path+file:///…/game#0.1.0`, `…#engine@0.1.0`, `game 0.1.0 (…)`. */
export function packageName(id) {
  const hash = id.lastIndexOf('#');
  if (hash < 0) return id.split(' ')[0];
  const fragment = id.slice(hash + 1),
    at = fragment.indexOf('@');
  if (at >= 0) return fragment.slice(0, at);
  const url = id.slice(0, hash).replace(/\/+$/, '');
  return decodeURIComponent(url.slice(url.lastIndexOf('/') + 1));
}

/** The environment a test executable needs to find the libraries next to it, as Cargo gives it. */
function libraryEnvironment(env, executable) {
  const key =
    process.platform === 'win32'
      ? (Object.keys(env).find(name => name.toUpperCase() === 'PATH') ?? 'PATH')
      : process.platform === 'darwin'
        ? 'DYLD_FALLBACK_LIBRARY_PATH'
        : 'LD_LIBRARY_PATH';
  const directories = [path.dirname(executable), path.dirname(path.dirname(executable))];
  return { ...env, [key]: [...directories, env[key]].filter(Boolean).join(path.delimiter) };
}

const BUILD_ARGS = ['test', '--workspace', '--no-run', '--message-format=json'];
const LIST_TIMEOUT_MS = 120000;

/**
 * The test registry of one checkout: `cargo test --workspace --no-run
 * --message-format=json` names the test executables, and each one lists its
 * tests (`--list --format terse`) and its ignored tests (`… --ignored`).
 * @param {{ checkout: string, targetDir?: string, runner: any, signal?: AbortSignal, secrets?: any,
 *   env: Record<string, string> }} input `targetDir`: a target directory of its own (the base).
 * @returns {Promise<{ entries: { package: string, kind: string, target: string, dir: string, name: string, ignored: boolean }[] } | { reason: string }>}
 */
async function listRegistry({ checkout, targetDir, runner, signal, secrets, env }) {
  const run = async (command, args, options) => {
    try {
      const result = await runner(command, args, {
        signal,
        secrets,
        allowFailure: true,
        rawOutput: true,
        ...options,
      });
      return result.code === 0 ? { stdout: result.stdout } : { reason: `exit_${result.code}` };
    } catch (error) {
      if (signal?.aborted || error.code === 'cancelled') throw error;
      return { reason: error.code || 'execution_failed' };
    }
  };
  const built = await run('cargo', BUILD_ARGS, {
    cwd: checkout,
    env: targetDir ? { ...env, CARGO_TARGET_DIR: targetDir } : env,
  });
  if (built.reason) return { reason: `build_${built.reason}` };
  const executables = new Map();
  for (const line of built.stdout.split(/\r?\n/)) {
    if (!line.startsWith('{')) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    if (message.reason !== 'compiler-artifact' || message.profile?.test !== true || !message.executable) continue;
    executables.set(message.executable, message);
  }
  const entries = [];
  for (const [executable, message] of executables) {
    const where = path.dirname(message.manifest_path ?? path.join(checkout, 'Cargo.toml'));
    const options = { cwd: where, env: libraryEnvironment(env, executable), timeoutMs: LIST_TIMEOUT_MS };
    const all = await run(executable, ['--list', '--format', 'terse'], options);
    if (all.reason) return { reason: `list_${all.reason}` };
    const ignored = await run(executable, ['--list', '--format', 'terse', '--ignored'], options);
    if (ignored.reason) return { reason: `list_${ignored.reason}` };
    const names = output =>
      output
        .split(/\r?\n/)
        .map(line => /^(.+): test$/.exec(line.trim())?.[1])
        .filter(Boolean);
    const off = new Map();
    for (const name of names(ignored.stdout)) off.set(name, (off.get(name) ?? 0) + 1);
    const dir = path.relative(checkout, where).split(path.sep).join('/');
    for (const name of names(all.stdout)) {
      const left = off.get(name) ?? 0;
      if (left > 0) off.set(name, left - 1);
      entries.push({
        package: packageName(String(message.package_id ?? '')),
        kind: [].concat(message.target?.kind ?? []).join(','),
        target: String(message.target?.name ?? ''),
        dir,
        name,
        ignored: left > 0,
      });
    }
  }
  return { entries };
}

const processAlive = pid => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
};
const samePath = (left, right) => {
  const normal = value => {
    const resolved = path.resolve(value).split(path.sep).join('/');
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return normal(left) === normal(right);
};

/** Remove a base checkout: deregistered from Git and gone from disk, or the reason it is not. */
async function removeCheckout(cwd, checkout, signal) {
  try {
    await withWorktreeLock(cwd, () => execute('git', ['worktree', 'remove', '--force', checkout], { cwd }), signal);
  } catch (error) {
    return `worktree remove failed: ${String(error.message).slice(0, 300)}`;
  }
  const listed = (await execute('git', ['worktree', 'list', '--porcelain'], { cwd })).stdout;
  if (
    listed
      .split(/\r?\n/)
      .filter(line => line.startsWith('worktree '))
      .some(line => samePath(line.slice(9), checkout))
  )
    return 'worktree is still registered';
  rmSync(checkout, { recursive: true, force: true });
  return null;
}

/** Base checkouts a crashed gate left behind (`kodo-registry-<pid>-…` of a process that is gone). */
async function removeStale(cwd, checkouts, signal) {
  let names = [];
  try {
    names = readdirSync(checkouts);
  } catch {
    return;
  }
  const stale = names.filter(name => {
    const pid = Number(/^kodo-registry-(\d+)-/.exec(name)?.[1]);
    return Number.isInteger(pid) && pid > 0 && !processAlive(pid);
  });
  for (const name of stale) await removeCheckout(cwd, path.join(checkouts, name), signal);
  if (stale.length)
    await withWorktreeLock(cwd, () => execute('git', ['worktree', 'prune'], { cwd, allowFailure: true }), signal);
}

/** Kodo's state directory for the registry of one repository: base checkouts and the base target directory. */
async function registryHomeFor(cwd) {
  const common = (
    await execute('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd, rawOutput: true })
  ).stdout.replace(/\r?\n$/, '');
  const key = createHash('sha256')
    .update(process.platform === 'win32' ? realpathSync.native(common).toLowerCase() : realpathSync.native(common))
    .digest('hex')
    .slice(0, 16);
  return path.join(stateHome(), 'registry', key);
}

/**
 * Compare the registry of the base and the head. A name gone from the head, or
 * ignored there and not on the base, that the reading of the source has not
 * already reported is a finding. A base case in a file this run may reduce is
 * allowed; every explanation and every permission is used once.
 * @param {{ base: any[], head: any[], explained: { name: string, file: string }[],
 *   located: { name: string, file: string }[], allowed: string[] }} input
 */
export function compareRegistry({ base, head, explained, located, allowed }) {
  const key = entry => `${entry.package}\u0000${entry.kind}\u0000${entry.target}\u0000${entry.name}`;
  const dirs = [...new Set([...base, ...head].map(entry => entry.dir))];
  const owner = file =>
    dirs
      .filter(dir => dir === '' || file === dir || file.startsWith(`${dir}/`))
      .reduce(
        (best, dir) => (best === null || dir.length > best.length ? dir : best),
        /** @type {string|null} */ (null),
      );
  const pool = list => {
    const map = new Map();
    for (const item of list) {
      const slot = `${owner(item.file)}\u0000${item.name}`;
      if (!map.has(slot)) map.set(slot, []);
      map.get(slot).push(item);
    }
    return map;
  };
  const reasons = pool(explained),
    permissions = pool(located);
  const take = (map, entry, accept = _item => true) => {
    const list = map.get(`${entry.dir}\u0000${entry.name}`);
    const at = list ? list.findIndex(accept) : -1;
    return at < 0 ? null : list.splice(at, 1)[0];
  };
  const tally = list => {
    const map = new Map();
    for (const entry of list) {
      const counts = map.get(key(entry)) ?? { entry, total: 0, active: 0 };
      counts.total++;
      if (!entry.ignored) counts.active++;
      map.set(key(entry), counts);
    }
    return map;
  };
  const before = tally(base),
    after = tally(head);
  const gone = [],
    off = [],
    permitted = new Map();
  for (const [slot, counts] of before) {
    const now = after.get(slot) ?? { total: 0, active: 0 };
    const removed = Math.max(0, counts.total - now.total);
    const switched = Math.max(0, Math.max(0, counts.active - removed) - now.active);
    for (let left = removed; left > 0; left--) {
      if (take(reasons, counts.entry)) continue;
      const item = take(permissions, counts.entry, candidate => ownsPath(allowed, candidate.file));
      if (item) {
        if (!permitted.has(item.file)) permitted.set(item.file, []);
        permitted.get(item.file).push(counts.entry);
      } else gone.push(counts.entry);
    }
    for (let left = switched; left > 0; left--) if (!take(reasons, counts.entry)) off.push(counts.entry);
  }
  const label = entry => `${entry.package} ${entry.kind} ${entry.target}: ${entry.name}`;
  const names = list =>
    `${list
      .slice(0, 5)
      .map(entry => JSON.stringify(label(entry).slice(0, 120)))
      .join(', ')}${list.length > 5 ? `, and ${list.length - 5} more` : ''}`;
  const findings = [];
  if (gone.length)
    findings.push({
      rule: 'test_deleted',
      file: null,
      detail: `test registry: ${gone.length} tests are gone: ${names(gone)}`,
    });
  if (off.length)
    findings.push({
      rule: 'test_skipped',
      file: null,
      detail: `test registry: ${off.length} tests are ignored now: ${names(off)}`,
    });
  const count = map => [...map.values()].reduce((sum, item) => sum + item.total, 0);
  return {
    findings,
    permitted: [...permitted].map(([file, list]) => ({
      rule: 'test_deleted',
      file,
      detail: `test registry: tests are gone: ${names(list)}`,
    })),
    base: count(before),
    head: count(after),
  };
}

/**
 * The registry check of a full gate on a Rust project. The head is listed in
 * the checked worktree; the base in a temporary `git worktree` under Kodo's
 * state directory, built into its own target directory (`registry-base`), never
 * the head's: an oracle after the gate must not find base binaries. Adding and
 * removing the checkout hold the repository's worktree lock; the build does
 * not. A base without `Cargo.toml` (a new crate) is an empty registry.
 * `incomplete` — Cargo missing, a build or a listing failed, the checkout not
 * removed — is never a pass.
 */
export async function rustRegistryCheck({
  cwd,
  baseSha,
  signal,
  secrets,
  runner,
  registryHome,
  allowed,
  explained,
  located,
}) {
  const env = workerEnvironment();
  try {
    await runner('cargo', ['--version'], { cwd, signal, env, secrets, allowFailure: false });
  } catch (error) {
    if (signal?.aborted || error.code === 'cancelled') throw error;
    return { registry: { status: 'incomplete', reason: 'cargo_unavailable' } };
  }
  const after = await listRegistry({ checkout: cwd, runner, signal, secrets, env });
  if ('reason' in after) return { registry: { status: 'incomplete', reason: `head_${after.reason}` } };
  const baseIsRust =
    (await execute('git', ['cat-file', '-e', `${baseSha}:Cargo.toml`], { cwd, allowFailure: true })).code === 0;
  let before = { entries: [] };
  if (baseIsRust) {
    const home = registryHome ?? (await registryHomeFor(cwd)),
      checkouts = path.join(home, 'checkouts');
    const checkout = path.join(checkouts, `kodo-registry-${process.pid}-${randomBytes(6).toString('hex')}`);
    try {
      mkdirSync(checkouts, { recursive: true });
      await removeStale(cwd, checkouts, signal);
      await withWorktreeLock(
        cwd,
        () => execute('git', ['worktree', 'add', '--detach', '--quiet', checkout, baseSha], { cwd }),
        signal,
      );
    } catch (error) {
      if (signal?.aborted || error.code === 'cancelled') throw error;
      try {
        rmSync(checkout, { recursive: true, force: true });
      } catch {
        // The checkout was never created.
      }
      return {
        registry: { status: 'incomplete', reason: `base_checkout: ${String(error.message).slice(0, 300)}` },
      };
    }
    let listed;
    try {
      listed = await listRegistry({
        checkout,
        targetDir: path.join(home, 'registry-base'),
        runner,
        signal,
        secrets,
        env,
      });
    } finally {
      const failure = await removeCheckout(cwd, checkout, signal);
      if (failure) listed = { reason: `checkout_cleanup: ${failure}` };
    }
    if ('reason' in listed) return { registry: { status: 'incomplete', reason: `base_${listed.reason}` } };
    before = listed;
  }
  const compared = compareRegistry({ base: before.entries, head: after.entries, explained, located, allowed });
  return {
    registry: {
      status: 'compared',
      base: compared.base,
      head: compared.head,
      ...(baseIsRust ? {} : { baseRegistry: 'absent' }),
    },
    findings: compared.findings,
    permitted: compared.permitted,
  };
}
