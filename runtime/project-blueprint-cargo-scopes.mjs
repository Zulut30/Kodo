// A planned file has the same nearest Cargo manifest as a committed file.
// A directory alone supplies Rust source evidence only under its package's src subtree.
import path from 'node:path';
import {
  canDeferLiteralList,
  expandBlueprintScope,
  resolveRelativeDir,
  scopeClassEnd as classEnd,
  unwrapContractPathGroups,
} from './cargo-workspace.mjs';
import { braceBeforeExtglob, ownsScopePath, scopeBraceGroup, scopeGlobSyntax } from './scope-paths.mjs';
import { cargoScopeGlob, pathParents, scopeOwnership } from './project-blueprint-scope-index.mjs';

const join = (dir, name) => (dir ? dir + '/' + name : name);
const braceRange = /^(-?\d+)\.\.(-?\d+)(?:\.\.(-?\d+))?$|^([A-Za-z])\.\.([A-Za-z])(?:\.\.(-?\d+))?$/;
const dotFragment = /(?:^|[/{},])\.{1,2}(?=$|[/{},])/;
const hasNavigationFragment = text => dotFragment.test(text) || /[{,](?=[,}])/.test(text);

// Locate an entire group before inspecting its alternatives. A component-local
// extglob always goes to matchesGlob intact, including under +(), *() and !().
function groupAt(text, start, keepBraces = false) {
  if (text[start] === '{') return scopeBraceGroup(text, start);
  const arms = [];
  let depth = 1;
  let from = start + 1;
  for (let i = from; i < text.length; i++) {
    const ch = text[i];
    if (ch === '[') i = Math.max(i, classEnd(text, i));
    // While pruning a written arm, keep its braces intact. The subsequent
    // expansion decides which '|' or ')' the brace actually contributes.
    else if (keepBraces && ch === '{') i = scopeBraceGroup(text, i)?.end ?? i;
    else if (ch === '(') depth++;
    else if (ch === ')' && --depth === 0) {
      arms.push(text.slice(from, i));
      return { arms, end: i };
    } else if (ch === '|' && depth === 1) {
      arms.push(text.slice(from, i));
      from = i + 1;
    }
  }
  return null;
}

// A whole directory and a file selector can both own Cargo.toml. Only the
// latter signals a planned manifest in an existing module. When discovering a
// new root, also inspect which directory choice supplied the selected name.
function terminalSelector(pattern, includeDirectoryChoices) {
  const start = terminalPathStart(pattern);
  const name = pattern.slice(start);
  const from = includeDirectoryChoices ? 0 : start;
  const brace = braceBeforeExtglob(pattern, from, canDeferLiteralList);
  if (brace) return { name, choice: brace, unbounded: false };
  let choice = null;
  let unbounded = false;
  for (let i = from; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '[') i = Math.max(i, classEnd(pattern, i));
    else {
      const extglob = '@?+*!'.includes(ch) && pattern[i + 1] === '(';
      if (i >= start && (ch === '*' || (extglob && (ch === '!' || ch === '+')))) unbounded = true;
      const group = extglob || ch === '{' ? groupAt(pattern, extglob ? i + 1 : i) : null;
      if (!group) continue;
      if (ch === '@' && group.arms.length === 1) {
        i++;
        continue;
      }
      if (ch === '?' || ((ch === '@' || ch === '{') && group.arms.length > 1)) choice = { ...group, start: i };
      i = group.end;
    }
  }
  return { name, choice, unbounded };
}

export function selectsCargoManifest(scope, manifest, { concreteDirectory = false, finiteName = false } = {}) {
  const seen = new Set();
  function matches(pattern) {
    if (pattern === manifest) return true;
    if (seen.has(pattern)) return false;
    seen.add(pattern);
    if (!path.posix.matchesGlob(manifest, cargoScopeGlob(pattern))) return false;
    if (!concreteDirectory && !finiteName && !pattern.includes('*')) return true;
    const { name, choice, unbounded } = terminalSelector(pattern, concreteDirectory);
    if (!choice) {
      // Inferring a package root needs one matching branch to supply both
      // its directory and its manifest. A wildcard in a sibling cannot do so.
      const directory = pattern.slice(0, pattern.length - name.length);
      if (concreteDirectory && /[*?[{]|[+!]\(/.test(directory)) return false;
      if (finiteName && unbounded) return false;
      return !name.includes('*') || /[^*?+@()|]/.test(name);
    }
    const prefix = pattern.slice(0, choice.start);
    const suffix = pattern.slice(choice.end + 1);
    const operator = pattern[choice.start];
    // A singleton extglob still uses Node's glob matching rules. Removing
    // the operator would turn a case-folded Windows match into a literal.
    if (operator === '?' && matches(prefix + '@()' + suffix)) return true;
    return choice.arms.some(arm => matches(prefix + (operator === '{' ? arm : '@(' + arm + ')') + suffix));
  }
  return matches(scope);
}

// Each written slash establishes a parent directory. A slash inside a brace
// arm belongs to that arm alone. Keep preceding complete choices intact so
// unrelated filename alternatives never form a Cartesian product here.
function* directorySelectors(pattern, prefix = '') {
  if (!pattern.includes('{')) {
    if (prefix && pattern.startsWith('/')) yield prefix;
    for (const parent of pathParents(pattern)) yield prefix + parent;
    return;
  }
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] === '/') yield prefix + pattern.slice(0, i);
    if (pattern[i] !== '{') continue;
    const group = groupAt(pattern, i);
    if (!group) continue;
    for (const arm of group.arms) if (arm.includes('/')) yield* directorySelectors(arm, prefix + pattern.slice(0, i));
    i = group.end;
  }
}

// A slash inside a brace list belongs to one alternative. Other slashes
// separate path components even when an individual glob contains parentheses.
function terminalPathStart(scope) {
  if (!scope.includes('{')) return scope.lastIndexOf('/') + 1;
  let start = 0;
  for (let i = 0; i < scope.length; i++) {
    if (scope[i] === '/') start = i + 1;
    if (scope[i] !== '{') continue;
    const group = groupAt(scope, i);
    if (group && group.arms.length > 1) i = group.end;
  }
  return start;
}

// First find directory spellings. Filename alternatives in a different branch
// do not consume the expansion budget for a possible package directory.
function* manifestParentPatterns(scope) {
  const start = terminalPathStart(scope);
  const name = scope.slice(start);
  if (!scopeGlobSyntax.test(name) && name.toLowerCase() !== 'cargo.toml') return;
  const prefix = scope.slice(0, start);
  yield prefix.slice(0, -1);
  if (name.includes('/')) yield* directorySelectors(name, prefix);
}

// Past the limit, give each arm one slot per written alternative. A product
// that fills the original budget by itself must still leave its literal
// sibling reachable. Shared groups stay factored until the final bounded pass.
function smallerDirectoryPattern(pattern) {
  let result = '';
  let from = 0;
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] === '[') i = Math.max(i, classEnd(pattern, i));
    const brace = pattern[i] === '{';
    if (!brace && !pattern.startsWith('@(', i)) continue;
    const group = groupAt(pattern, brace ? i : i + 1, true);
    if (!group) continue;
    const arms = [];
    let changed = false;
    for (const arm of group.arms) {
      if (expandBlueprintScope(arm, 1) !== null) arms.push(arm);
      else {
        changed = true;
        const smaller = smallerDirectoryPattern(arm);
        if (smaller !== null) arms.push(smaller);
      }
    }
    if (!arms.length) return null;
    if (changed) {
      const replacement = brace
        ? arms.length === 1
          ? arms[0]
          : '{' + arms.join(',') + '}'
        : '@(' + arms.join('|') + ')';
      result += pattern.slice(from, i) + replacement;
      from = group.end + 1;
    }
    i = group.end;
  }
  return from ? result + pattern.slice(from) : null;
}

export function* selectedManifestRoots(scope, knownWorkspace = false) {
  if (/\.[\w-]+$/.test(scope) && !/\.toml$/i.test(scope)) return;
  const seen = new Set();
  for (const parent of manifestParentPatterns(scope)) {
    let dirs = expandBlueprintScope(parent);
    if (!dirs) {
      const smaller = smallerDirectoryPattern(parent);
      dirs = smaller === null ? [] : (expandBlueprintScope(smaller) ?? []);
    }
    for (const dir of dirs) {
      if (scopeGlobSyntax.test(dir)) continue;
      const root =
        dir && dir.split('/').some(part => !part || part === '.' || part === '..') ? resolveRelativeDir('', dir) : dir;
      if (root === null || seen.has(root)) continue;
      seen.add(root);
      if (
        selectsCargoManifest(scope, join(root, 'Cargo.toml'), { concreteDirectory: true, finiteName: !knownWorkspace })
      )
        yield root;
    }
  }
}

function directoryLayouts(scope) {
  if (!dotFragment.test(scope) && !scope.includes('//')) return [scope];
  const start = terminalPathStart(scope);
  const name = scope.slice(start);
  // A branch ending in an ordinary name supplies every parent. A terminal
  // dot, dot-dot or empty alternative can only remove parents from that set.
  const ordinary = !name.includes('/') && /[^.,{}]/.test(name);
  return normalizedScopeLayouts(ordinary ? scope.slice(0, start) + '_' : scope);
}

export function scopedDirectoryMatcher(scopes) {
  const parents = new Set();
  for (const scope of scopes) {
    for (const layout of directoryLayouts(scope)) for (const parent of directorySelectors(layout)) parents.add(parent);
  }
  return scopeOwnership(parents, (choices, dir) =>
    choices.some(
      pattern =>
        pattern === dir || (scopeGlobSyntax.test(pattern) && path.posix.matchesGlob(dir, cargoScopeGlob(pattern))),
    ),
  );
}

// Adjacent literal choices attached to a fixed filename stem cannot produce a
// navigation component or join two glob tokens (as in "@{,x}(read|write)").
// Leave the entire run in the component passed to the canonical matcher.
function literalAffixEnd(pattern, start, group) {
  if (!canDeferLiteralList(pattern, start, group.arms)) return start;
  let end = group.end;
  while (pattern[end + 1] === '{') {
    const next = scopeBraceGroup(pattern, end + 1);
    if (!next || next.arms.length < 2 || !canDeferLiteralList(pattern, end + 1, next.arms)) break;
    end = next.end;
  }
  return /[\p{L}\p{N}_-]\.*$/u.test(pattern.slice(0, start)) || /^\.*[\p{L}\p{N}_-]/u.test(pattern.slice(end + 1))
    ? end
    : start;
}

// Resolve only choices that change component boundaries. Usually the walker
// needs just the next component; later choices remain shared continuations.
// When an alternative introduces "." or "..", resolve the layout before
// normalizing it, as those segments can change an already visited prefix.
function* pathLayouts(pattern, wholePath = false) {
  const slash = pattern.indexOf('/');
  const stop = wholePath || slash < 0 ? pattern.length : slash;
  let singleBraceEnd = -1;
  for (let i = 0; i < stop; i++) {
    if (pattern[i] !== '{') continue;
    const group = groupAt(pattern, i);
    if (!group) continue;
    if (group.arms.length < 2) {
      // An inner empty arm can turn the enclosing word into a brace range.
      singleBraceEnd = Math.max(singleBraceEnd, group.end);
      continue;
    }
    const end = i < singleBraceEnd ? i : literalAffixEnd(pattern, i, group);
    if (end > i) {
      i = end;
      continue;
    }
    if (group.arms.some(arm => arm.includes('/') || /^\.{0,2}$/.test(arm))) {
      for (const arm of group.arms)
        yield* pathLayouts(pattern.slice(0, i) + arm + pattern.slice(group.end + 1), wholePath);
      return;
    }
  }
  yield pattern;
}

// An alphabetic range can emit an empty string for ASCII backslash. Every
// nonempty spelling prevents its component from becoming empty, "." or "..".
// Consider that choice once per component and keep the intact glob as well.
function* navigationLayouts(pattern, offset = 0) {
  for (const match of pattern.slice(offset).matchAll(/[^/]+/g)) {
    const component = match[0];
    const collapsed = component.replace(/\{([A-Za-z]\.\.[A-Za-z](?:\.\.-?\d+)?)\}/g, (raw, body) =>
      [...rangeWords(braceRange.exec(body), Infinity)].includes('') ? '' : raw,
    );
    if (component === collapsed || (collapsed && !hasNavigationFragment(collapsed))) continue;
    const start = offset + match.index;
    const layout = pattern.slice(0, start) + collapsed + pattern.slice(start + component.length);
    yield* navigationLayouts(layout, start + collapsed.length + 1);
  }
  // Directory alternatives stay local to the walk unless they can cross a
  // dot segment. A range in an ordinary filename does not change the layout.
  if (hasNavigationFragment(pattern)) yield* pathLayouts(pattern, true);
  else yield pattern;
}

function* normalizedScopeLayouts(pattern) {
  const hasNavigation = hasNavigationFragment(pattern) || /\{[A-Za-z]\.\.[A-Za-z]/.test(pattern);
  const layouts = hasNavigation && pattern.includes('{') ? navigationLayouts(pattern) : [pattern];
  for (const layout of layouts) yield path.posix.normalize(layout).replace(/\/$/, '');
}

function* rangeWords(match, limit) {
  const [, left, right, stride, first, last, letterStride] = match;
  const start = first ? first.charCodeAt(0) : Number(left);
  const end = last ? last.charCodeAt(0) : Number(right);
  const step = Math.abs(Number(stride ?? letterStride)) || 1;
  const width = !first && [left, right, stride].some(s => /^-?0\d/.test(s)) ? Math.max(left.length, right.length) : 0;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return;
  const count = Math.floor(Math.abs(end - start) / step) + 1;
  // Digits cannot contribute to ".rs". Beyond the finite reserved suffixes
  // one further numeric spelling has the same effect as every remaining one.
  for (let i = 0; i < (first ? count : Math.min(count, limit)); i++) {
    const n = start + (start <= end ? i : -i) * step;
    if (first) yield n === 92 ? '' : String.fromCharCode(n);
    else yield (n < 0 ? '-' : '') + String(Math.abs(n)).padStart(n < 0 ? width - 1 : width, '0');
  }
}

function componentParts(pattern) {
  const parts = [];
  let literal = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    const extglob = '@?+*!'.includes(ch) && pattern[i + 1] === '(';
    const start = extglob ? i + 1 : i;
    const group = extglob || ch === '{' ? groupAt(pattern, start) : null;
    let part;
    const range = group?.arms.length === 1 && !extglob ? braceRange.exec(group.arms[0]) : null;
    const bracketEnd = ch === '[' ? classEnd(pattern, i) : -1;
    if (range) {
      part = { op: 'range', range, raw: pattern.slice(i, group.end + 1) };
      i = group.end;
    } else if (group && (extglob || group.arms.length > 1)) {
      part = { op: extglob ? ch : '@', raw: pattern.slice(i, group.end + 1), arms: group.arms.map(componentParts) };
      i = group.end;
    } else if (bracketEnd !== -1) {
      part = { op: 'char', raw: pattern.slice(i, bracketEnd + 1) };
      i = bracketEnd;
    } else if (ch === '?') part = { op: 'char', raw: '?' };
    else if (ch === '*') part = { op: '*', arms: [[{ op: 'char', raw: '?' }]] };
    else {
      literal += ch;
      continue;
    }
    if (literal) parts.push(literal);
    literal = '';
    parts.push(part);
  }
  if (literal) parts.push(literal);
  return parts;
}

// A negative operand can distinguish two otherwise interchangeable spellings
// (for example, b and bb). Keep the native matcher's answers at the remaining
// positions of the component. Within a repeated group its continuation still
// includes the complete repetition, so mixed repetitions remain reachable.
function suffixPatterns(parts) {
  const rules = new Set();
  function collect(sequence, suffix) {
    for (let i = sequence.length - 1; i >= 0; i--) {
      const part = sequence[i];
      if (typeof part === 'string') {
        for (let j = part.length - 1; j >= 0; j--) {
          suffix = part[j] + suffix;
          rules.add(suffix);
        }
      } else {
        const raw = part.raw ?? '*';
        if (part.arms && raw !== '*') {
          const loop = part.op === '+' || part.op === '*' ? '*' + raw.slice(1) : '';
          for (const arm of part.arms) collect(arm, loop + suffix);
        }
        suffix = raw + suffix;
        rules.add(suffix);
      }
    }
  }
  collect(parts, '');
  return [...rules];
}

function* caseNeighbours(name) {
  let offset = 0;
  for (const ch of name) {
    for (const other of [ch.toLowerCase(), ch.toUpperCase()]) {
      if (other !== ch) yield name.slice(0, offset) + other + name.slice(offset + ch.length);
    }
    offset += ch.length;
  }
}

// Produce a concrete component outside the known child directories. Search
// backwards: once a partial word has its required extension and differs from
// every suffix of a reserved name, its spelling no longer affects either
// constraint. Repetition visits these finite states to a fixed point.
function componentWitness(pattern, children, extension = '', explicitExtension = false) {
  const valid = name => name && name.isWellFormed() && name !== '.' && name !== '..' && !children.has(name);
  if (!scopeGlobSyntax.test(pattern))
    return valid(pattern) && pattern.toLowerCase().endsWith(extension) ? pattern : null;
  const glob = cargoScopeGlob(pattern);

  const reserved = new Set(['', '.', '..']);
  const alphabet = new Set('x.rs');
  // Prefer a readable witness. Include the full POSIX filename alphabet in
  // ASCII, and one character beyond it for a negated ASCII class.
  for (let code = 1; code <= 128; code++) if (code !== 47) alphabet.add(String.fromCharCode(code));
  for (const name of children.keys()) {
    for (let i = 0; i < name.length; i++) reserved.add(name.slice(i));
  }
  // The native glob's character classes can consume a single UTF-16 code
  // unit. A neighbouring wildcard or class can consume the other half.
  for (const text of [pattern, ...children.keys()]) {
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      for (const n of [code, code - 1, code + 1])
        if (n > 0 && n <= 0xffff && n !== 47) alphabet.add(String.fromCharCode(n));
    }
  }
  let rules = [];
  const classes = new Map();
  function wordClass(word) {
    let prefix = word.startsWith('.') ? '.' : '*';
    if (!word.isWellFormed()) {
      // Building from right to left, only a leading low surrogate can still
      // become part of a well-formed filename in a later step.
      if (!/^[\uDC00-\uDFFF]/.test(word) || !word.slice(1).isWellFormed()) return null;
      prefix = 'low';
    }
    if (reserved.has(word) || word.length < extension.length) return '=' + word;
    if (!rules.length) return prefix;
    if (!classes.has(word)) {
      // The sentinel puts a suffix inside the basename, where a dot is an
      // ordinary character. The complete basename keeps its actual dot rules.
      const answers = rules.map(rule => Number(path.posix.matchesGlob('x' + word, 'x' + rule)));
      classes.set(word, prefix + Number(path.posix.matchesGlob(word, glob)) + answers.join(''));
    }
    return classes.get(word);
  }
  const distinct = words => {
    const seen = new Map();
    for (const word of words) {
      const tail = word.toLowerCase();
      if (tail.length < extension.length ? !extension.endsWith(tail) : !tail.endsWith(extension)) continue;
      const key = wordClass(word);
      if (key !== null && !seen.has(key)) seen.set(key, word);
    }
    return seen;
  };
  const concat = (heads, tails, namesDot = true) => {
    function* words() {
      for (const head of heads)
        for (const tail of tails) {
          // Outside src, a wildcard cannot supply the very dot that would turn
          // an unconstrained filename into evidence of a Rust extension.
          if (
            !namesDot &&
            explicitExtension &&
            tail.length < extension.length &&
            head.length + tail.length >= extension.length
          )
            continue;
          yield head + tail;
        }
    }
    return [...distinct(words()).values()];
  };

  function repeat(initial, step) {
    const found = distinct(initial);
    let frontier = [...found.values()];
    while (frontier.length) {
      const next = distinct(step(frontier));
      frontier = [];
      for (const [key, word] of next)
        if (!found.has(key)) {
          found.set(key, word);
          frontier.push(word);
        }
    }
    return [...found.values()];
  }

  function spell(parts, tails) {
    for (let i = parts.length - 1; i >= 0 && tails.length; i--) {
      const part = parts[i];
      if (typeof part === 'string') tails = concat([part], tails);
      else if (part.op === 'range') tails = concat(rangeWords(part.range, reserved.size + 1), tails);
      else if (part.op === 'char') {
        const chars =
          part.raw === '?' ? alphabet : [...alphabet].filter(ch => path.posix.matchesGlob('x' + ch, 'x' + part.raw));
        tails = concat(chars, tails, part.raw.includes('.') && !/^\[[!^]/.test(part.raw));
      } else if (part.op === '!') {
        // Propose arbitrary words; the intact native pattern decides negation
        // with its real prefix and suffix, including nested extglobs.
        tails = repeat(tails, ends => concat(alphabet, ends, false));
      } else {
        const step = ends => part.arms.flatMap(arm => spell(arm, ends));
        if (part.op === '*') tails = repeat(tails, step);
        else if (part.op === '+') tails = repeat(step(tails), step);
        else tails = [...distinct(part.op === '?' ? [...tails, ...step(tails)] : step(tails)).values()];
      }
    }
    return tails;
  }

  const parts = componentParts(pattern);
  function find() {
    const names = new Set(spell(parts, ['']));
    for (const name of names) {
      if (!name.toLowerCase().endsWith(extension) || !path.posix.matchesGlob(name, glob)) continue;
      if (valid(name)) return name;
      // Git names are literal. For a mask that folds case, an unoccupied
      // spelling can lie just outside the set of occupied, matching ones.
      if (children.has(name)) for (const other of caseNeighbours(name)) names.add(other);
    }
  }
  const first = find();
  if (first || !(pattern.includes('!(') || (pattern.includes('{') && /[+*]\(/.test(pattern)))) return first;
  rules = suffixPatterns(parts);
  return find();
}

function manifestTree(manifests) {
  const node = () => ({ children: new Map(), manifest: null });
  const root = node();
  for (const dir of manifests.keys()) {
    let entry = root;
    for (const part of dir === '.' ? [] : dir.split('/')) {
      if (!entry.children.has(part)) entry.children.set(part, node());
      entry = entry.children.get(part);
    }
    entry.manifest = dir;
    // Even an uncommitted src directory is a distinct possible continuation.
    if (!entry.children.has('src')) entry.children.set('src', node());
  }
  return root;
}

const noChildren = new Map();

function directorySource(children) {
  let stem = 'mod';
  while (children.has(stem + '.rs')) stem += '_';
  return stem + '.rs';
}

// In addition to glob matches, ownsPath grants the exact spelling and its
// literal subtree. A Git directory named [client] can therefore be a different
// package from the one reached by interpreting [client] as a character class.
function literalScopeTarget(pattern, root, entryKinds, allFiles) {
  const base = pattern.replace(/\/\*\*$/, '');
  const kind = entryKinds.get(base);
  const parts = base.split('/');
  const leaf = parts.pop();
  let node = root;
  let owner = root.manifest;
  let dir = '';
  let confirmedLiteral = kind !== undefined;
  for (const part of parts) {
    dir = join(dir, part);
    node = node?.children.get(part);
    if (!confirmedLiteral && scopeGlobSyntax.test(part)) {
      // A known literal prefix also owns its future literal descendants,
      // e.g. [client]/src/pages/[id]. An unconfirmed f[i]xtures stays a glob.
      if (!node && entryKinds.get(dir) !== 'tree') return null;
      confirmedLiteral = true;
    }
    owner = node?.manifest ?? owner;
  }
  const child = node?.children.get(leaf);
  // A catalog can prove a dotted literal directory even without Git entry types.
  const directory =
    base !== pattern ||
    kind === 'tree' ||
    (kind === undefined && (!leaf.includes('.') || (allFiles && child !== undefined)));
  if (!allFiles && !directory && !leaf.toLowerCase().endsWith('.rs')) return null;
  if (!confirmedLiteral && scopeGlobSyntax.test(leaf) && !(directory && child)) return null;
  return { directory, node: child, owner: directory ? (child?.manifest ?? owner) : owner, dir: base };
}

function visitScope(scope, root, candidates, entryKinds, allFiles = false) {
  const pattern = scope.replace(/^\.\//, '');
  const glob = cargoScopeGlob(pattern);
  const visited = new Map();
  const covered = new Set();

  // A scope ending at a matched directory also covers its package descendants.
  function coverDirectory(entry, inherited, matchedPath = null) {
    if (!entry || covered.has(entry) || (matchedPath !== null && !ownsScopePath(scope, matchedPath, glob))) return;
    covered.add(entry);
    const owner = entry.manifest ?? inherited;
    if (owner !== null) candidates.add(owner);
    for (const child of entry.children.values()) coverDirectory(child, owner);
  }

  function recordFile(owner, dir, children, part, inSource) {
    if (owner === null || candidates.has(owner)) return;
    let file;
    if (part === '**' && (allFiles || inSource)) file = directorySource(children);
    else if (allFiles) file = componentWitness(part, children);
    else if (part !== '**' && (inSource || part.includes('.')))
      file = componentWitness(part, children, '.rs', !inSource);
    if (file && ownsScopePath(scope, join(dir, file), glob)) candidates.add(owner);
  }

  function visit(pattern, entry, dir, inherited) {
    const owner = entry?.manifest ?? inherited;
    if (pattern === null) return coverDirectory(entry, inherited, dir);
    if (!entry && (owner === null || candidates.has(owner))) return;
    const src = owner === '.' ? 'src' : owner + '/src';
    const inSource = dir === src || dir.startsWith(src + '/');
    const children = entry?.children ?? noChildren;
    // Past the last possible manifest or src boundary, different prefixes
    // have the same owner and evidence rule. Visit their shared suffix once.
    const state = entry ?? (inSource ? 'src:' : 'dir:') + owner;
    if (!visited.has(state)) visited.set(state, new Set());
    const suffixes = visited.get(state);
    if (suffixes.has(pattern)) return;
    suffixes.add(pattern);

    for (const layout of pathLayouts(pattern)) {
      const slash = layout.indexOf('/');
      const part = slash < 0 ? layout : layout.slice(0, slash);
      const rest = slash < 0 ? null : layout.slice(slash + 1);
      const globstar = part === '**';
      if (rest === null) {
        recordFile(owner, dir, children, part, inSource);
        if (!globstar && !allFiles) continue;
      } else if (globstar) visit(rest, entry, dir, owner);

      if (!scopeGlobSyntax.test(part)) {
        if (part !== 'Cargo.toml' || !entry?.manifest) visit(rest, children.get(part), join(dir, part), owner);
        continue;
      }
      const componentGlob = cargoScopeGlob(part);
      for (const [name, child] of children) {
        const childDir = join(dir, name);
        if (path.posix.matchesGlob(name, componentGlob) || (globstar && ownsScopePath(scope, childDir, glob)))
          visit(globstar ? layout : rest, child, childDir, owner);
      }
      // One fresh matching component covers all names outside this trie
      // branch. A further globstar descent there cannot reach a new owner.
      if (owner === null || candidates.has(owner) || rest === null || (globstar && !entry)) continue;
      const occupied = entry?.manifest ? new Set([...children.keys(), 'Cargo.toml']) : children;
      const name = componentWitness(part, occupied);
      if (name) visit(rest, null, join(dir, name), owner);
    }
  }

  const kind = entryKinds.get(pattern);
  if (kind === 'tree' || scopeGlobSyntax.test(pattern)) {
    const literal = literalScopeTarget(pattern, root, entryKinds, allFiles);
    if (literal?.directory) visit('**', literal.node, literal.dir, literal.owner);
    else if (literal?.owner != null) candidates.add(literal.owner);
    if (!scopeGlobSyntax.test(pattern)) return;
  }
  for (let normalized of normalizedScopeLayouts(pattern)) {
    // An extensionless literal can name a future directory. Git supplies
    // the type when that exact path already exists.
    if (kind === undefined && !scopeGlobSyntax.test(pattern) && !path.posix.basename(normalized).includes('.'))
      normalized += '/**';
    visit(normalized, root, '', null);
  }
}

/** Return directories whose nearest manifest must be inspected for [package].
 * @param {Iterable<string>} scopes
 * @param {Map<string, string>} manifests regular Cargo.toml blobs indexed by relative directory
 * @param {Map<string, string>} [entryKinds] tracked entries named by scopes or their literal ancestors in this Git tree
 * @returns {Set<string>}
 */
export function plannedPackageDirs(scopes, manifests, entryKinds = new Map()) {
  const candidates = new Set();
  if (!manifests.size) return candidates;
  const root = manifestTree(manifests);
  for (const scope of scopes) {
    visitScope(scope, root, candidates, entryKinds);
    if (candidates.size === manifests.size) break;
  }
  return candidates;
}

// Contract policy covers every file. Reuse the manifest trie across scopes,
// keeping each result separate so a sibling task or glob arm cannot grant access.
export function createPackageFileOwnerResolver(manifests, entryKinds) {
  const root = manifestTree(manifests);
  return scope => {
    if (scope === '.') return new Set(manifests.keys());
    const owners = new Set();
    if (manifests.size) {
      visitScope(scope, root, owners, entryKinds, true);
      const grouped = unwrapContractPathGroups(scope);
      if (grouped !== scope) visitScope(grouped, root, owners, entryKinds, true);
    }
    return owners;
  };
}
