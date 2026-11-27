import path from 'node:path';

// +, @ and ! begin a glob operator only when immediately followed by '('.
export const scopeGlobSyntax = /[*?[{]|[+@!]\(/;

/** Visit a normalized project-relative path, then its parents through the root (''). */
export function* pathAndAncestors(name) {
  for (;;) {
    yield name;
    if (!name) return;
    const slash = name.lastIndexOf('/');
    name = slash < 0 ? '' : name.slice(0, slash);
  }
}

// Brace expansion precedes glob parsing, so commas inside classes and
// extglobs still delimit brace alternatives at the current brace depth.
export function scopeBraceGroup(pattern, start) {
  const arms = [];
  let depth = 1;
  let from = start + 1;
  for (let i = from; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) {
      arms.push(pattern.slice(from, i));
      return { arms, end: i };
    } else if (ch === ',' && depth === 1) {
      arms.push(pattern.slice(from, i));
      from = i + 1;
    }
  }
  return null;
}

/** Find a brace list to expand before interpreting extglob delimiters.
 * @param {string} pattern
 * @param {number} start
 * @param {(pattern: string, start: number, arms: string[]) => boolean} [canDefer]
 */
export function braceBeforeExtglob(pattern, start, canDefer) {
  if (!pattern.includes('(', start)) return null;
  for (let i = pattern.indexOf('{', start); i !== -1; i = pattern.indexOf('{', i + 1)) {
    const group = scopeBraceGroup(pattern, i);
    if (group && group.arms.length > 1 && !canDefer?.(pattern, i, group.arms)) return { ...group, start: i };
  }
  return null;
}

/**
 * Shared write-scope path ownership matcher used by both worker scope enforcement
 * (`runtime/contracts.mjs`) and Rust contract-crate protection (`runtime/cargo-workspace.mjs`).
 * @param {string[]} scopes
 * @param {string} name
 */
export function ownsPath(scopes, name) {
  return scopes.some(value => ownsScopePath(value, name));
}

// A prepared glob can only replace the native match. The literal file and
// subtree are always identified by the original write scope.
export function ownsScopePath(value, name, glob = undefined) {
  const scope = value.replace(/^\.\//, '');
  return (
    path.posix.matchesGlob(name, glob ?? scope) || name === scope || name.startsWith(scope.replace(/\/\*\*$/, '') + '/')
  );
}
