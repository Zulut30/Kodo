import { open } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import metadata from '../package.json' with { type: 'json' };
import { planFastChecks } from './task-fast-checks.mjs';

export async function receiptBinding(run, headSha) {
  const plan = await planFastChecks({ run, headSha });
  return {
    profile: 'task-fast',
    complete: true,
    headSha,
    wavePolicyHash: run.wavePolicy.hash,
    kodoVersion: metadata.version,
    commands: plan.commands.map(step => (step.command === process.execPath ? { ...step, command: 'node' } : step)),
  };
}

export function remoteProof(run) {
  const checks = run.checks;
  return (
    run.executor?.kind === 'external' &&
    ['ssh', 't3-env'].includes(run.workerPlacement?.machine?.kind) &&
    run.trustedRemoteVerification === true &&
    checks?.source === 'remote' &&
    checks.profile === 'task-fast' &&
    checks.complete === true &&
    checks.headSha === run.headSha &&
    checks.wavePolicyHash === run.wavePolicy?.hash &&
    checks.kodoVersion === metadata.version &&
    Array.isArray(checks.commands) &&
    checks.commands.length > 0
  );
}

export async function verifyRemoteProof(run) {
  return (
    remoteProof(run) && isDeepStrictEqual(run.checks, { ...(await receiptBinding(run, run.headSha)), source: 'remote' })
  );
}

export async function matchesReceiptFile(file, expected) {
  if (!expected.commands.length) return false;
  let handle;
  try {
    handle = await open(file, 'r');
    const info = await handle.stat();
    if (!info.isFile() || info.size > 1024 * 1024) return false;
    const buffer = Buffer.alloc(info.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    return offset === info.size && isDeepStrictEqual(JSON.parse(buffer.toString('utf8', 0, offset)), expected);
  } catch {
    return false;
  } finally {
    await handle?.close();
  }
}
