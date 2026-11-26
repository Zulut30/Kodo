import { collapse, isIdentChar } from './api-cards-lexical.mjs';

// ---- JS/TS public API extractor ---------------------------------------------

const REGEX_PREFIX_CHARS = new Set([
  '(',
  '[',
  '{',
  ',',
  ';',
  ':',
  '=',
  '!',
  '&',
  '|',
  '?',
  '~',
  '^',
  '+',
  '-',
  '*',
  '%',
  '<',
  '>',
]);
const REGEX_PREFIX_WORDS = new Set([
  'return',
  'throw',
  'case',
  'in',
  'of',
  'typeof',
  'void',
  'delete',
  'new',
  'yield',
  'await',
  'else',
  'do',
  'export',
  'default',
]);

function canStartJsRegex(code, i) {
  let prev = i - 1;
  while (prev >= 0 && /\s/.test(code[prev])) prev--;
  if (prev < 0) return true;
  if (REGEX_PREFIX_CHARS.has(code[prev])) return true;
  if (isIdentChar(code[prev])) {
    let start = prev;
    while (start > 0 && isIdentChar(code[start - 1])) start--;
    // A name after `.` or `?.` is a property (`config.default / 2`), never a keyword before a regex.
    if (afterPropertyDot(code, start)) return false;
    const word = code.slice(start, prev + 1).join('');
    return REGEX_PREFIX_WORDS.has(word);
  }
  return false;
}

function afterPropertyDot(code, start) {
  let before = start - 1;
  while (before >= 0 && /\s/.test(code[before])) before--;
  return before >= 0 && code[before] === '.' && code[before - 1] !== '.';
}

function scanJsRegex(source, start) {
  let j = start + 1;
  let inClass = false;
  while (j < source.length) {
    const ch = source[j];
    if (ch === '\\') {
      if (j + 1 >= source.length || source[j + 1] === '\n' || source[j + 1] === '\r') return -1;
      j += 2;
      continue;
    }
    if (ch === '\n' || ch === '\r') return -1;
    if (ch === '[') inClass = true;
    else if (ch === ']' && inClass) inClass = false;
    else if (ch === '/' && !inClass) {
      j++;
      while (j < source.length && /[a-zA-Z]/.test(source[j])) j++;
      return j;
    }
    j++;
  }
  return -1;
}

function maskJsTs(source) {
  // Use UTF-16 code-unit arrays so mask indices stay aligned with source[i] and .slice() even for non-BMP chars.
  const code = source.split('');
  const noComments = source.split('');
  const blank = (arr, from, to) => {
    for (let k = from; k < to; k++) if (arr[k] !== '\n') arr[k] = ' ';
  };
  let i = 0;
  while (i < source.length) {
    const ch = source[i],
      next = source[i + 1];
    if (ch === '/' && next === '/') {
      let j = i + 2;
      while (j < source.length && source[j] !== '\n') j++;
      blank(code, i, j);
      blank(noComments, i, j);
      i = j;
      continue;
    }
    if (ch === '/' && next === '*') {
      let j = i + 2;
      while (j < source.length && !(source[j] === '*' && source[j + 1] === '/')) j++;
      j = Math.min(source.length, j + 2);
      blank(code, i, j);
      blank(noComments, i, j);
      i = j;
      continue;
    }
    if (ch === '/' && canStartJsRegex(code, i)) {
      const end = scanJsRegex(source, i);
      if (end !== -1) {
        blank(code, i, end);
        code[i] = 'r';
        code[end - 1] = 'r';
        i = end;
        continue;
      }
    }
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      while (j < source.length) {
        if (source[j] === '\\') j += 2;
        else if (source[j] === ch) {
          j++;
          break;
        } else j++;
      }
      blank(code, i + 1, Math.max(i + 1, j - 1));
      i = j;
      continue;
    }
    if (ch === '`') {
      let j = i + 1;
      while (j < source.length) {
        if (source[j] === '\\') j += 2;
        else if (source[j] === '$' && source[j + 1] === '{') {
          j += 2;
          let inner = 1;
          while (j < source.length && inner > 0) {
            if (source[j] === '\\') j += 2;
            else if (source[j] === '{') {
              inner++;
              j++;
            } else if (source[j] === '}') {
              inner--;
              j++;
            } else j++;
          }
        } else if (source[j] === '`') {
          j++;
          break;
        } else j++;
      }
      blank(code, i + 1, Math.max(i + 1, j - 1));
      i = j;
      continue;
    }
    i++;
  }
  return { code: code.join(''), noComments: noComments.join('') };
}

function isQuote(ch) {
  return ch === '"' || ch === "'" || ch === '`';
}

function skipStringLiteral(code, start) {
  const quote = code[start];
  let i = start + 1;
  while (i < code.length && code[i] !== quote) i++;
  return i < code.length ? i + 1 : code.length;
}

function skipBalanced(code, start, open, close) {
  let depth = 0;
  let i = start;
  while (i < code.length) {
    if (isQuote(code[i])) {
      i = skipStringLiteral(code, i);
      continue;
    }
    if (code[i] === open) depth++;
    else if (code[i] === close && !(close === '>' && code[i - 1] === '=')) {
      depth--;
      if (depth === 0) return i + 1;
    }
    i++;
  }
  return code.length;
}

function skipWs(code, i) {
  while (i < code.length && /\s/.test(code[i])) i++;
  return i;
}

function nextNonSpaceOnSameOrLaterLine(code, i) {
  return skipWs(code, i);
}

function lastNonSpaceBefore(code, i) {
  let j = i - 1;
  while (j >= 0 && /[ \t\r]/.test(code[j])) j--;
  return j;
}

function findReexportEnd(code, start) {
  let brace = 0,
    i = start;
  while (i < code.length) {
    const ch = code[i];
    if (ch === '{') brace++;
    else if (ch === '}' && brace > 0) brace--;
    else if (brace === 0 && (ch === ';' || (ch === '\n' && /\bfrom\b|\}/.test(code.slice(start, i))))) break;
    i++;
  }
  return { sigEnd: i, skipTo: i };
}

const TYPE_START_WORDS = new Set(['is', 'asserts', 'keyof', 'readonly', 'typeof', 'infer', 'extends', 'new', 'unique']);
const TYPE_CONT_CHARS = new Set([':', '|', '&', '?', ',']);

function scanReturnTypeEnd(code, start) {
  let i = start;
  let expectType = true;
  while (i < code.length) {
    const ch = code[i];
    if (ch === ' ' || ch === '\t' || ch === '\r') {
      i++;
      continue;
    }
    if (ch === '\n') {
      const nextIdx = nextNonSpaceOnSameOrLaterLine(code, i + 1);
      const nextChar = code[nextIdx];
      if (!expectType && nextChar !== '{' && nextChar !== '|' && nextChar !== '&' && nextChar !== '?') {
        return { sigEnd: i, skipTo: i + 1 };
      }
      i++;
      continue;
    }
    if (isQuote(ch)) {
      i = skipStringLiteral(code, i);
      expectType = false;
      continue;
    }
    if (ch === ';') return { sigEnd: i, skipTo: i + 1 };
    if (ch === '{') {
      if (!expectType) return { sigEnd: i, skipTo: i };
      i = skipBalanced(code, i, '{', '}');
      expectType = false;
      continue;
    }
    if (ch === '(') {
      i = skipBalanced(code, i, '(', ')');
      expectType = false;
      continue;
    }
    if (ch === '[') {
      i = skipBalanced(code, i, '[', ']');
      expectType = false;
      continue;
    }
    if (ch === '<') {
      i = skipBalanced(code, i, '<', '>');
      expectType = false;
      continue;
    }
    if (ch === '=' && code[i + 1] === '>') {
      expectType = true;
      i += 2;
      continue;
    }
    if (TYPE_CONT_CHARS.has(ch)) {
      expectType = true;
      i++;
      continue;
    }
    if (isIdentChar(ch)) {
      let j = i;
      while (j < code.length && isIdentChar(code[j])) j++;
      const word = code.slice(i, j);
      expectType = TYPE_START_WORDS.has(word);
      i = j;
      continue;
    }
    expectType = false;
    i++;
  }
  return { sigEnd: code.length, skipTo: code.length };
}

function findFunctionDeclEnd(code, start) {
  let i = start;
  let sawParams = false;
  while (i < code.length) {
    const ch = code[i];
    if (ch === '<') {
      i = skipBalanced(code, i, '<', '>');
      continue;
    }
    if (ch === '(') {
      i = skipBalanced(code, i, '(', ')');
      sawParams = true;
      break;
    }
    if (ch === '{' || ch === ';') return { sigEnd: i, skipTo: i };
    i++;
  }
  if (!sawParams) return { sigEnd: code.length, skipTo: code.length };
  const after = skipWs(code, i);
  if (code[after] === '{') return { sigEnd: after, skipTo: after };
  if (code[after] === ';') return { sigEnd: after, skipTo: after + 1 };
  if (code[after] === ':') return scanReturnTypeEnd(code, after + 1);
  return { sigEnd: i, skipTo: i };
}

function findNamedDeclEnd(code, start) {
  let paren = 0,
    bracket = 0,
    angle = 0,
    i = start;
  while (i < code.length) {
    const ch = code[i];
    if (ch === '(') paren++;
    else if (ch === ')' && paren > 0) paren--;
    else if (ch === '[') bracket++;
    else if (ch === ']' && bracket > 0) bracket--;
    else if (ch === '<' && paren === 0) angle++;
    else if (ch === '>' && angle > 0 && code[i - 1] !== '=') angle--;
    else if (paren === 0 && bracket === 0 && angle === 0 && (ch === '{' || ch === ';')) return { sigEnd: i, skipTo: i };
    i++;
  }
  return { sigEnd: code.length, skipTo: code.length };
}

function isTypeLineContinuation(code, noComments, nlIndex) {
  const prevIdx = lastNonSpaceBefore(noComments, nlIndex);
  const prev = noComments[prevIdx];
  if (prev === '=' || prev === '|' || prev === '&' || prev === ',' || prev === '?' || prev === ':') return true;
  if (prev === '>' && noComments[prevIdx - 1] === '=') return true;
  const nextIdx = nextNonSpaceOnSameOrLaterLine(code, nlIndex + 1);
  const next = code[nextIdx];
  return next === '|' || next === '&' || next === '?' || next === ':' || code.startsWith('extends', nextIdx);
}

function findTypeAliasEnd(code, noComments, start) {
  let paren = 0,
    bracket = 0,
    brace = 0,
    angle = 0,
    sawEq = false,
    sawRhs = false,
    i = start;
  while (i < code.length) {
    const ch = code[i];
    if (ch === '(') {
      paren++;
      if (sawEq) sawRhs = true;
    } else if (ch === ')' && paren > 0) paren--;
    else if (ch === '[') {
      bracket++;
      if (sawEq) sawRhs = true;
    } else if (ch === ']' && bracket > 0) bracket--;
    else if (ch === '{') {
      brace++;
      if (sawEq) sawRhs = true;
    } else if (ch === '}' && brace > 0) brace--;
    else if (ch === '<' && paren === 0 && brace === 0) {
      angle++;
      if (sawEq) sawRhs = true;
    } else if (ch === '>' && angle > 0 && code[i - 1] !== '=') angle--;
    else if (paren === 0 && bracket === 0 && brace === 0 && angle === 0) {
      if (ch === '=' && code[i + 1] !== '>' && !sawEq) sawEq = true;
      else if (ch === ';') return { sigEnd: i, skipTo: i + 1 };
      else if (ch === '\n' && sawEq && sawRhs && !isTypeLineContinuation(code, noComments, i)) {
        return { sigEnd: i, skipTo: i + 1 };
      } else if (sawEq && !/\s/.test(noComments[i])) sawRhs = true;
    }
    i++;
  }
  return { sigEnd: code.length, skipTo: code.length };
}

const STMT_START = /^(?:export|import|const|let|var|function|class|interface|type|enum|async|declare|abstract)\b/;
const EXPR_CONT = new Set(['=', '+', '-', '*', '/', '%', '?', ':', ',', '|', '&', '.']);

function looksLikeArrowReturnType(code, bracePos) {
  const afterBrace = skipBalanced(code, bracePos, '{', '}');
  let i = skipWs(code, afterBrace);
  while (i < code.length) {
    if (code[i] === '=' && code[i + 1] === '>') return true;
    if (code[i] === '|' || code[i] === '&') {
      i = skipWs(code, i + 1);
      if (isQuote(code[i])) i = skipWs(code, skipStringLiteral(code, i));
      else if (code[i] === '{') i = skipWs(code, skipBalanced(code, i, '{', '}'));
      else if (code[i] === '(') i = skipWs(code, skipBalanced(code, i, '(', ')'));
      else if (code[i] === '[') i = skipWs(code, skipBalanced(code, i, '[', ']'));
      else {
        while (i < code.length && !/[\s|&=;{]/.test(code[i])) i++;
        i = skipWs(code, i);
      }
      continue;
    }
    return false;
  }
  return false;
}

function skipArrowBody(code, noComments, start) {
  const first = skipWs(code, start);
  if (code[first] === '{') return skipBalanced(code, first, '{', '}');
  let paren = 0,
    bracket = 0,
    brace = 0,
    i = first;
  while (i < code.length) {
    const ch = code[i];
    if (isQuote(ch)) {
      i = skipStringLiteral(code, i);
      continue;
    }
    if (ch === '(') paren++;
    else if (ch === ')' && paren > 0) paren--;
    else if (ch === '[') bracket++;
    else if (ch === ']' && bracket > 0) bracket--;
    else if (ch === '{') brace++;
    else if (ch === '}' && brace > 0) brace--;
    else if (paren === 0 && bracket === 0 && brace === 0) {
      if (ch === ';') return i + 1;
      if (ch === '\n' && isConstAsiEnd(code, noComments, i)) return i + 1;
    }
    i++;
  }
  return code.length;
}

function finalizeConstExport(noComments, eqPos, end) {
  const rhs = eqPos !== -1 ? noComments.slice(eqPos + 1, end).trim() : '';
  const keepValue = Boolean(rhs && !rhs.includes('\n') && rhs.length <= 80 && !/[{[]/.test(rhs));
  return eqPos !== -1 && !keepValue ? eqPos : end;
}

function isConstAsiEnd(code, _noComments, nlIndex) {
  const nextIdx = nextNonSpaceOnSameOrLaterLine(code, nlIndex + 1);
  if (nextIdx >= code.length) return true;
  const prevIdx = lastNonSpaceBefore(code, nlIndex);
  // `writer.\n  export()` is a property access across the line break, not a new statement.
  if (prevIdx >= 0 && code[prevIdx] === '.') return false;
  // A top-level `export` on the next line never continues an expression from the previous line.
  if (/^export\b/.test(code.slice(nextIdx))) return true;
  if (prevIdx >= 0 && EXPR_CONT.has(code[prevIdx])) return false;
  return code[nextIdx] === '}' || STMT_START.test(code.slice(nextIdx));
}

function stepBracketDepth(depth, ch, prevCh, inType) {
  if (ch === '(') depth.paren++;
  else if (ch === ')' && depth.paren > 0) depth.paren--;
  else if (ch === '[') depth.bracket++;
  else if (ch === ']' && depth.bracket > 0) depth.bracket--;
  else if (ch === '<' && inType && depth.paren === 0 && depth.bracket === 0 && depth.brace === 0) depth.angle++;
  else if (ch === '>' && depth.angle > 0 && prevCh !== '=') depth.angle--;
  else if (ch === '}' && depth.brace > 0) depth.brace--;
  else return false;
  return true;
}

function findConstExportEnd(code, noComments, start) {
  const depth = { paren: 0, bracket: 0, brace: 0, angle: 0 };
  const atTop = () => depth.paren === 0 && depth.bracket === 0 && depth.brace === 0 && depth.angle === 0;
  let hasTypeAnnotation = false,
    eqPos = -1,
    i = start;
  while (i < code.length) {
    const ch = code[i];
    if (isQuote(ch)) {
      i = skipStringLiteral(code, i);
      continue;
    }
    if (stepBracketDepth(depth, ch, code[i - 1], eqPos === -1)) {
      i++;
      continue;
    }
    if (ch === '{') {
      if (atTop() && eqPos !== -1) {
        if (looksLikeArrowReturnType(code, i)) {
          i = skipBalanced(code, i, '{', '}');
          continue;
        }
        return { sigEnd: eqPos, skipTo: i };
      }
      depth.brace++;
    } else if (atTop()) {
      if (ch === ':' && eqPos === -1) hasTypeAnnotation = true;
      else if (ch === '=' && code[i + 1] === '>') {
        if (eqPos === -1) {
          i += 2;
          continue;
        }
        return { sigEnd: hasTypeAnnotation ? eqPos : i + 2, skipTo: skipArrowBody(code, noComments, i + 2) };
      } else if (ch === '=' && code[i - 1] !== '=' && code[i + 1] !== '=' && eqPos === -1) eqPos = i;
      else if (ch === ';') return { sigEnd: finalizeConstExport(noComments, eqPos, i), skipTo: i + 1 };
      else if (ch === '\n' && eqPos !== -1 && isConstAsiEnd(code, noComments, i)) {
        return { sigEnd: finalizeConstExport(noComments, eqPos, i), skipTo: i + 1 };
      }
    }
    i++;
  }
  return { sigEnd: finalizeConstExport(noComments, eqPos, code.length), skipTo: code.length };
}

function findExportHeaderEnd(code, noComments, start) {
  const rest = code.slice(start);
  if (/^export\s+(?:type\s+)?(?:\{|\*)/.test(rest)) return findReexportEnd(code, start);
  if (/^export\s+(?:default\s+)?(?:declare\s+)?(?:async\s+)?function\b/.test(rest))
    return findFunctionDeclEnd(code, start);
  if (/^export\s+(?:default\s+)?(?:declare\s+)?(?:(?:abstract|const)\s+)?(?:class|interface|enum)\b/.test(rest))
    return findNamedDeclEnd(code, start);
  if (/^export\s+(?:declare\s+)?type\b/.test(rest)) return findTypeAliasEnd(code, noComments, start);
  return findConstExportEnd(code, noComments, start);
}

/**
 * Extract top-level `export` declarations (functions, classes, constants, types, interfaces,
 * enums, re-exports) from JS/TS source as single-line signatures without bodies.
 * @param {string} source
 * @returns {string[]}
 */
export function extractJsTsPublicApi(source) {
  if (typeof source !== 'string' || !source) return [];
  const { code, noComments } = maskJsTs(source);
  const signatures = [];
  let brace = 0,
    paren = 0,
    bracket = 0;

  for (let i = 0; i < code.length; i++) {
    const ch = code[i];
    if (isQuote(ch)) {
      i = skipStringLiteral(code, i) - 1;
      continue;
    }
    if (ch === '{') {
      brace++;
      continue;
    }
    if (ch === '}') {
      if (brace > 0) brace--;
      continue;
    }
    if (ch === '(') {
      paren++;
      continue;
    }
    if (ch === ')') {
      if (paren > 0) paren--;
      continue;
    }
    if (ch === '[') {
      bracket++;
      continue;
    }
    if (ch === ']') {
      if (bracket > 0) bracket--;
      continue;
    }
    if (brace !== 0 || paren !== 0 || bracket !== 0) continue;
    if (
      ch === 'e' &&
      code.startsWith('export', i) &&
      !isIdentChar(code[i - 1]) &&
      code[i - 1] !== '.' &&
      !afterPropertyDot(code, i) &&
      !/[A-Za-z0-9_$]/.test(code[i + 6] ?? '')
    ) {
      const { sigEnd, skipTo } = findExportHeaderEnd(code, noComments, i);
      const sig = collapse(noComments.slice(i, sigEnd)).replace(/;\s*$/, '').trim();
      if (sig) signatures.push(sig);
      i = Math.max(i, skipTo - 1);
    }
  }
  return signatures;
}
