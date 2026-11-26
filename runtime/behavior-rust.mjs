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
export {
  packageName,
  harnessFreeTargets,
  strictlyInside,
  withBaseLock,
  compareRegistry,
  rustRegistryCheck,
  selectionNarrowed,
} from './behavior-rust-registry.mjs';

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
