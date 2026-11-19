/**
 * Kodo's `node --test` reporter for counting tests (`--test-reporter=<this module>`): one JSON line
 * per `test:pass` / `test:fail` event with only the fields the count needs, then one `end` line once
 * the runner's event stream has ended. A file without that last line is an incomplete run.
 * The count itself is `countTestEvents` in `runtime/task-fast-checks.mjs`.
 */
const types = new Set(['test:pass', 'test:fail']);
const text = value => (typeof value === 'string' ? value : null);
const integer = value => (Number.isSafeInteger(value) ? value : null);

/** @param {AsyncIterable<{ type: string, data?: any }>} source */
export default async function* testCountReporter(source) {
  for await (const event of source) {
    if (!types.has(event.type)) continue;
    const data = event.data ?? {};
    yield `${JSON.stringify({
      type: event.type,
      kind: text(data.details?.type),
      nesting: integer(data.nesting),
      name: text(data.name),
      file: text(data.file),
      line: integer(data.line),
      column: integer(data.column),
      skip: data.skip !== undefined && data.skip !== false,
      todo: data.todo !== undefined && data.todo !== false,
    })}\n`;
  }
  yield `${JSON.stringify({ type: 'end' })}\n`;
}
