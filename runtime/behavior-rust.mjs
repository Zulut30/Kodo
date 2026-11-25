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
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parse as parseToml } from 'smol-toml';
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

/**
 * The Cargo target a Rust file belongs to, read from its path, for comparing tests statically:
 * `''` for `src/**` (the library and the main binary), `bin x` for `src/bin/x…`, `test t` for
 * `tests/t.rs` and `tests/t/**` next to `tests/t/main.rs`, `test *` for a module shared by the
 * test targets (`tests/common/mod.rs`), and the same for `benches/` and `examples/`. A test that
 * moves to another target is a removed test and a new one, as libtest sees it.
 * @param {string} file
 * @param {boolean} [nestedCrate] The file's first directory under `tests/`, `benches/` or `examples/` has a `main.rs`.
 */
export function rustTargetGroup(file, nestedCrate = false) {
  const crate = rustCrateDir(file),
    parts = (crate ? file.slice(crate.length + 1) : file).split('/'),
    stem = name => name.replace(/\.rs$/i, '');
  if (parts[0] === 'src') return parts[1] === 'bin' && parts.length >= 3 ? `bin ${stem(parts[2])}` : '';
  const kind = { tests: 'test', benches: 'bench', examples: 'example' }[parts[0]];
  if (!kind) return '';
  if (parts.length === 2) return `${kind} ${stem(parts[1])}`;
  return nestedCrate || (parts.length === 3 && parts[2] === 'main.rs') ? `${kind} ${parts[1]}` : `${kind} *`;
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
 * The attributes an attribute stands for in a test build. `sure`: the attribute itself, or what
 * `cfg_attr(<true>, a, b)` applies, also nested. `maybe`: what `cfg_attr(<unknown>, …)` may
 * apply. `cfg_attr(<false>, …)` applies nothing.
 * @returns {{ sure: string[][], maybe: string[][] }}
 */
function expand(attribute, depth = 0) {
  const { path: name, rest } = attributePath(attribute);
  if (name !== 'cfg_attr') return { sure: [attribute], maybe: [] };
  if (depth > 8 || rest[0] !== '(' || groupEnd(rest, 0) !== rest.length - 1) return { sure: [], maybe: [] };
  const [predicate, ...applied] = split(rest.slice(1, -1));
  const value = predicate ? evaluateCfg(predicate) : 'F';
  const sure = [],
    maybe = [];
  if (value === 'F') return { sure, maybe };
  for (const part of applied) {
    const inner = expand(part, depth + 1);
    if (value === 'T') sure.push(...inner.sure);
    else maybe.push(...inner.sure);
    maybe.push(...inner.maybe);
  }
  return { sure, maybe };
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

/** `#[ignore]` in a test build (after `cfg_attr` is expanded). */
function ignores(attribute) {
  return attributePath(attribute).path === 'ignore';
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

/** Where a macro call's name ends: `name!`, `std::name!`, `::core::name!`. The index of `!`, or -1. */
function macroBang(statement) {
  let at = statement[0] === '::' ? 1 : 0;
  if (!isIdentifier(statement[at])) return -1;
  while (statement[at + 1] === '::' && isIdentifier(statement[at + 2])) at += 2;
  return statement[at + 1] === '!' ? at + 1 : -1;
}

/** Statements of a body: they end at a top-level `;` or with a block that closes a block-like statement. */
function statements(tokens) {
  const list = [];
  let current = [],
    depth = 0;
  const blockLike = statement => {
    if (['if', 'match', 'loop', 'while', 'for', 'unsafe', '{'].includes(statement[0])) return true;
    const bang = macroBang(statement);
    return bang > 0 && statement[bang + 1] === '{';
  };
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

/** A literal: a number, `true`/`false`, a character or a string (by the fingerprint of its text). */
const literalPattern = /^(?:"[0-9a-f]{8}"|'[0-9a-f]{8}'|\d[\p{XID_Continue}.]*|true|false)$/u;
/** Tokens without the parentheses that only wrap them: `((true))` is `true`. */
function unwrap(tokens) {
  let inner = tokens;
  while (inner[0] === '(' && inner.length > 1 && groupEnd(inner, 0) === inner.length - 1) inner = inner.slice(1, -1);
  return inner;
}
/** A literal operand, also negative: a name or a path (`f32::NAN`, a `const`) is not one. */
function literal(tokens) {
  const inner = unwrap(tokens);
  if (inner.length === 2 && inner[0] === '-') return literalPattern.test(inner[1]) && inner[1] !== 'true';
  return inner.length === 1 && literalPattern.test(inner[0]);
}
const sameLiteral = (left, right) =>
  left !== undefined && right !== undefined && literal(left) && unwrap(left).join(' ') === unwrap(right).join(' ');

const trivialMacros = new Set(['assert', 'debug_assert', 'assert_eq', 'debug_assert_eq']);

/**
 * An assertion that cannot fail: `assert!(true)`, `assert!(!false)`, `assert!((true))`, and
 * `assert!(x == x)` / `assert_eq!(x, x)` with the same literal on both sides (a number, a bool, a
 * character, a string). Names and paths are not literals: `assert_eq!(ACTUAL, ACTUAL)` with
 * `const ACTUAL: f32 = f32::NAN` fails. Also through `std::`/`core::` and with any delimiter.
 */
function trivialAssertion(statement) {
  let at = statement[0] === '::' ? 1 : 0;
  if ((statement[at] === 'std' || statement[at] === 'core') && statement[at + 1] === '::') at += 2;
  const name = statement[at];
  if (!trivialMacros.has(name) || statement[at + 1] !== '!' || !OPENING.has(statement[at + 2])) return false;
  const close = groupEnd(statement, at + 2);
  if (close !== statement.length - 1) return false;
  const args = split(statement.slice(at + 3, close));
  if (name.endsWith('_eq')) return sameLiteral(args[0], args[1]);
  const first = unwrap(args[0] ?? []);
  if (first.length === 1 && first[0] === 'true') return true;
  if (first[0] === '!' && unwrap(first.slice(1)).join(' ') === 'false') return true;
  const sides = split(first, '==');
  return sides.length === 2 && sameLiteral(sides[0], sides[1]);
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

/** Macros a token stream calls: `name!(`, `name! {`, `name! [` (comments and strings are already gone). */
function collectCalls(tokens, calls) {
  for (let at = 0; at < tokens.length - 2; at++)
    if (
      isIdentifier(tokens[at]) &&
      tokens[at + 1] === '!' &&
      OPENING.has(tokens[at + 2]) &&
      tokens[at] !== 'macro_rules'
    )
      calls.add(tokens[at]);
}

/** The tests a `macro_rules!` body would define: `#[test] fn name` or `#[test] fn $name`, with their bodies. */
function templateTests(tokens) {
  const tests = [];
  let attributes = [];
  for (let at = 0; at < tokens.length; at++) {
    const token = tokens[at];
    if (token === '#' && tokens[at + 1] === '[') {
      const close = groupEnd(tokens, at + 1);
      attributes.push(...expand(tokens.slice(at + 2, close)).sure);
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
 * nested; a test only through `cfg_attr(<unknown>, test)` is a case that may or
 * may not exist (`maybe`): the reading never reports it gone, the registry
 * judges it. A test is switched off by `#[ignore]` (`off: 'ignore'`) or by a
 * `cfg` provably false in a test build on the function, a module around it or
 * the file (`off: 'cfg'`). A `macro_rules!` body is a template: its tests are
 * kept apart (`templates`, with `exported` for `#[macro_export]`), with the
 * macros the file calls (`calls`).
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
    maybes = [],
    pending = null,
    index = 0;
  const reset = () => {
    attributes = [];
    maybes = [];
  };
  while (index < length) {
    const token = tokens[index];
    if (token === '#' && (tokens[index + 1] === '[' || (tokens[index + 1] === '!' && tokens[index + 2] === '['))) {
      const inner = tokens[index + 1] === '!',
        open = inner ? index + 2 : index + 1,
        close = groupEnd(tokens, open),
        effective = expand(tokens.slice(open + 1, close));
      // An inner attribute (`#![cfg(…)]`) belongs to the module or file it stands in.
      if (inner) scopes[scopes.length - 1].off ||= effective.sure.some(cfgOff);
      else {
        attributes.push(...effective.sure);
        maybes.push(...effective.maybe);
      }
      index = close + 1;
    } else if (token === 'macro_rules' && tokens[index + 1] === '!') {
      let open = index + 2;
      const name = isIdentifier(tokens[open]) ? tokens[open++] : '';
      const close = OPENING.has(tokens[open]) ? groupEnd(tokens, open) : open - 1;
      const body = close > open ? tokens.slice(open + 1, close) : [];
      // Every template is kept with the macros its body calls: a wrapper reaches the templates it expands.
      if (name) {
        const inner = new Set();
        collectCalls(body, inner);
        inner.delete(name);
        templates.push({
          name,
          tests: templateTests(body),
          calls: inner,
          exported: attributes.some(item => attributePath(item).path === 'macro_export'),
        });
      }
      index = close + 1;
      reset();
    } else if (token === '{') {
      depth++;
      if (pending) scopes.push({ ...pending, depth });
      pending = null;
      reset();
      index++;
    } else if (token === '}') {
      if (scopes.length > 1 && scopes[scopes.length - 1].depth === depth) scopes.pop();
      depth = Math.max(0, depth - 1);
      pending = null;
      reset();
      index++;
    } else if (token === ';') {
      pending = null;
      reset();
      index++;
    } else if (token === 'mod') {
      const name = tokens[index + 1];
      pending = isIdentifier(name) ? { name, off: attributes.some(cfgOff) } : null;
      reset();
      index += 2;
    } else if (token === 'fn') {
      const name = tokens[index + 1],
        own = attributes,
        maybe = !own.some(isTestAttribute) && maybes.some(isTestAttribute);
      reset();
      index += 2;
      if (!isIdentifier(name) || (!maybe && !own.some(isTestAttribute))) continue;
      const { open, stop } = bodyStart(tokens, index);
      if (open === undefined) {
        index = /** @type {number} */ (stop) + 1;
        continue;
      }
      const close = groupEnd(tokens, open),
        body = tokens.slice(open + 1, close);
      collectCalls(body, calls);
      bodies.push(body.join(' '));
      const off = own.some(cfgOff) || scopes.some(scope => scope.off) ? 'cfg' : own.some(ignores) ? 'ignore' : null;
      cases.push({
        name: [...prefix, ...scopes.slice(1).map(scope => scope.name), name].join('::'),
        skipped: off !== null,
        off,
        ...(maybe ? { maybe: true } : {}),
        body: body.join(' '),
        // Whether a test that may not exist checks anything is the registry's question.
        weak: maybe ? null : rustWeakness(body),
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

/**
 * The Rust tests of a file as `{ name, skipped }`, named as libtest prints them.
 * @param {string} file Repository-relative path: it gives the module path.
 * @param {string} source
 * @param {{ nestedCrate?: boolean }} [options]
 */
export const rustTestCases = (file, source, options = {}) =>
  rustCases(file, source, options).cases.map(({ name, skipped }) => ({ name, skipped }));

/** The macros a Rust source calls, read as tokens: a call in a comment or a string is no call. */
export const rustMacroCalls = source => rustCases('src/lib.rs', source).calls;

/**
 * How a Rust source uses macros, read as tokens: the macros it calls outside templates, and its
 * `macro_rules!` templates with the macros each one calls.
 */
export function rustMacroUse(source) {
  const { calls, templates } = rustCases('src/lib.rs', source);
  return { calls, templates };
}

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

/**
 * A path as the file system names it, case kept: symbolic links, `/private/var`, 8.3 names and
 * `\\?\` resolved. For `path.relative` and the directories the receipt shows.
 */
function canonicalPath(value) {
  // A path that does not exist yet is resolved through its nearest existing ancestor.
  let existing = path.resolve(value),
    rest = '';
  for (;;) {
    try {
      const resolved = realpathSync.native(existing);
      return (rest ? path.join(resolved, rest) : resolved).replace(/^\\\\\?\\(?!UNC\\)/, '');
    } catch {
      const parent = path.dirname(existing);
      if (parent === existing) return path.resolve(value).replace(/^\\\\\?\\(?!UNC\\)/, '');
      rest = rest ? path.join(path.basename(existing), rest) : path.basename(existing);
      existing = parent;
    }
  }
}
/** A key to compare paths with: case-insensitive on Windows, where the file system is. */
const pathKey = value => (process.platform === 'win32' ? value.toLowerCase() : value);
const canonicalKey = value => pathKey(canonicalPath(value));

/** The kind of a Cargo target as the registry compares it. */
const kindOf = kinds => ['bin', 'test', 'bench', 'example'].find(kind => kinds.split(',').includes(kind)) ?? 'lib';

/**
 * Targets declared with `harness = false` in a manifest, read with a TOML parser: libtest does
 * not run them, so their `--list` says nothing. @returns {Set<string>} `kind:name`
 */
export function harnessFreeTargets(manifest, packageNameValue) {
  const found = new Set();
  let value;
  try {
    value = parseToml(manifest);
  } catch {
    return found;
  }
  const lib = value.lib;
  if (lib && typeof lib === 'object' && lib.harness === false)
    found.add(`lib:${typeof lib.name === 'string' ? lib.name : packageNameValue.replace(/-/g, '_')}`);
  for (const kind of ['bin', 'test', 'bench', 'example'])
    for (const target of Array.isArray(value[kind]) ? value[kind] : [])
      if (target && target.harness === false && typeof target.name === 'string') found.add(`${kind}:${target.name}`);
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
 * --message-format=json` names the test executables with their package, target
 * and root file (`target.src_path`), and each one lists its tests (`--list
 * --format terse`) and its ignored tests (`… --ignored`). A `harness = false`
 * target is not run: it is one entry with an empty name, so the target itself
 * is tracked.
 * @param {{ checkout: string, targetDir?: string, runner: any, signal?: AbortSignal, secrets?: any,
 *   env: Record<string, string> }} input `targetDir`: a target directory of its own (the base).
 * @returns {Promise<any>} `{ entries }`, each `{ package, kind, target, dir, src, name, ignored }`, or `{ reason }`.
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
  const root = canonicalPath(checkout),
    relative = value => path.relative(root, canonicalPath(value)).split(path.sep).join('/'),
    manifests = new Map(),
    entries = [],
    // Every test target with its root file, also one that lists no test: its files belong to it.
    targets = [];
  for (const [executable, message] of executables) {
    const manifest = message.manifest_path ?? path.join(checkout, 'Cargo.toml'),
      where = path.dirname(manifest),
      packageValue = packageName(String(message.package_id ?? '')),
      kind = [].concat(message.target?.kind ?? []).join(','),
      target = String(message.target?.name ?? '');
    // Both sides canonical, case kept: a path through `/private/var`, an 8.3 name or `\\?\` is the same.
    const entry = {
      package: packageValue,
      kind,
      target,
      dir: relative(where),
      src: message.target?.src_path ? relative(message.target.src_path) : '',
    };
    targets.push(entry);
    if (!manifests.has(manifest)) {
      let text = '';
      try {
        text = readFileSync(manifest, 'utf8');
      } catch {
        // A manifest that cannot be read declares no harness-free target.
      }
      manifests.set(manifest, harnessFreeTargets(text, packageValue));
    }
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
  return { entries, targets };
}

/**
 * Whether `checkout` lies strictly inside `home`, both canonical: a link that leads elsewhere, or
 * another drive (`path.relative` gives an absolute path there), is outside.
 */
export function strictlyInside(home, checkout) {
  const relative = path.relative(canonicalPath(home), canonicalPath(checkout));
  return (
    relative !== '' &&
    !path.isAbsolute(relative) &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !relative.startsWith('../')
  );
}

/** Whether the repository at `cwd` has `checkout` registered as one of its worktrees. */
async function registeredIn(cwd, checkout) {
  const listed = await execute('git', ['worktree', 'list', '--porcelain'], {
    cwd,
    allowFailure: true,
    timeoutMs: 60000,
  });
  return (
    listed.code === 0 &&
    listed.stdout
      .split(/\r?\n/)
      .filter(line => line.startsWith('worktree '))
      .some(line => canonicalKey(line.slice(9)) === canonicalKey(checkout))
  );
}

/**
 * A checkout of this repository's own: its `.git` exists, Git names it as the top of its work
 * tree, and the repository at `cwd` has it registered.
 */
async function commonDir(cwd) {
  const result = await execute('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
    cwd,
    allowFailure: true,
    timeoutMs: 60000,
  });
  return result.code === 0 ? canonicalKey(result.stdout.trim()) : null;
}

/**
 * A checkout path whose own Git metadata belongs to another repository (a stale registration
 * reused by another clone) is never touched: no checkout, clean, removal or deletion.
 */
async function foreignCheckout(cwd, checkout) {
  if (!existsSync(path.join(checkout, '.git'))) return false;
  try {
    const [own, theirs] = await Promise.all([commonDir(cwd), commonDir(checkout)]);
    return Boolean(own && theirs && own !== theirs);
  } catch {
    return false;
  }
}

async function healthyCheckout(cwd, checkout) {
  if (!existsSync(path.join(checkout, '.git'))) return false;
  if (await foreignCheckout(cwd, checkout)) return false;
  try {
    const top = await execute('git', ['rev-parse', '--show-toplevel'], {
      cwd: checkout,
      allowFailure: true,
      timeoutMs: 60000,
    });
    return (
      top.code === 0 &&
      canonicalKey(top.stdout.trim()) === canonicalKey(checkout) &&
      (await registeredIn(cwd, checkout))
    );
  } catch {
    return false;
  }
}

/**
 * Remove and add the base checkout again, under the repository's worktree lock, also after a
 * cancelled gate (no signal, bounded waits): `worktree remove --force --force`; a directory that
 * survives is deleted only when it lies inside the registry home; then `worktree prune` and `add`.
 */
async function rebuildCheckout(cwd, home, checkout, baseSha) {
  await withWorktreeLock(
    cwd,
    async () => {
      // Checked again under the lock, just before Git and the file system act on it.
      if (!strictlyInside(home, checkout)) throw new Error(`base checkout ${checkout} is outside the registry home`);
      if (await foreignCheckout(cwd, checkout))
        throw new Error(`base checkout ${checkout} belongs to another repository and is left untouched`);
      const options = { cwd, allowFailure: true, timeoutMs: 60000 };
      await execute('git', ['worktree', 'remove', '--force', '--force', checkout], options);
      if (existsSync(checkout)) rmSync(checkout, { recursive: true, force: true });
      await execute('git', ['worktree', 'prune'], options);
      await execute('git', ['worktree', 'add', '--detach', '--quiet', checkout, baseSha], { cwd, timeoutMs: 600000 });
    },
    undefined,
    120000,
  );
}

/**
 * The base checkout at a stable path, at `baseSha`, clean. A stable path keeps Cargo's
 * fingerprints of the workspace crates, so a repeated base builds incrementally. Git is run
 * inside it only when its own `.git` is there: otherwise Git would climb to an outer repository.
 */
async function prepareCheckout(cwd, home, checkout, baseSha, signal) {
  // Before any Git command or deletion: the checkout, as the file system resolves it, is in the home.
  if (!strictlyInside(home, checkout)) throw new Error(`base checkout ${checkout} is outside the registry home`);
  if (await foreignCheckout(cwd, checkout))
    throw new Error(`base checkout ${checkout} belongs to another repository and is left untouched`);
  if (await healthyCheckout(cwd, checkout)) {
    try {
      const options = { cwd: checkout, allowFailure: true, signal };
      const moved = await execute('git', ['checkout', '--detach', '--force', '--quiet', baseSha], options);
      const cleaned = moved.code === 0 && (await execute('git', ['clean', '-ffdxq'], options));
      if (cleaned && cleaned.code === 0) return;
    } catch (error) {
      if (signal?.aborted || error.code === 'cancelled') throw error;
      // A broken checkout is added again below.
    }
  }
  await rebuildCheckout(cwd, home, checkout, baseSha);
  if (!(await healthyCheckout(cwd, checkout))) throw new Error('base checkout could not be prepared');
}

/**
 * A lock across processes on the base build directory, for the whole preparation, build and
 * listing: two gates must not overwrite each other's base executables (the same path for
 * different bases). An SQLite write transaction, as the worktree lock: process death releases it.
 */
export async function withBaseLock(home, action, signal = undefined, waitMs = 4 * 60 * 60 * 1000) {
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
      await delay(Math.min(200, waitMs), undefined, { signal });
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
  const key = createHash('sha256').update(canonicalKey(common)).digest('hex').slice(0, 16);
  return path.join(stateHome(), 'registry', key);
}

/** The directory whose files are modules of a target root: `src/lib.rs` → `src`, `tests/t.rs` → `tests/t`. */
function moduleDir(src) {
  const dir = path.posix.dirname(src),
    base = path.posix.basename(src);
  return ['lib.rs', 'main.rs', 'mod.rs'].includes(base)
    ? dir
    : `${dir === '.' ? '' : `${dir}/`}${base.replace(/\.rs$/i, '')}`;
}

/**
 * The Cargo targets a file can belong to, from the roots Cargo reported (`target.src_path`): the
 * target whose root it is; else the targets whose module directory holds it most closely
 * (`src/util.rs` of a package with a library and a binary: both); else, for a module shared by
 * the test targets (`tests/common/mod.rs`), every target of that kind in its package.
 */
function targetsOf(targets) {
  const memo = new Map();
  const prefix = dir => (dir ? `${pathKey(dir)}/` : '');
  return file => {
    const key = pathKey(file);
    if (memo.has(key)) return memo.get(key);
    let found = targets.filter(target => target.src && pathKey(target.src) === key);
    if (!found.length) {
      const covering = targets
        .filter(target => target.src && key.startsWith(prefix(moduleDir(target.src))))
        .map(target => ({ target, depth: moduleDir(target.src).length }));
      const deepest = Math.max(-1, ...covering.map(item => item.depth));
      found = covering.filter(item => item.depth === deepest).map(item => item.target);
    }
    if (!found.length) {
      const owner = targets
        .filter(target => key.startsWith(prefix(target.dir)))
        .reduce((best, target) => (best === null || target.dir.length > best.length ? target.dir : best), null);
      const kind =
        owner === null
          ? null
          : { tests: 'test', benches: 'bench', examples: 'example' }[key.slice(prefix(owner).length).split('/')[0]];
      if (kind) found = targets.filter(target => pathKey(target.dir) === pathKey(owner) && target.kind === kind);
    }
    const result = new Set(found.map(target => target.key));
    memo.set(key, result);
    return result;
  };
}

/**
 * Compare the registry of the base and the head. A test gone from the head, or ignored there and
 * not on the base, that the reading of the source has not explained is a finding. Every
 * explanation is matched to one base entry — (package, target kind, target, name), the target
 * from the roots Cargo reported — and used once:
 * - `reported`, `cfg`: a removal or a provably false `cfg` the reading already reported as a
 *   finding; it may stand for any target its file can belong to.
 * - `skips`: an `#[ignore]` the reading reported; only for a test ignored now.
 * - `moved`: a test the reading saw move to another file of the same target; it explains the
 *   loss only when the registry of the head shows the test gained in that file's target, and
 *   with the same activity: an active test that arrives ignored is `test_skipped`.
 * - `permitted`: a removal this run may make (`testRemovalAllowed`, also a whole permitted file
 *   that is gone: an empty name). It covers a loss only in a target confirmed for its file: the
 *   file's one target, or the one target of the file that had that test on the base; a gone
 *   file covers only the target whose root it was.
 * A `harness = false` target is one entry with an empty name. `targets` are every test target
 * Cargo built, with its root file, also those that list no test: a file is matched against them.
 * @param {{ base: any[], head: any[], targets?: any[], reported?: any[], cfg?: any[], skips?: any[], moved?: any[], permitted?: any[] }} input
 */
export function compareRegistry({
  base,
  head,
  targets: built = [],
  reported = [],
  cfg = [],
  skips = [],
  moved = [],
  permitted = [],
}) {
  const targetKey = entry => `${entry.package}\u0000${entry.kind}\u0000${entry.target}`;
  const key = entry => `${targetKey(entry)}\u0000${entry.name}`;
  const targets = new Map();
  for (const entry of [...built, ...base, ...head])
    if (!targets.has(targetKey(entry)))
      targets.set(targetKey(entry), {
        key: targetKey(entry),
        dir: entry.dir,
        src: entry.src ?? '',
        kind: kindOf(entry.kind),
      });
  const candidates = targetsOf([...targets.values()]);
  const roots = file =>
    new Set(
      [...targets.values()]
        .filter(target => target.src && pathKey(target.src) === pathKey(file))
        .map(target => target.key),
    );
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
  // What the head gained per test, as active and as ignored entries: a move must keep its activity.
  const gains = new Map();
  for (const [slot, counts] of after) {
    const old = before.get(slot) ?? { total: 0, active: 0 };
    const more = Math.max(0, counts.total - old.total),
      active = Math.min(more, Math.max(0, counts.active - old.active));
    if (more > 0) gains.set(slot, { active, ignored: more - active });
  }
  const byName = list => {
    const map = new Map();
    for (const item of list) {
      if (!map.has(item.name)) map.set(item.name, []);
      map.get(item.name).push(item);
    }
    return map;
  };
  const pools = {
    reported: byName([...reported, ...cfg]),
    skips: byName(skips),
    moved: byName(moved),
    permitted: byName(permitted),
  };
  const take = (pool, entry, accept) => {
    const list = pool.get(entry.name);
    const at = list ? list.findIndex(item => candidates(item.file).has(targetKey(entry)) && accept(item)) : -1;
    return at < 0 ? null : list.splice(at, 1)[0];
  };
  const any = () => true;
  /** The target of the file a test moved to that gained it as `kind` (`active` or `ignored`), or null. */
  const gainedIn = (item, kind) =>
    [...candidates(item.to)].find(target => (gains.get(`${target}\u0000${item.name}`)?.[kind] ?? 0) > 0) ?? null;
  const consume = (item, kind) => {
    const gain = gains.get(`${gainedIn(item, kind)}\u0000${item.name}`);
    if (gain) gain[kind]--;
  };
  const confirmed = entry => item => {
    // A gone file covers only the target whose root it was.
    if (item.name === '') return roots(item.file).has(targetKey(entry));
    const own = [...candidates(item.file)];
    return own.length === 1 || own.filter(target => before.has(`${target}\u0000${entry.name}`)).length === 1;
  };
  const gone = [],
    off = [],
    allowedByFile = new Map();
  for (const [slot, counts] of before) {
    const now = after.get(slot) ?? { total: 0, active: 0 };
    const removed = Math.max(0, counts.total - now.total);
    const switched = Math.max(0, Math.max(0, counts.active - removed) - now.active);
    // The entries gone from here that ran on the base come first.
    const removedActive = Math.min(removed, Math.max(0, counts.active - now.active));
    for (let index = 0; index < removed; index++) {
      if (take(pools.reported, counts.entry, any)) continue;
      const active = index < removedActive,
        same = active ? 'active' : 'ignored',
        other = active ? 'ignored' : 'active';
      const move =
        take(pools.moved, counts.entry, item => gainedIn(item, same) !== null) ??
        take(pools.moved, counts.entry, item => gainedIn(item, other) !== null);
      if (move) {
        const kept = gainedIn(move, same) !== null;
        consume(move, kept ? same : other);
        // A test that ran on the base and arrives ignored is switched off.
        if (!kept && active) off.push(counts.entry);
        continue;
      }
      const item = take(pools.permitted, counts.entry, confirmed(counts.entry));
      if (!item) gone.push(counts.entry);
      // A permitted removal the reading saw is already in `allowed`; only a target the reading cannot see is added.
      else if (item.name === '') {
        if (!allowedByFile.has(item.file)) allowedByFile.set(item.file, new Set());
        allowedByFile.get(item.file).add(counts.entry);
      }
    }
    for (let left = switched; left > 0; left--) if (!take(pools.skips, counts.entry, any)) off.push(counts.entry);
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
    permitted: [...allowedByFile].map(([file, list]) => ({
      rule: 'test_deleted',
      file,
      detail: `test registry: tests are gone: ${names([...list])}`,
    })),
    base: count(before),
    head: count(after),
  };
}

/** Variables of the worker's environment that change what Cargo builds; output and network settings do not. */
const buildVariable = name =>
  /^(?:CARGO_|RUST)/i.test(name) && !/^(?:CARGO_TERM_|CARGO_HTTP_|CARGO_NET_|RUST_LOG$|RUST_BACKTRACE$)/i.test(name);

/** A file's SHA-256, or null when it does not exist. */
function fileHash(file) {
  try {
    return createHash('sha256').update(readFileSync(file)).digest('hex');
  } catch {
    return null;
  }
}

/**
 * What a cached base registry depends on: the commit, its `Cargo.lock`, the build variables of
 * the worker's environment (`RUSTFLAGS`, `CARGO_ENCODED_RUSTFLAGS`, `CARGO_BUILD_*`,
 * `CARGO_TARGET_*_RUSTFLAGS`, `CARGO_UNSTABLE_*`, `RUSTC`, `RUSTUP_TOOLCHAIN`, …), Cargo's own
 * configuration in `CARGO_HOME`, and the `cargo` and `rustc` versions as the base checkout
 * selects them (its `rust-toolchain`).
 */
async function cacheKey({ checkout, baseSha, env, runner, signal, secrets }) {
  const version = async command => {
    try {
      const result = await runner(command, ['--version'], { cwd: checkout, env, signal, secrets, allowFailure: true });
      return result.code === 0 ? String(result.stdout).trim() : `exit_${result.code}`;
    } catch (error) {
      if (signal?.aborted || error.code === 'cancelled') throw error;
      return 'unavailable';
    }
  };
  const variables = Object.entries(env)
    .filter(([name]) => buildVariable(name))
    .map(([name, value]) => [name.toUpperCase(), value])
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  const cargoHome = env.CARGO_HOME || path.join(os.homedir(), '.cargo');
  return createHash('sha256')
    .update(
      JSON.stringify([
        3, // the format of a cached registry: 3 keeps every target with its root file
        baseSha,
        fileHash(path.join(checkout, 'Cargo.lock')),
        variables,
        fileHash(path.join(cargoHome, 'config')),
        fileHash(path.join(cargoHome, 'config.toml')),
        await version('cargo'),
        await version('rustc'),
      ]),
    )
    .digest('hex');
}

function readCache(file) {
  try {
    const value = JSON.parse(readFileSync(file, 'utf8'));
    return Array.isArray(value?.entries) && Array.isArray(value?.targets) ? value : null;
  } catch {
    return null;
  }
}

function writeCache(file, { entries, targets }) {
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify({ entries, targets }));
    renameSync(temporary, file);
  } catch {
    // A cache that cannot be written only costs the next gate a build.
  }
}

/**
 * The base registry under the base lock: the stable checkout is prepared, the cache key is
 * computed in it, and a cached registry is used or the base is built and listed.
 */
async function baseRegistry({ cwd, home, baseSha, runner, signal, secrets, env }) {
  return withBaseLock(
    home,
    async () => {
      const checkout = path.join(home, 'base-checkout');
      try {
        await prepareCheckout(cwd, home, checkout, baseSha, signal);
      } catch (error) {
        if (signal?.aborted || error.code === 'cancelled') throw error;
        return { reason: `checkout: ${String(error.message).slice(0, 300)}` };
      }
      const cache = path.join(
        home,
        'cache',
        `${await cacheKey({ checkout, baseSha, env, runner, signal, secrets })}.json`,
      );
      const ready = readCache(cache);
      if (ready) return { ...ready, cached: true };
      const listed = await listRegistry({
        checkout,
        targetDir: path.join(home, 'registry-base'),
        runner,
        signal,
        secrets,
        env,
      });
      if (!('reason' in listed)) writeCache(cache, listed);
      return listed;
    },
    signal,
  );
}

/**
 * The registry check of a full gate on a Rust project: a root `Cargo.toml` on the base or the
 * head. A side without it is an empty registry (a new crate; a manifest removed). The head is
 * listed in the checked worktree. The base is listed in a checkout at a stable path under
 * Kodo's state directory, built into its own target directory (`registry-base`), never the
 * head's, under a lock across processes for the whole preparation, build and listing; a
 * finished base registry is cached (see `cacheKey`). `incomplete` — Cargo missing, a build or a
 * listing failed, the checkout broken — is never a pass.
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
  pools = {},
}) {
  const env = workerEnvironment();
  try {
    await runner('cargo', ['--version'], { cwd, signal, env, secrets, allowFailure: false });
  } catch (error) {
    if (signal?.aborted || error.code === 'cancelled') throw error;
    return { registry: { status: 'incomplete', reason: 'cargo_unavailable' } };
  }
  let after = /** @type {any} */ ({ entries: [] });
  if (headIsRust) {
    after = await listRegistry({ checkout: cwd, runner, signal, secrets, env });
    if ('reason' in after) return { registry: { status: 'incomplete', reason: `head_${after.reason}` } };
  }
  let before = /** @type {any} */ ({ entries: [] });
  if (baseIsRust) {
    try {
      const home = registryHome ?? (await registryHomeFor(cwd));
      before = await baseRegistry({ cwd, home, baseSha, runner, signal, secrets, env });
    } catch (error) {
      if (signal?.aborted || error.code === 'cancelled') throw error;
      before = { reason: `checkout: ${String(error.message).slice(0, 300)}` };
    }
    if ('reason' in before) return { registry: { status: 'incomplete', reason: `base_${before.reason}` } };
  }
  const compared = compareRegistry({
    base: before.entries,
    head: after.entries,
    targets: [...(before.targets ?? []), ...(after.targets ?? [])],
    ...pools,
  });
  return {
    registry: {
      status: 'compared',
      base: compared.base,
      head: compared.head,
      ...(baseIsRust ? {} : { baseRegistry: 'absent' }),
      ...(headIsRust ? {} : { headRegistry: 'absent' }),
      ...(before.cached ? { baseCached: true } : {}),
    },
    findings: compared.findings,
    permitted: compared.permitted,
  };
}

/**
 * The packages a plain `cargo test` selects, from a manifest read with a TOML parser:
 * `default-members`, else the root package, else every member. Paths are compared as written
 * (`./` and a trailing `/` dropped), globs are not expanded. Null for a manifest that is not TOML.
 */
function defaultSelection(manifest) {
  let value;
  try {
    value = parseToml(manifest);
  } catch {
    return null;
  }
  const clean = list =>
    Array.isArray(list)
      ? list.filter(item => typeof item === 'string').map(item => item.replace(/^\.\/+/, '').replace(/\/+$/, '') || '.')
      : null;
  const workspace = value.workspace && typeof value.workspace === 'object' ? value.workspace : {};
  return clean(workspace['default-members']) ?? (value.package ? ['.'] : (clean(workspace.members) ?? ['.']));
}

/**
 * `test_selection_narrowed`: the project tests with a plain `cargo test` (no `--workspace`, no
 * `--all`, no `-p`/`--package`), and the root manifest now selects fewer packages by default.
 * @param {{ base: string | null, head: string | null, commands: { command: string, args?: string[] }[] }} input
 */
export function selectionNarrowed({ base, head, commands }) {
  const plain = commands.some(
    item =>
      /(?:^|[\\/])cargo(?:\.exe)?$/i.test(item.command) &&
      (item.args ?? []).includes('test') &&
      !(item.args ?? []).some(arg => /^(?:--workspace|--all|-p.*|--package(?:=.*)?)$/.test(arg)),
  );
  if (!plain || base === null || head === null) return null;
  const before = defaultSelection(base),
    after = defaultSelection(head);
  if (!before || !after) return null;
  const now = new Set(after);
  const lost = before.filter(member => !now.has(member));
  return lost.length ? lost : null;
}
