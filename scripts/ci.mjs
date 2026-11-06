#!/usr/bin/env node
import { ciCli } from '../runtime/ci-cli.mjs';

const controller = new AbortController();
const abort = () => controller.abort();
process.once('SIGINT', abort);
process.once('SIGTERM', abort);
try {
  const result = await ciCli(process.argv.slice(2), { signal: controller.signal });
  process.stdout.write(result.output + '\n');
  process.exitCode = result.exitCode;
} finally {
  process.removeListener('SIGINT', abort);
  process.removeListener('SIGTERM', abort);
}
