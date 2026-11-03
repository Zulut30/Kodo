/** Coordinator-only LIVE acceptance. This script never substitutes test doubles.
 * --help is offline. Default drivers do not use model APIs. Selecting a model
 * driver explicitly enables calls with the coordinator's existing credentials.
 */
import { createServer } from 'node:net';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import { execute } from '../runtime/command.mjs';
import { loadSecrets } from '../runtime/security.mjs';
import { runUIVerification, isCurrentUIReceipt, normalizeUIConfig } from '../runtime/ui-verification.mjs';
import { uiTools, modelTools } from '../runtime/ui-schema.mjs';
import { ownedProcess, waitUntil, uiEnvironment } from '../runtime/ui-browser.mjs';

export function smokeOptions(args) {
  const result = { tools: ['browser-harness', 'chrome-devtools-mcp', 'agent-desktop'], project: process.cwd(), autoInstall: false };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === '--help') { result.help = true; continue; }
    if (flag === '--install') { result.autoInstall = true; continue; }
    if (!['--tools', '--project', '--artifacts', '--tool-home', '--executable-path'].includes(flag) || !args[i + 1] || args[i + 1].startsWith('--')) throw Error('Invalid ui-smoke arguments; use --help');
    const value = args[++i];
    if (flag === '--tools') result.tools = value.split(',');
    else result[{ '--project': 'project', '--artifacts': 'artifacts', '--tool-home': 'toolHome', '--executable-path': 'executablePath' }[flag]] = path.resolve(value);
  }
  if (!result.tools.length || new Set(result.tools).size !== result.tools.length || result.tools.some(id => !uiTools.includes(id))) throw Error('Unknown or duplicate UI tool');
  return result;
}
async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
export async function main(args = process.argv.slice(2)) {
  const options = smokeOptions(args);
  if (options.help) {
    console.log('Live owned-fixture UI acceptance: node scripts/ui-smoke.mjs [--tools browser-harness,chrome-devtools-mcp,agent-desktop] [--project PATH] [--artifacts PRIVATE_PATH] [--tool-home PATH] [--executable-path CHROME] [--install]\nSelect browser-use,vibetest,jev-ultrafast explicitly to enable Google/TypeSafe model calls. No automatic installs without --install. Desktop fixture is available on Windows; other platforms report blocked. Evidence is private outside Git.');
    return 0;
  }
  const cwd = options.project;
  const headSha = (await execute('git', ['rev-parse', 'HEAD'], { cwd })).stdout.trim();
  const changes = await execute('git', ['status', '--porcelain'], { cwd });
  if (changes.stdout.trim()) throw Error('Live smoke requires a clean checked Git head');
  const artifacts = options.artifacts ?? await mkdtemp(path.join(os.tmpdir(), 'kodo-ui-smoke-'));
  const port = await freePort(), url = `http://127.0.0.1:${port}/`;
  let fixture;
  const cases = [];
  try {
    for (const tool of options.tools) {
      if (tool === 'agent-desktop') {
        const app = 'KodoUi_' + randomBytes(6).toString('hex');
        const directory = await mkdtemp(path.join(os.tmpdir(), 'kui-gui-'));
        const csc = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
        if (process.platform === 'win32' && existsSync(csc)) {
          const exe = path.join(directory, app + '.exe'), ready = path.join(directory, 'ready.json');
          const compilation = await execute(csc, ['/nologo', '/target:winexe', '/r:System.Windows.Forms.dll', '/r:System.Drawing.dll', '/out:' + exe, fileURLToPath(new URL('./fixtures/kodo-ui-desktop.cs', import.meta.url))], { cwd: directory, env: uiEnvironment(directory), timeoutMs: 30000, allowFailure: true });
          if (compilation.code !== 0) throw Error('Owned desktop fixture compilation failed');
          fixture = ownedProcess(exe, [ready], { cwd: directory, env: uiEnvironment(directory) });
          const state = await waitUntil(async () => { fixture.check(); try { return JSON.parse(await readFile(ready, 'utf8')); } catch { return null; } }, { timeoutMs: 15000 });
          if (state.pid !== fixture.child.pid || !/^w-\d+$/.test(state.windowId)) throw Error('Owned desktop fixture identity failed');
          cases.push({ id: tool, tool, app, windowId: state.windowId, steps: [{ action: 'set-value', name: 'Name', value: 'Kodo' }, { action: 'click', name: 'Verify', role: 'button' }], assertions: [{ text: 'Verified Kodo' }] });
        } else {
          // A deliberately absent owned target yields blocked, never synthetic success.
          cases.push({ id: tool, tool, app, assertions: [{ text: 'Verified Kodo' }] });
        }
      } else cases.push({ id: tool, tool, url, ...(modelTools.includes(tool) ? { goal: 'Enter Kodo in the Name field and click Verify. Confirm the visible Verification result says Verified Kodo. Do not leave this local fixture.' } : {}), steps: [{ action: 'fill', selector: '#name', value: 'Kodo' }, { action: 'click', selector: '#verify' }], assertions: [{ selector: '#result', text: 'Verified Kodo' }, { selector: '#name', value: 'Kodo' }] });
    }
    const config = normalizeUIConfig({ enabled: true, autoInstall: options.autoInstall, maxSteps: 12, timeoutMs: 180000, cases,
      ...(options.executablePath ? { executablePath: options.executablePath } : {}),
      ...(cases.some(c => c.url) ? { start: { command: process.execPath, args: [fileURLToPath(new URL('./fixtures/kodo-ui-server.mjs', import.meta.url)), String(port)] } } : {}) });
    const secrets = options.tools.some(t => modelTools.includes(t)) ? await loadSecrets() : {};
    const receipt = await runUIVerification({ cwd, headSha, config, artifacts, secrets, toolHome: options.toolHome });
    if (!receipt.evidenceRoot) throw Error('Private artifact directory was rejected');
    const after = await execute('git', ['rev-parse', 'HEAD'], { cwd });
    const dirty = await execute('git', ['status', '--porcelain'], { cwd });
    if (after.stdout.trim() !== headSha || dirty.stdout.trim()) throw Error('Checked tree changed during acceptance');
    await mkdir(artifacts, { recursive: true, mode: 0o700 });
    const filename = path.join(artifacts, 'ui-smoke-' + randomBytes(6).toString('hex') + '.json');
    await writeFile(filename, JSON.stringify({ config, receipt }, null, 2), { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify({ status: receipt.status, headSha, receipt: filename, cases: receipt.cases.map(c => ({ id: c.id, status: c.status, reason: c.reason })) }, null, 2));
    return isCurrentUIReceipt(receipt, { headSha, config }) ? 0 : 1;
  } finally { await fixture?.stop(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().then(code => { process.exitCode = code; }).catch(() => { console.error('UI smoke failed; no live acceptance claimed. Check the configured private artifacts, tools and owned fixture prerequisites.'); process.exitCode = 1; });
