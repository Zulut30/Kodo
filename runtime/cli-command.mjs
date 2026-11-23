// Kodo commands that briefs and `next` hints hand to another chat or shell (docs/T3-HOST.md).
// A library caller without a CLI context keeps `kodo`; the CLI passes its own entry, so the
// hints call the same package that issued them. A path enters such a command only as a
// double-quoted argument that PowerShell, cmd and bash all keep literal.
import path from 'node:path';

/** The prefix without a CLI context. */
export const DEFAULT_CLI = 'kodo';

// Inside double quotes PowerShell expands $ and the backtick escape, bash $ and backticks,
// cmd %VAR% and (with delayed expansion) !VAR!; a quote, or a typographic quote PowerShell
// also accepts, ends the argument. Control and line separator characters never belong in it.
const UNSAFE = /["`$%!\u2018-\u201f]/;
const CONTROL = /[\x00-\x1f\x7f-\x9f\u2028\u2029]/;

export const PATH_UNSAFE_MESSAGE =
  'Путь нельзя одинаково безопасно подставить в команду PowerShell, cmd и bash (кавычки, ` $ % !, управляющие символы, двойной или конечный обратный слеш, относительный путь): переименуйте или переместите каталог проекта, Kodo home или KODO_WORKTREE_HOME.';

/** An absolute path that a double-quoted argument carries literally in PowerShell, cmd and bash. */
export function commandPathSafe(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 4096 &&
    value.isWellFormed() &&
    path.isAbsolute(value) &&
    !CONTROL.test(value) &&
    !UNSAFE.test(value) &&
    // bash folds `\\` and `\"` inside double quotes: no doubled or final backslash.
    !/\\\\|\\$/.test(value)
  );
}

const refusal = (code, message) => Object.assign(new Error(message), { code });

/** `"<path>"` for a command argument; an unsafe path is refused (`project_path_unsafe`). */
export function quotePath(value) {
  if (!commandPathSafe(value)) throw refusal('project_path_unsafe', PATH_UNSAFE_MESSAGE);
  return `"${value}"`;
}

/** `node "<absolute entry>"` for the running `cli/index.mjs` (from its import.meta.url). */
export function cliCommand(entry) {
  return `node "${entry}"`;
}

/** Exactly `kodo` or `node "<safe absolute path>"`; anything else is refused with a code. */
export function assertCliPrefix(value) {
  if (value === DEFAULT_CLI) return value;
  const match = typeof value === 'string' ? /^node "([^"]*)"$/.exec(value) : null;
  if (!match) throw refusal('project_cli_invalid', 'Invalid CLI prefix');
  quotePath(match[1]);
  return value;
}
