import { rustCases } from './behavior-rust.mjs';

const MARK = '\u0001';
const languages = {
  ...Object.fromEntries('js mjs cjs jsx ts mts cts tsx'.split(' ').map(ext => [ext, 'js'])),
  py: 'py',
  rs: 'rs',
  go: 'go',
  java: 'java',
  kt: 'java',
};
export const languageOf = file => languages[file.slice(file.lastIndexOf('.') + 1).toLowerCase()];
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
      // `fun` declares a function only in Kotlin; in Java it is an ordinary name.
      if (word === 'void' || (kotlin && word === 'fun')) {
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
 * @param {{ nestedCrate?: boolean }} [options] Rust: the file belongs to a crate rooted at `tests/<dir>/main.rs`.
 */
export function casesOf(file, source, options = {}) {
  const language = languageOf(file);
  let parsed;
  if (language === 'js') parsed = jsCases(source);
  else if (language === 'py') parsed = pythonCases(source);
  else if (language === 'rs') parsed = rustCases(file, source, options);
  else if (language === 'go')
    parsed = {
      cases: [...source.matchAll(/^func\s+(Test\w+)\s*\(/gm)].map(match => ({ name: match[1], skipped: false })),
    };
  else if (language === 'java') parsed = { cases: javaCases(source, file.toLowerCase().endsWith('.kt')) };
  else return null;
  const code = parsed.code ?? source;
  return {
    cases: parsed.cases,
    ...(parsed.templates ? { templates: parsed.templates, calls: parsed.calls } : {}),
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
