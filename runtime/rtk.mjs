// Optional local command-output guidance. No install, process, hooks or config
// access on import. Only pass current integrity-checked resolveTool results.
import os from 'node:os';
import path from 'node:path';
import catalog from './tool-catalog.json' with { type: 'json' };
import { inside } from './toolchains.mjs';

const pin = catalog.find(tool => tool.id === 'rtk');
const absolute = value => typeof value === 'string' && path.isAbsolute(value) && !/[\x00-\x1f\x7f]/.test(value);

// Structural validation is not a second receipt verifier. The existing managed
// resolver verifies pins, version probe and complete file inventory each time.
export function isManagedRtkReady(tool) {
  return Boolean(
    pin &&
    tool?.id === 'rtk' &&
    tool.version === pin.version &&
    tool.ready === true &&
    tool.status === 'ready' &&
    absolute(tool.command) &&
    absolute(tool.directory) &&
    absolute(tool.receipt) &&
    path.dirname(tool.command) === path.join(tool.directory, 'native') &&
    ['rtk', 'rtk.exe'].includes(path.basename(tool.command)) &&
    path.dirname(tool.receipt) === path.dirname(tool.directory),
  );
}

/** Safe overrides only; the coordinator allocates this private per-worker
 * directory outside Git and managed installations, checking links/permissions.
 * Merge AFTER workerEnvironment and any inherited RTK variables. Put the ready
 * command's directory before inherited PATH for workers only. Never redirect
 * HOME/USERPROFILE/APPDATA or copy subscription auth. No filesystem writes here.
 */
export function rtkWorkerEnvironment(tool, directory) {
  if (!isManagedRtkReady(tool)) return {};
  if (
    !absolute(directory) ||
    directory === path.parse(directory).root ||
    path.resolve(directory) === path.resolve(os.homedir()) ||
    inside(tool.directory, directory) ||
    inside(directory, tool.directory)
  ) {
    throw new Error('RTK requires a private absolute worker directory outside the installation');
  }
  return {
    RTK_DB_PATH: path.join(directory, 'tracking.db'),
    RTK_RECALL: '0',
    RTK_TEE: '0',
    RTK_TELEMETRY_DISABLED: '1',
  };
}

/** Keep paths, raw diagnostics and arbitrary supplied fields out of prompts. */
export function formatRtkContext(tool) {
  if (!isManagedRtkReady(tool)) return '';
  return [
    `Managed RTK OSS ${pin.version} is ready for explicit local human-readable output only (for example, rtk git status or rtk git diff --stat). Check command-specific support first; default to the original command when uncertain.`,
    'Keep JSON, porcelain, -z/NUL, protocol output and any parsed data raw. Keep Node node:test/TAP raw: generic RTK test wrapping has lost actionable diagnostics despite preserving exit code 1. Coordinator checks, CI, security/UI gates and delivery run raw.',
    'Preserve the original exit code and full errors/failures. If filtering obscures details, rerun the original command raw and retain complete redacted evidence privately; RTK recovery is disabled. Do not summarize failure away or count lost diagnostics as savings.',
    'Use only the coordinator-provided worker PATH and private RTK_DB_PATH, with RTK_RECALL=0, RTK_TEE=0 and RTK_TELEMETRY_DISABLED=1. The coordinator owns installation and live probes. Missing/unsupported tools use raw commands without per-session installation.',
    'Never run init/config-save, add global hooks, bypass hook trust, replace user binaries, use rtk-proxy or route models/APIs. GPT/Claude stay in signed-in subscription clients. Output UTF-8 byte deltas and bytes/4 approximate tokens are not measured quota or subscription USD savings.',
  ].join('\n');
}
