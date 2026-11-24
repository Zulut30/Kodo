// Tokenize only the Rust syntax needed for literal file dependencies. A string
// is one opaque token, even when its contents look like an attribute or macro.
function tokensOf(text) {
  const tokens = [];
  const token =
    /\s+|\/\/[^\n]*|\/\*|(?:br|cr|r)(#*)"|[bc]?"|(?:b)?'(?:\\(?:u\{[\da-fA-F_]+\}|x[\da-fA-F]{2}|[^\n])|[^'\\\n])'|[\p{ID_Continue}]+|./gsuy;
  const comment = /\/\*|\*\//g;
  const quoted = /(?:\\[\s\S]|[^"\\])*"/y;
  for (let i = 0; i < text.length;) {
    token.lastIndex = i;
    const match = token.exec(text);
    const word = match[0];
    i = token.lastIndex;
    if (/^\s|^\/\//.test(word)) continue;
    if (word === '/*') {
      comment.lastIndex = i;
      let depth = 1;
      while (depth) {
        const delimiter = comment.exec(text);
        if (!delimiter) return null;
        depth += delimiter[0] === '/*' ? 1 : -1;
      }
      i = comment.lastIndex;
    } else if (match[1] !== undefined) {
      const end = '"' + match[1],
        close = text.indexOf(end, i);
      if (close < 0) return null;
      tokens.push({ literal: word.startsWith('r') ? text.slice(i, close) : null });
      i = close + end.length;
    } else if (word.endsWith('"')) {
      quoted.lastIndex = i;
      const string = quoted.exec(text);
      if (!string) return null;
      const value = string[0].slice(0, -1);
      tokens.push({ literal: word === '"' && !value.includes('\\') ? value : null });
      i = quoted.lastIndex;
    } else tokens.push(word);
  }
  return tokens;
}

const closing = new Map([
  ['(', ')'],
  ['[', ']'],
  ['{', '}'],
]);
// cfg_attr(predicate, attr, ...) permits nesting. Only top-level attribute
// arguments after its predicate are attributes; route(path=...) is opaque.
function attributePaths(tokens, start, paths) {
  if (tokens[start] === 'r' && tokens[start + 1] === '#') start += 2;
  if (tokens[start] === 'path' && tokens[start + 1] === '=') {
    paths.push({ kind: 'path', value: tokens[start + 2]?.literal ?? null });
    return;
  }
  if (tokens[start] !== 'cfg_attr' || tokens[start + 1] !== '(') return;
  let depth = 0;
  for (let i = start + 2; i < tokens.length; i++) {
    const token = tokens[i];
    if (closing.has(token)) depth++;
    else if (token === ')' || token === ']' || token === '}') {
      if (!depth) break;
      depth--;
    } else if (!depth && token === ',') attributePaths(tokens, i + 1, paths);
  }
}

export function rustSourcePaths(text) {
  if (!/\b(?:include(?:_bytes|_str)?|path)\b/.test(text)) return [];
  const tokens = tokensOf(text);
  if (!tokens) return [{ kind: 'unknown', value: null }];
  const paths = [];
  for (let i = 0; i < tokens.length; i++) {
    const name = tokens[i];
    if (name === '#') {
      const bracket = tokens[i + 1] === '!' ? i + 2 : i + 1;
      if (tokens[bracket] === '[') attributePaths(tokens, bracket + 1, paths);
    }
    if (!['include', 'include_str', 'include_bytes'].includes(name) || tokens[i + 1] !== '!') continue;
    const end = closing.get(tokens[i + 2]);
    if (!end) continue;
    const last = tokens[i + 4] === ',' ? i + 5 : i + 4;
    paths.push({ kind: name, value: tokens[last] === end ? (tokens[i + 3]?.literal ?? null) : null });
  }
  return paths;
}
