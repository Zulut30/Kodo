import { prepareBootstrap } from '@zulut30/kodo/runtime/project-bootstrap.mjs';
import { emptyContainers } from '@zulut30/kodo/runtime/project-contracts.mjs';
import { buildProjectTelemetry } from '@zulut30/kodo/runtime/project-telemetry.mjs';
import { normalizeQualityConfig } from '@zulut30/kodo/runtime/quality.mjs';
import { isCurrentQualityReceipt } from '@zulut30/kodo/runtime/quality-runner.mjs';

interface Options {
  enabled: boolean;
}

const options: Options = { enabled: true };
const config = normalizeQualityConfig(options);
config.mode.replace(/^./, first => first.toUpperCase());
emptyContainers([{ id: 'first' }], [], []).map(container => container.kind.toUpperCase());
await isCurrentQualityReceipt();

export function verifyReceipt(
  report: unknown,
  project: string | null,
  readHead: (
    command: 'git',
    args: string[],
    options: { cwd: string; timeoutMs: number; maxOutputBytes: number },
  ) => { code: number; stdout: string },
) {
  const options = { project, runner: readHead };
  return isCurrentQualityReceipt(report, options);
}

export function formatSummary(
  bootstrap: Awaited<ReturnType<typeof prepareBootstrap>>,
  telemetry: ReturnType<typeof buildProjectTelemetry>,
) {
  const start = telemetry.throughput.integrated.windowStart;
  return {
    guides: bootstrap.files.filter(file => file.endsWith('.md')),
    windowStart: start?.replace(/[TZ]/g, char => (char === 'T' ? ' ' : ' UTC')),
  };
}
