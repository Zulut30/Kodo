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
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { execute } from './command.mjs';
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

/** The crate directory of a Rust file, read from its path: what stands before `src/`, `tests/`, `benches/` or `examples/`. */
export function rustCrateDir(file) {
  const parts = file.split('/');
  parts.pop();
  const source = parts.lastIndexOf('src');
  const at =
    source >= 0
      ? source
      : Math.max(parts.lastIndexOf('tests'), parts.lastIndexOf('benches'), parts.lastIndexOf('examples'));
  return (at >= 0 ? parts.slice(0, at) : parts).join('/');
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
  return { path: parts.join('::'), rest: attribute.slice(at) };
}

/**
 * A `cfg` predicate in a test build, three-valued: `T`, `F` or `U`. Only what is
 * provably decided is decided: `test` (set in every test build), the literals
 * `true` and `false`, `any()` (false), `all()` (true) and their compositions
 * with `not`, `any`, `all`. Every other name — features, platforms, flags a
 * `build.rs` sets, `FALSE` — is unknown: the registry of a full gate judges it.
 * @param {string[]} tokens
 * @returns {'T'|'F'|'U'}
 */
function evaluateCfg(tokens, depth = 0) {
  const [head] = tokens;
  if (depth > 32) return 'U';
  if (
    (head === 'any' || head === 'all' || head === 'not') &&
    tokens[1] === '(' &&
    groupEnd(tokens, 1) === tokens.length - 1
  ) {
    const values = split(tokens.slice(2, -1)).map(part => evaluateCfg(part, depth + 1));
    if (head === 'not') return values.length !== 1 ? 'U' : values[0] === 'T' ? 'F' : values[0] === 'F' ? 'T' : 'U';
    if (head === 'any') return values.includes('T') ? 'T' : values.includes('U') ? 'U' : 'F';
    return values.includes('F') ? 'F' : values.includes('U') ? 'U' : 'T';
  }
  if (tokens.length === 1) return head === 'test' || head === 'true' ? 'T' : head === 'false' ? 'F' : 'U';
  return 'U';
}

/**
 * The attributes an attribute stands for in a test build: `cfg_attr(<true>, a, b)` is `a` and
 * `b` (also nested), `cfg_attr(<false or unknown>, …)` is nothing the reading may count on.
 * @returns {string[][]}
 */
function expand(attribute, depth = 0) {
  const { path: name, rest } = attributePath(attribute);
  if (name !== 'cfg_attr') return [attribute];
  if (depth > 8 || rest[0] !== '(' || groupEnd(rest, 0) !== rest.length - 1) return [];
  const [predicate, ...applied] = split(rest.slice(1, -1));
  if (!predicate || evaluateCfg(predicate) !== 'T') return [];
  return applied.flatMap(part => expand(part, depth + 1));
}

/** `#[cfg(…)]` whose predicate is provably false in a test build. */
function cfgOff(attribute) {
  const { path: name, rest } = attributePath(attribute);
  return (
    name === 'cfg' && rest[0] === '(' && groupEnd(rest, 0) === rest.length - 1 && evaluateCfg(rest.slice(1, -1)) === 'F'
  );
}

/** `#[test]`, `#[tokio::test]`, `#[::tokio::test(…)]`: an attribute path that ends in `test`. */
function isTestAttribute(attribute) {
  const { path: name, rest } = attributePath(attribute);
  return (name === 'test' || name.endsWith('::test')) && (!rest.length || rest[0] === '(');
}

/**
 * `#[should_panic]` as `any`, `#[should_panic(expected = "…")]` and `#[should_panic = "…"]` as
 * `expected:<fingerprint>`, or null.
 */
function panics(attributes) {
  const found = attributes.find(attribute => attributePath(attribute).path === 'should_panic');
  if (!found) return null;
  const rest = attributePath(found).rest;
  const expected =
    rest[0] === '=' ? rest[1] : rest[0] === '(' && rest[1] === 'expected' && rest[2] === '=' ? rest[3] : null;
  return expected ? `expected:${expected}` : 'any';
}

/** An existing test is weaker when it no longer has to panic, or no longer with its message. */
export const panicWeakened = (before, after) =>
  before !== null && after !== before && !(before === 'any' && after?.startsWith('expected:'));

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

const literalPattern = /^(?:"[0-9a-f]{8}"|'[0-9a-f]{8}'|\d[\p{XID_Continue}.]*)$/u;
/** Tokens without the parentheses that only wrap them: `((true))` is `true`. */
function unwrap(tokens) {
  let inner = tokens;
  while (inner[0] === '(' && inner.length > 1 && groupEnd(inner, 0) === inner.length - 1) inner = inner.slice(1, -1);
  return inner;
}
/** A literal, `true`/`false`, a negative number or one plain name: an operand that cannot change between reads. */
function constant(tokens) {
  const inner = unwrap(tokens);
  if (inner.length === 2 && inner[0] === '-') return literalPattern.test(inner[1]);
  return inner.length === 1 && (literalPattern.test(inner[0]) || isIdentifier(inner[0]));
}
const sameConstant = (left, right) =>
  left !== undefined && right !== undefined && constant(left) && unwrap(left).join(' ') === unwrap(right).join(' ');

const trivialMacros = new Set(['assert', 'debug_assert', 'assert_eq', 'debug_assert_eq']);

/**
 * An assertion that cannot fail: `assert!(true)`, `assert!(!false)`, `assert!((true))`,
 * `assert!(x == x)` and `assert_eq!(x, x)` with constant operands (a literal or one plain name;
 * `assert_eq!(read(), read())` may fail), also through `std::`/`core::` and with any delimiter.
 */
function trivialAssertion(statement) {
  let at = statement[0] === '::' ? 1 : 0;
  if ((statement[at] === 'std' || statement[at] === 'core') && statement[at + 1] === '::') at += 2;
  const name = statement[at];
  if (!trivialMacros.has(name) || statement[at + 1] !== '!' || !OPENING.has(statement[at + 2])) return false;
  const close = groupEnd(statement, at + 2);
  if (close !== statement.length - 1) return false;
  const args = split(statement.slice(at + 3, close));
  if (name.endsWith('_eq')) return sameConstant(args[0], args[1]);
  const first = unwrap(args[0] ?? []);
  if (first.length === 1 && first[0] === 'true') return true;
  if (first[0] === '!' && unwrap(first.slice(1)).join(' ') === 'false') return true;
  const sides = split(first, '==');
  return sides.length === 2 && sameConstant(sides[0], sides[1]);
}

/** A closure nobody calls or passes on: `|| …;`, `let check = || …;` with `check` never named again. */
function unusedClosure(statement, uses) {
  const closureAt = at =>
    statement[at] === '|' ||
    statement[at] === '||' ||
    (statement[at] === 'move' && (statement[at + 1] === '|' || statement[at + 1] === '||'));
  if (closureAt(0)) return true;
  if (statement[0] !== 'let') return false;
  const name = statement[1] === 'mut' ? statement[2] : statement[1],
    equals = statement[1] === 'mut' ? 3 : 2;
  return (
    (name === '_' || (isIdentifier(name) && uses.get(name) === 1)) && statement[equals] === '=' && closureAt(equals + 1)
  );
}

/** `return;`, `return ();`, `return Ok(());`: a return that hands back nothing a test could check. */
const emptyReturn = statement =>
  statement[0] === 'return' && ['', '( )', 'Ok ( ( ) )'].includes(statement.slice(1).join(' '));

/** `live` when a statement may check something, `returns` when it returns first, `nothing` when it cannot check. */
function statementVerdict(statement, uses, level) {
  if (!statement.length || trivialAssertion(statement) || unusedClosure(statement, uses)) return 'nothing';
  if (statement[0] === 'return') return emptyReturn(statement) ? 'returns' : 'live';
  if (level >= 16) return 'live';
  const whole = open => statement[open] === '{' && groupEnd(statement, open) === statement.length - 1;
  if (whole(0)) return verdict(statement.slice(1, -1), uses, level + 1);
  if (statement[0] === 'unsafe' && whole(1)) return verdict(statement.slice(2, -1), uses, level + 1);
  // A loop that checks nothing never ends: the test hangs, it does not pass.
  if (statement[0] === 'loop' && whole(1)) {
    const inner = verdict(statement.slice(2, -1), uses, level + 1);
    return inner === 'returns' ? 'returns' : 'live';
  }
  if (statement[0] === 'if' && (statement[1] === 'true' || statement[1] === 'false') && statement[2] === '{') {
    // A constant condition: only the branch that runs counts, `else` and `else if` included.
    const thenEnd = groupEnd(statement, 2),
      rest = statement.slice(thenEnd + 1);
    if (statement[1] === 'true')
      return rest.length && rest[0] !== 'else' ? 'live' : verdict(statement.slice(3, thenEnd), uses, level + 1);
    if (!rest.length) return 'nothing';
    if (rest[0] !== 'else') return 'live';
    if (rest[1] === '{' && groupEnd(rest, 1) === rest.length - 1) return verdict(rest.slice(2, -1), uses, level + 1);
    return rest[1] === 'if' ? statementVerdict(rest.slice(1), uses, level + 1) : 'live';
  }
  return 'live';
}

function verdict(tokens, uses, level = 0) {
  for (const statement of statements(tokens)) {
    const found = statementVerdict(statement, uses, level);
    if (found !== 'nothing') return found;
  }
  return 'nothing';
}

/**
 * Why a Rust test cannot fail, or null. Precision before reach: only an empty
 * body (or comments only), a body of assertions that cannot fail, dead
 * `if false { … }` branches and closures never called, or an empty `return`
 * (`return;`, `return ();`, `return Ok(());`) before the first statement that
 * may check is refused. Any other statement, a call to an unknown helper or a
 * `return` with a value included, may check.
 * @param {string[]} body Tokens of the body.
 */
export function rustWeakness(body) {
  if (!body.some(token => token !== ';')) return 'empty body';
  const uses = new Map();
  for (const token of body) if (isIdentifier(token)) uses.set(token, (uses.get(token) ?? 0) + 1);
  const found = verdict(body, uses);
  return found === 'live' ? null : found === 'returns' ? 'returns before any check' : 'only checks that cannot fail';
}

/** The tests a `macro_rules!` body would define: `#[test] fn name` or `#[test] fn $name`, with their bodies. */
function templateTests(tokens) {
  const tests = [];
  let attributes = [];
  for (let at = 0; at < tokens.length; at++) {
    const token = tokens[at];
    if (token === '#' && tokens[at + 1] === '[') {
      const close = groupEnd(tokens, at + 1);
      attributes.push(...expand(tokens.slice(at + 2, close)));
      at = close;
    } else if (token === 'fn') {
      const name = tokens[at + 1] === '$' ? `$${tokens[at + 2]}` : tokens[at + 1];
      const own = attributes;
      attributes = [];
      if (!own.some(isTestAttribute) || !name) continue;
      const { open, stop } = bodyStart(tokens, at + (name.startsWith('$') ? 3 : 2));
      if (open === undefined) {
        at = /** @type {number} */ (stop);
        continue;
      }
      const close = groupEnd(tokens, open),
        body = tokens.slice(open + 1, close);
      tests.push({ name, body: body.join(' '), weak: rustWeakness(body) });
      at = close;
    } else if (token === ';' || token === '{' || token === '}') attributes = [];
  }
  return tests;
}

/**
 * Rust tests of one file, read token by token: the attributes since the last
 * `;`, `{` or `}` belong to the next `fn`. With a test attribute it is a case
 * named as libtest prints it: the module path of the file, the inline `mod`
 * blocks around it, the function. `cfg_attr(<true>, …)` is expanded, also
 * nested. A test is switched off by `#[ignore]` (`off: 'ignore'`) or by a `cfg`
 * provably false in a test build on the function, a module around it or the
 * file (`off: 'cfg'`). A `macro_rules!` body is a template: its tests are kept
 * apart (`templates`), with the macros the file calls (`calls`).
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
    templates = [],
    calls = new Set(),
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
        effective = expand(tokens.slice(open + 1, close));
      // An inner attribute (`#![cfg(…)]`) belongs to the module or file it stands in.
      if (inner) scopes[scopes.length - 1].off ||= effective.some(cfgOff);
      else attributes.push(...effective);
      index = close + 1;
    } else if (token === 'macro_rules' && tokens[index + 1] === '!') {
      let open = index + 2;
      const name = isIdentifier(tokens[open]) ? tokens[open++] : '';
      const close = OPENING.has(tokens[open]) ? groupEnd(tokens, open) : open - 1;
      const tests = close > open ? templateTests(tokens.slice(open + 1, close)) : [];
      if (name && tests.length) templates.push({ name, tests });
      index = close + 1;
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
      const off = own.some(cfgOff) || scopes.some(scope => scope.off) ? 'cfg' : own.some(ignores) ? 'ignore' : null;
      cases.push({
        name: [...prefix, ...scopes.slice(1).map(scope => scope.name), name].join('::'),
        skipped: off !== null,
        off,
        body: body.join(' '),
        weak: rustWeakness(body),
        panics: panics(own),
      });
      index = close + 1;
    } else {
      if (isIdentifier(token) && tokens[index + 1] === '!' && OPENING.has(tokens[index + 2])) calls.add(token);
      index++;
    }
  }
  // Assertions are counted in the test bodies only: production code may assert too.
  return { code: bodies.join('\n'), cases, templates, calls };
}

/** `#[ignore]` in a test build (after `cfg_attr` is expanded). */
function ignores(attribute) {
  return attributePath(attribute).path === 'ignore';
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

/** A path as the file system names it: symbolic links, `/private/var`, 8.3 names and `\\?\` resolved. */
function canonical(value) {
  let resolved;
  try {
    resolved = realpathSync.native(value);
  } catch {
    resolved = path.resolve(value);
  }
  resolved = resolved.replace(/^\\\\\?\\(?!UNC\\)/, '');
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** The kind of a Cargo target as the registry compares it. */
const kindOf = kinds => ['bin', 'test', 'bench', 'example'].find(kind => kinds.split(',').includes(kind)) ?? 'lib';

/**
 * Targets declared with `harness = false` in a manifest: libtest does not run them, so their
 * `--list` says nothing. Read line by line from the `[lib]`, `[[bin]]`, `[[test]]`, `[[bench]]`
 * and `[[example]]` tables. @returns {Set<string>} `kind:name`
 */
export function harnessFreeTargets(manifest, packageNameValue) {
  const found = new Set();
  let section = null;
  const close = () => {
    if (section?.harness === false)
      found.add(
        `${section.kind}:${section.name ?? (section.kind === 'lib' ? packageNameValue.replace(/-/g, '_') : '')}`,
      );
  };
  for (const raw of manifest.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    const header = /^\[\[?\s*([\w.-]+)\s*\]\]?$/.exec(line);
    if (header) {
      close();
      const kind = { lib: 'lib', bin: 'bin', test: 'test', bench: 'bench', example: 'example' }[header[1]];
      section = kind ? { kind } : null;
      continue;
    }
    if (!section) continue;
    const name = /^name\s*=\s*"([^"]*)"/.exec(line);
    if (name) section.name = name[1];
    if (/^harness\s*=\s*false\b/.test(line)) section.harness = false;
  }
  close();
  return found;
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
 * tests (`--list --format terse`) and its ignored tests (`… --ignored`). A
 * `harness = false` target is not run: it is one entry with an empty name, so
 * the target itself is tracked.
 * @param {{ checkout: string, targetDir?: string, runner: any, signal?: AbortSignal, secrets?: any,
 *   env: Record<string, string> }} input `targetDir`: a target directory of its own (the base).
 * @returns {Promise<{ entries: { package: string, kind: string, target: string, dir: string, name: string, ignored: boolean }[] } | { reason: string }>}
 */
async function listRegistry({ checkout, targetDir, runner, signal, secrets, env }) {
  const run = async (command, args, options) => {
    try {
      const result = await runner(command, args, { signal, secrets, allowFailure: true, rawOutput: true, ...options });
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
  if ('reason' in built) return { reason: `build_${built.reason}` };
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
  const root = canonical(checkout),
    manifests = new Map(),
    entries = [];
  for (const [executable, message] of executables) {
    const manifest = message.manifest_path ?? path.join(checkout, 'Cargo.toml'),
      where = path.dirname(manifest),
      packageValue = packageName(String(message.package_id ?? '')),
      kind = [].concat(message.target?.kind ?? []).join(','),
      target = String(message.target?.name ?? '');
    // Both sides canonical: a manifest path through `/private/var`, an 8.3 name or `\\?\` is the same directory.
    const dir = path.relative(root, canonical(where)).split(path.sep).join('/');
    if (!manifests.has(manifest)) {
      let text = '';
      try {
        text = readFileSync(manifest, 'utf8');
      } catch {
        // A manifest that cannot be read declares no harness-free target.
      }
      manifests.set(manifest, harnessFreeTargets(text, packageValue));
    }
    const entry = { package: packageValue, kind, target, dir };
    if (manifests.get(manifest).has(`${kindOf(kind)}:${target}`)) {
      entries.push({ ...entry, name: '', ignored: false });
      continue;
    }
    const options = { cwd: where, env: libraryEnvironment(env, executable), timeoutMs: LIST_TIMEOUT_MS };
    const all = await run(executable, ['--list', '--format', 'terse'], options);
    if ('reason' in all) return { reason: `list_${all.reason}` };
    const ignored = await run(executable, ['--list', '--format', 'terse', '--ignored'], options);
    if ('reason' in ignored) return { reason: `list_${ignored.reason}` };
    const names = output =>
      output
        .split(/\r?\n/)
        .map(line => /^(.+): test$/.exec(line.trim())?.[1])
        .filter(Boolean);
    const off = new Map();
    for (const name of names(ignored.stdout)) off.set(name, (off.get(name) ?? 0) + 1);
    for (const name of names(all.stdout)) {
      const left = off.get(name) ?? 0;
      if (left > 0) off.set(name, left - 1);
      entries.push({ ...entry, name, ignored: left > 0 });
    }
  }
  return { entries };
}

const samePath = (left, right) => canonical(left) === canonical(right);

/** Remove a base checkout, also after a cancelled gate: no signal, a bounded wait. The reason it failed, or null. */
async function removeCheckout(cwd, checkout) {
  try {
    await withWorktreeLock(
      cwd,
      async () => {
        await execute('git', ['worktree', 'remove', '--force', checkout], {
          cwd,
          allowFailure: true,
          timeoutMs: 60000,
        });
        // A checkout deleted behind Git's back stays registered until it is pruned.
        await execute('git', ['worktree', 'prune'], { cwd, allowFailure: true, timeoutMs: 60000 });
      },
      undefined,
      60000,
    );
    const listed = (await execute('git', ['worktree', 'list', '--porcelain'], { cwd, timeoutMs: 60000 })).stdout;
    if (
      listed
        .split(/\r?\n/)
        .filter(line => line.startsWith('worktree '))
        .some(line => samePath(line.slice(9), checkout))
    )
      return 'worktree is still registered';
    rmSync(checkout, { recursive: true, force: true });
    return null;
  } catch (error) {
    return String(error.message).slice(0, 300);
  }
}

/**
 * The base checkout at a stable path, at `baseSha`, clean. A stable path keeps Cargo's
 * fingerprints of the workspace crates, so a repeated base builds incrementally. A checkout
 * that is missing, unregistered or broken is removed and added again.
 */
async function prepareCheckout(cwd, checkout, baseSha, signal) {
  const listed = (await execute('git', ['worktree', 'list', '--porcelain'], { cwd })).stdout;
  const registered = listed
    .split(/\r?\n/)
    .filter(line => line.startsWith('worktree '))
    .some(line => samePath(line.slice(9), checkout));
  if (registered && existsSync(checkout)) {
    try {
      const moved = await execute('git', ['checkout', '--detach', '--force', '--quiet', baseSha], {
        cwd: checkout,
        allowFailure: true,
        signal,
      });
      const cleaned =
        moved.code === 0 && (await execute('git', ['clean', '-ffdxq'], { cwd: checkout, allowFailure: true, signal }));
      if (cleaned && cleaned.code === 0) return;
    } catch (error) {
      if (signal?.aborted || error.code === 'cancelled') throw error;
      // A broken checkout is added again below.
    }
  }
  const failure = await removeCheckout(cwd, checkout);
  if (failure && registered) throw new Error(`base checkout cleanup: ${failure}`);
  rmSync(checkout, { recursive: true, force: true });
  await withWorktreeLock(
    cwd,
    async () => {
      await execute('git', ['worktree', 'prune'], { cwd, allowFailure: true });
      await execute('git', ['worktree', 'add', '--detach', '--quiet', checkout, baseSha], { cwd });
    },
    signal,
  );
}

/**
 * A lock across processes on the base build directory, for the whole build and listing: two
 * gates must not overwrite each other's base executables (the same path for different
 * bases). An SQLite write transaction, as the worktree lock: process death releases it.
 */
async function withBaseLock(home, action, signal, waitMs = 4 * 60 * 60 * 1000) {
  const { DatabaseSync } = await import('node:sqlite');
  mkdirSync(home, { recursive: true });
  const guard = new DatabaseSync(path.join(home, 'registry-base.lock.sqlite'), { timeout: 0 });
  const started = performance.now();
  try {
    for (;;) {
      signal?.throwIfAborted();
      try {
        guard.exec('BEGIN IMMEDIATE');
        break;
      } catch (error) {
        if ((error.errcode & 0xff) !== 5) throw error;
      }
      if (performance.now() - started > waitMs)
        throw Object.assign(new Error('Timed out waiting for the base build of the test registry'), {
          code: 'timeout',
        });
      await delay(200, undefined, { signal });
    }
    return await action();
  } finally {
    guard.close();
  }
}

/** Kodo's state directory for the registry of one repository: the base checkout, its target directory, the cache. */
async function registryHomeFor(cwd) {
  const common = (
    await execute('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd, rawOutput: true })
  ).stdout.replace(/\r?\n$/, '');
  const key = createHash('sha256').update(canonical(common)).digest('hex').slice(0, 16);
  return path.join(stateHome(), 'registry', key);
}

/** Where a file stands in a package: the target kind and name a test in it belongs to. */
function targetOf(file, dir, nested) {
  const parts = (dir ? file.slice(dir.length + 1) : file).split('/'),
    stem = name => name.replace(/\.rs$/i, '');
  if (parts[0] === 'src') {
    if (parts[1] === 'bin') return { kind: 'bin', target: parts.length === 3 ? stem(parts[2]) : parts[2] };
    if (parts.length === 2 && parts[1] === 'main.rs') return { kind: 'bin', target: null };
    return { kind: 'lib-or-main', target: null };
  }
  const kind = { tests: 'test', benches: 'bench', examples: 'example' }[parts[0]];
  if (!kind) return { kind: 'lib-or-main', target: null };
  if (parts.length === 2) return { kind, target: stem(parts[1]) };
  // `tests/<t>/main.rs` and its modules are target `<t>`; another directory is a module shared by any test target.
  return { kind, target: nested || parts[parts.length - 1] === 'main.rs' ? parts[1] : null };
}

/** Whether a test of `file` can be the registry entry: same package directory, same target. */
function sameTarget(item, entry, owner) {
  if (owner(item.file) !== entry.dir) return false;
  const { kind, target } = targetOf(item.file, entry.dir, item.nested),
    entryKind = kindOf(entry.kind),
    main = entryKind === 'bin' && entry.target.replace(/-/g, '_') === entry.package.replace(/-/g, '_');
  if (kind === 'lib-or-main') return entryKind === 'lib' || main;
  if (kind === 'bin') return entryKind === 'bin' && (target === null ? main : entry.target === target);
  return entryKind === kind && (target === null || entry.target === target);
}

/**
 * Compare the registry of the base and the head. A test gone from the head, or ignored there
 * and not on the base, that the reading of the source has not explained is a finding. Every
 * explanation and every permission is matched to one base entry by (package, target kind,
 * target, name) and used once: removals (also moves and a `cfg` provably false) explain gone
 * tests, ignores explain ignored ones, and a permission covers only a test that is gone from
 * its permitted file on the head. A `harness = false` target is one entry with an empty name.
 * @param {{ base: any[], head: any[], removals: any[], skips: any[], permissions: any[] }} input
 */
export function compareRegistry({ base, head, removals, skips, permissions }) {
  const key = entry => `${entry.package}\u0000${entry.kind}\u0000${entry.target}\u0000${entry.name}`;
  const dirs = [...new Set([...base, ...head].map(entry => entry.dir))];
  const owner = file =>
    dirs
      .filter(dir => dir === '' || file === dir || file.startsWith(`${dir}/`))
      .reduce(
        (best, dir) => (best === null || dir.length > best.length ? dir : best),
        /** @type {string|null} */ (null),
      );
  const byName = list => {
    const map = new Map();
    for (const item of list) {
      if (!map.has(item.name)) map.set(item.name, []);
      map.get(item.name).push(item);
    }
    return map;
  };
  const pools = { removals: byName(removals), skips: byName(skips), permissions: byName(permissions) };
  const take = (pool, entry) => {
    const list = pool.get(entry.name);
    const at = list ? list.findIndex(item => sameTarget(item, entry, owner)) : -1;
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
      if (take(pools.removals, counts.entry)) continue;
      const item = take(pools.permissions, counts.entry);
      if (!item) gone.push(counts.entry);
      else {
        if (!permitted.has(item.file)) permitted.set(item.file, new Set());
        permitted.get(item.file).add(counts.entry);
      }
    }
    for (let left = switched; left > 0; left--) if (!take(pools.skips, counts.entry)) off.push(counts.entry);
  }
  const label = entry => `${entry.package} ${entry.kind} ${entry.target}: ${entry.name || '(target, harness = false)'}`;
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
      detail: `test registry: tests are gone: ${names([...list])}`,
    })),
    base: count(before),
    head: count(after),
  };
}

/** What a cached base registry depends on: the commit, the lock file, the toolchain, the flags. */
async function cacheKey(cwd, baseSha, toolchain) {
  const lock = await execute('git', ['show', `${baseSha}:Cargo.lock`], { cwd, allowFailure: true, rawOutput: true });
  return createHash('sha256')
    .update(
      JSON.stringify([
        1,
        baseSha,
        lock.code === 0 ? createHash('sha256').update(lock.stdout).digest('hex') : null,
        toolchain,
        process.env.RUSTFLAGS ?? null,
        process.env.CARGO_BUILD_TARGET ?? null,
      ]),
    )
    .digest('hex');
}

function readCache(file) {
  try {
    const value = JSON.parse(readFileSync(file, 'utf8'));
    return Array.isArray(value?.entries) ? value : null;
  } catch {
    return null;
  }
}

function writeCache(file, entries) {
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify({ entries }));
    renameSync(temporary, file);
  } catch {
    // A cache that cannot be written only costs the next gate a build.
  }
}

/**
 * The registry check of a full gate on a Rust project: a root `Cargo.toml` on the base or the
 * head. A side without it is an empty registry (a new crate; a manifest removed). The head is
 * listed in the checked worktree. The base is listed in a checkout at a stable path under
 * Kodo's state directory, built into its own target directory (`registry-base`), never the
 * head's, under a lock across processes for the whole build and listing; a finished base
 * registry is cached by commit, `Cargo.lock`, toolchain and flags. `incomplete` — Cargo
 * missing, a build or a listing failed, the checkout broken — is never a pass.
 */
export async function rustRegistryCheck({
  cwd,
  baseSha,
  signal,
  secrets,
  runner,
  registryHome,
  baseIsRust,
  headIsRust,
  removals,
  skips,
  permissions,
}) {
  const env = workerEnvironment();
  let toolchain;
  try {
    toolchain = String(
      (await runner('cargo', ['--version'], { cwd, signal, env, secrets, allowFailure: false })).stdout,
    ).trim();
  } catch (error) {
    if (signal?.aborted || error.code === 'cancelled') throw error;
    return { registry: { status: 'incomplete', reason: 'cargo_unavailable' } };
  }
  let after = /** @type {any} */ ({ entries: [] });
  if (headIsRust) {
    after = await listRegistry({ checkout: cwd, runner, signal, secrets, env });
    if ('reason' in after) return { registry: { status: 'incomplete', reason: `head_${after.reason}` } };
  }
  let before = /** @type {any} */ ({ entries: [] }),
    cached = false;
  if (baseIsRust) {
    const home = registryHome ?? (await registryHomeFor(cwd)),
      cache = path.join(home, 'cache', `${await cacheKey(cwd, baseSha, toolchain)}.json`);
    const hit = readCache(cache);
    if (hit) {
      before = hit;
      cached = true;
    } else {
      try {
        before = await withBaseLock(
          home,
          async () => {
            // Another gate may have built this base while this one waited.
            const ready = readCache(cache);
            if (ready) {
              cached = true;
              return ready;
            }
            const checkout = path.join(home, 'base-checkout');
            await prepareCheckout(cwd, checkout, baseSha, signal);
            const listed = await listRegistry({
              checkout,
              targetDir: path.join(home, 'registry-base'),
              runner,
              signal,
              secrets,
              env,
            });
            if (!('reason' in listed)) writeCache(cache, listed.entries);
            return listed;
          },
          signal,
        );
      } catch (error) {
        if (signal?.aborted || error.code === 'cancelled') throw error;
        return {
          registry: { status: 'incomplete', reason: `base_checkout: ${String(error.message).slice(0, 300)}` },
        };
      }
      if ('reason' in before) return { registry: { status: 'incomplete', reason: `base_${before.reason}` } };
    }
  }
  const compared = compareRegistry({ base: before.entries, head: after.entries, removals, skips, permissions });
  return {
    registry: {
      status: 'compared',
      base: compared.base,
      head: compared.head,
      ...(baseIsRust ? {} : { baseRegistry: 'absent' }),
      ...(headIsRust ? {} : { headRegistry: 'absent' }),
      ...(cached ? { baseCached: true } : {}),
    },
    findings: compared.findings,
    permitted: compared.permitted,
  };
}

/** The packages a plain `cargo test` selects: `default-members`, else the root package, else every member. */
function defaultSelection(manifest) {
  const sections = new Map();
  let current = '';
  for (const raw of manifest.split(/\r?\n/)) {
    const header = /^\s*\[\s*([\w.-]+)\s*\]\s*(?:#.*)?$/.exec(raw);
    if (header) current = header[1];
    else sections.set(current, `${sections.get(current) ?? ''}${raw}\n`);
  }
  const list = (text, key) => {
    const match = new RegExp(`(?:^|\\n)\\s*${key}\\s*=\\s*\\[([^\\]]*)\\]`).exec(text ?? '');
    return match ? [...match[1].matchAll(/"([^"]*)"/g)].map(item => item[1].replace(/\/+$/, '') || '.') : null;
  };
  const workspace = sections.get('workspace');
  return (
    list(workspace, 'default-members') ?? (sections.has('package') ? ['.'] : (list(workspace, 'members') ?? ['.']))
  );
}

/**
 * `test_selection_narrowed`: the project tests with a plain `cargo test` (no `--workspace`,
 * no `--all`), and the root manifest now selects fewer packages by default.
 * @param {{ base: string | null, head: string | null, commands: { command: string, args?: string[] }[] }} input
 */
export function selectionNarrowed({ base, head, commands }) {
  const plain = commands.some(
    item =>
      /(?:^|[\\/])cargo(?:\.exe)?$/i.test(item.command) &&
      (item.args ?? []).includes('test') &&
      !(item.args ?? []).some(arg => arg === '--workspace' || arg === '--all'),
  );
  if (!plain || base === null || head === null) return null;
  const after = new Set(defaultSelection(head));
  const lost = defaultSelection(base).filter(member => !after.has(member));
  return lost.length ? lost : null;
}
