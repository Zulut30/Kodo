// The command prefix of Kodo commands that briefs and `next` hints hand to another
// chat or shell (docs/T3-HOST.md). A library caller without a CLI context keeps `kodo`;
// the CLI passes its own entry, so the hints call the same package that issued them.

/** The prefix without a CLI context. */
export const DEFAULT_CLI = 'kodo';

/**
 * `node "<absolute entry>"`: the entry is the running `cli/index.mjs` (from its
 * import.meta.url). `node` without a path resolves in PowerShell, cmd and POSIX
 * shells; the quoted path may contain spaces.
 * @param {string} entry
 */
export function cliCommand(entry) {
  return `node "${entry.replaceAll('"', '\\"')}"`;
}

/** One line of printable text: no surrounding blanks and no control characters. */
export function validCliPrefix(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 4096 &&
    value.trim() === value &&
    !/[\x00-\x1f\x7f]/.test(value)
  );
}
