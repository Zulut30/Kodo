// Use alongside Node's TAP reporter, never as a replacement for raw diagnostics.
import { profileEvent } from '../runtime/ci-profiler.mjs';

export default async function* ciReporter(source) {
  for await (const event of source) {
    const record = profileEvent(event);
    if (record) yield JSON.stringify(record) + '\n';
  }
}
