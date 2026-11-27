import path from 'node:path';

// +, @ and ! begin a glob operator only when immediately followed by '('.
export const scopeGlobSyntax = /[*?[{]|[+@!]\(/;

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

// Expand one brace list before interpreting extglobs. Its alternatives can
// change where an operator or class ends. Callers retain their branch limits.
export function braceBeforeExtglob(pattern, start) {
  if (!pattern.includes('(', start)) return null;
  for (let i = pattern.indexOf('{', start); i !== -1; i = pattern.indexOf('{', i + 1)) {
    const group = scopeBraceGroup(pattern, i);
    if (group && group.arms.length > 1) return { ...group, start: i };
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
  return scopes.some(value => {
    // `./x` names the same path as `x` (validatePlan accepts both spellings).
    const scope = value.replace(/^\.\//, '');
    return path.posix.matchesGlob(name, scope) || name === scope || name.startsWith(scope.replace(/\/\*\*$/, '') + '/');
  });
}
