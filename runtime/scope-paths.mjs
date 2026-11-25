import path from 'node:path';

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
