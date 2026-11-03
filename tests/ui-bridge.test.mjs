import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runDesktopCase, runChromeCase, uiEnvironment, browserEnvironment } from '../runtime/ui-browser.mjs';
import { assessObservations } from '../runtime/ui-schema.mjs';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

test('Owned form rejects whitespace names and verifies only a trimmed nonempty name', async () => {
  const html = await readFile(new URL('../scripts/fixtures/kodo-ui-form.html', import.meta.url), 'utf8');
  const script = html.split('<script>')[1].split('</script>')[0];
  const input = { value: '' }, result = { textContent: 'Not verified' }; let submit;
  const document = { querySelector: selector => ({ '#name': input, '#result': result, '#form': { addEventListener: (event, handler) => { assert.equal(event, 'submit'); submit = handler; } } })[selector] };
  runInNewContext(script, { document }); let prevented = 0;
  for (const value of ['', '   ', ' Kodo ']) {
    input.value = value; submit({ preventDefault() { prevented++; } });
    assert.equal(result.textContent, value.trim() ? 'Verified Kodo' : 'Enter a name');
  }
  assert.equal(prevented, 3);
});

test('bridge compatibility and failure checks run without installed tools, network or UI', t => {
  const candidates = [process.env.KODO_UI_TEST_PYTHON, 'python3', 'python'].filter(Boolean);
  const python = candidates.find(p => spawnSync(p, ['-I', '-B', '-c', 'import sys;assert sys.version_info >= (3, 11)'], { windowsHide: true }).status === 0);
  if (!python) return t.skip('Python >=3.11 is required for stdlib bridge checks; set KODO_UI_TEST_PYTHON');
  const result = spawnSync(python, ['-I', '-B', fileURLToPath(new URL('./fixtures/kodo-ui-bridge-tests.py', import.meta.url))], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /OK/);
});
test('UI process environment drops provider keys, user profiles and browser/cloud overrides', () => {
  const env = uiEnvironment('/private', { PATH: 'system', GEMINI_API_KEY: 'secret', TYPESAFE_API_KEY: 'secret', OPENAI_API_KEY: 'secret', BU_CDP_URL: 'user', BU_NAME: 'default', BH_RECORD: '1', NODE_OPTIONS: '--require malicious', HOME: '/user', TEXT_MODEL_BASE_URL: 'remote' });
  assert.equal(env.PATH, 'system'); assert.equal(env.HOME, '/private'); assert.equal(env.BH_RECORD, '0');
  for (const key of ['GEMINI_API_KEY', 'TYPESAFE_API_KEY', 'OPENAI_API_KEY', 'BU_CDP_URL', 'BU_NAME', 'NODE_OPTIONS', 'TEXT_MODEL_BASE_URL']) assert.equal(env[key], undefined);
});
const desktop = { case: { id: 'desktop', tool: 'agent-desktop', app: 'OwnedFixture', windowId: 'w-123', steps: [{ action: 'set-value', name: 'Name', value: 'Kodo' }, { action: 'click', name: 'Verify', role: 'button' }], assertions: [{ text: 'Verified Kodo' }] }, config: { timeoutMs: 2000 }, tool: { command: 'managed-desktop', args: [] }, evidenceDir: process.cwd() };
test('Windows owned Chrome omits fabricated account folders without inheriting personal state or keys', () => {
  const base = { PATH: 'safe', USERPROFILE: 'personal', APPDATA: 'personal', LOCALAPPDATA: 'personal', HOME: 'personal', OPENAI_API_KEY: 'secret', BU_CDP_URL: 'personal' };
  const env = browserEnvironment('/owned', base, 'win32');
  for (const key of ['HOME','USERPROFILE','APPDATA','LOCALAPPDATA','OPENAI_API_KEY','BU_CDP_URL']) assert.equal(env[key], undefined);
  assert.equal(env.TEMP, '/owned'); assert.equal(env.PATH, 'safe');
  assert.equal(browserEnvironment('/owned', base, 'linux').HOME, '/owned');
});
function desktopPort({ ambiguous = false, uncertain = false, uncertainChangedState = true, truncated = false } = {}) {
  const calls = []; let stage = 0;
  return { calls, runner: async (command, args, options) => {
    calls.push(args); assert.equal(command, 'managed-desktop'); assert.equal(options.env.GEMINI_API_KEY, undefined);
    assert.ok(!args.includes('--headed') && !args.includes('--trace') && !args.includes('--screenshot'));
    let data;
    if (args[0] === 'skills') data = { content: 'version matched docs' };
    else if (args[0] === 'find') { assert.ok(args.includes('OwnedFixture') && args.includes('w-123')); data = { matches: [{ ref_id: `@s${stage}:e1` }, ...(ambiguous ? [{ ref_id: '@s0:e2' }] : [])] }; }
    else if (args[0] === 'set-value') { assert.equal(args[1], '@s0:e1'); assert.equal(args[2], 'Kodo'); stage++; data = {}; }
    else if (args[0] === 'click') { assert.equal(args[1], '@s1:e1'); if (!uncertain || uncertainChangedState) stage++; if (uncertain) return { code: 1, stdout: JSON.stringify({ version: '2.5', command: 'click', ok: false, error: { disposition: { delivery: 'uncertain', retry: 'unsafe' } } }) }; data = {}; }
    else if (args[0] === 'get') data = { value: 'Kodo' };
    else if (args[0] === 'snapshot') data = { complete: !truncated, window: { id: 'w-123' }, tree: { role: 'window', children: [{ name: 'Verification result', value: stage === 2 ? 'Verified Kodo' : 'Not verified' }] } };
    else throw Error('unexpected command');
    return { code: 0, stdout: JSON.stringify({ version: '2.5', ok: true, command: args[0], data }) };
  } };
}
test('desktop uses scoped qualified refs, fresh readback and no physical input', async () => {
  const port = desktopPort(); const r = await runDesktopCase({ ...desktop, ...port });
  assert.equal(r.status, 'completed'); assert.ok(r.observations[0].texts.includes('Verified Kodo'));
  assert.equal(port.calls.filter(a => a[0] === 'click').length, 1);
});
test('desktop blocks ambiguity and incomplete observations', async () => {
  for (const options of [{ ambiguous: true }, { truncated: true }]) await assert.rejects(runDesktopCase({ ...desktop, ...desktopPort(options) }));
});
test('desktop observes uncertain final delivery once and requires independent state assertions', async () => {
  const port = desktopPort({ uncertain: true }); const r = await runDesktopCase({ ...desktop, ...port });
  assert.equal(r.status, 'completed'); assert.equal(assessObservations(desktop.case, r.observations)[0].passed, true);
  assert.equal(port.calls.filter(a => a[0] === 'click').length, 1);
  assert.ok(port.calls.at(-1).includes('snapshot'));
  const failed = desktopPort({ uncertain: true, uncertainChangedState: false });
  const other = await runDesktopCase({ ...desktop, ...failed });
  assert.equal(assessObservations(desktop.case, other.observations)[0].passed, false);
  assert.equal(failed.calls.filter(a => a[0] === 'click').length, 1);
});
test('desktop does not continue mutations after uncertain intermediate delivery', async () => {
  const port = desktopPort({ uncertain: true });
  const r = await runDesktopCase({ ...desktop, case: { ...desktop.case, steps: [...desktop.case.steps, { action: 'click', name: 'Other' }] }, ...port });
  assert.equal(r.status, 'failed'); assert.equal(port.calls.filter(a => a[0] === 'click').length, 1);
});
test('desktop does not silently select the focused window when the configured app has multiple windows', async () => {
  const c = { ...desktop.case, windowId: undefined, steps: [] };
  let snapshots = 0;
  const runner = async (_, args) => {
    let data;
    if (args[0] === 'skills') data = { content: 'docs' };
    else if (args[0] === 'list-windows') data = [{ id: 'w-1', is_focused: true }, { id: 'w-2' }];
    else if (args[0] === 'snapshot') { snapshots++; data = { complete: true, window: { id: 'w-1' }, tree: { name: 'Verified Kodo' } }; }
    else throw Error('unexpected command');
    return { code: 0, stdout: JSON.stringify({ version: '2.5', ok: true, command: args[0], data }) };
  };
  await assert.rejects(runDesktopCase({ ...desktop, case: c, runner }), /ambiguous_target/);
  assert.equal(snapshots, 0);
});
test('Chrome MCP navigates and acts on observed UIDs, reads DOM independently and closes transport', async () => {
  const calls = []; let closed = 0;
  const client = {
    async listTools() { return { tools: ['list_pages', 'select_page', 'navigate_page', 'take_snapshot', 'evaluate_script', 'fill', 'click'].map(name => ({ name, inputSchema: { properties: { pageId: {} } } })) }; },
    async callTool({ name, arguments: args }) {
      calls.push({ name, args }); let text = 'ok';
      if (name === 'list_pages') text = '# list_pages response\n1: about:blank [selected]';
      if (name === 'take_snapshot') text = 'uid=1_1 textbox "Name"\nuid=1_2 button "Save"';
      if (name === 'evaluate_script') text = 'Script ran on page and returned:\n```json\n' + (args.args ? '0' : '[{"exists":true,"count":1,"text":"Saved","value":null}]') + '\n```';
      return { content: [{ type: 'text', text }] };
    }, async close() { closed++; }
  };
  const c = { id: 'mcp', tool: 'chrome-devtools-mcp', url: 'http://127.0.0.1/', steps: [{ action: 'fill', selector: '#name', value: 'Kodo' }], assertions: [{ selector: '#result', text: 'Saved' }] };
  const r = await runChromeCase({ case: c, config: { timeoutMs: 2000 }, connect: async () => ({ client, transport: { async close() { closed++; } } }) });
  assert.equal(r.observations[0].text, 'Saved'); assert.equal(closed, 2);
  assert.deepEqual(calls.find(c => c.name === 'fill').args, { pageId: 1, uid: '1_1', value: 'Kodo' });
  client.callTool = async () => ({ isError: true, content: [{ type: 'text', text: 'secret' }] });
  await assert.rejects(runChromeCase({ case: c, config: { timeoutMs: 2000 }, connect: async () => ({ client, transport: { async close() { closed++; } } }) }), /mcp_error/);
  assert.equal(closed, 4);
});
test('Chrome adapter exercises the official SDK stdio transport against an offline protocol fixture', async () => {
  const c = { id: 'mcp', tool: 'chrome-devtools-mcp', url: 'http://127.0.0.1/', steps: [{ action: 'fill', selector: '#name', value: 'Kodo' }, { action: 'click', selector: '#verify' }], assertions: [{ selector: '#result', text: 'Verified Kodo' }] };
  const r = await runChromeCase({ case: c, config: { timeoutMs: 5000 }, browser: { cdpUrl: 'http://127.0.0.1:12345' }, evidenceDir: process.cwd(), tool: { command: process.execPath, args: [fileURLToPath(new URL('./fixtures/kodo-ui-mcp-server.mjs', import.meta.url))] } });
  assert.equal(r.observations[0].text, 'Verified Kodo');
});
