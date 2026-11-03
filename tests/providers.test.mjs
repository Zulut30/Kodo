import test from 'node:test';
import assert from 'node:assert/strict';
import { runProcess, redact, subscriptionEnvironment, codexIsolationOverrides } from '../runtime/process.mjs';
import { ProviderError, requestJson, subscriptionStatus, sessionInvocation, parseSessionEvents, runSession, discoverProviders, analyzeGemini, decideJev, classifyProviderFailure, providerSchema } from '../runtime/providers.mjs';
import { readFile, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { research } from '../runtime/research.mjs';

const secrets = { GEMINI_API_KEY: 'test-gemini-secret-123', TYPESAFE_API_KEY: 'test-jev-secret-123', SCRAPEDO_TOKEN: 'test-scrape-secret-123', REDDIT_API_KEY: 'test-reddit-secret-123', GETX_API_KEY: 'test-x-secret-123' };
const response = (value, status = 200, headers = {}) => new Response(typeof value === 'string' ? value : JSON.stringify(value), { status, headers });
const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false };
const models = [{ id: 'codex:gpt-6.1-sol', client: 'codex', model: 'gpt-6.1-sol', available: true }, { id: 'codex:gpt-6-astra', client: 'codex', model: 'gpt-6-astra', available: true }];
const codexEvents = [ { type: 'thread.started', thread_id: 'session-1' }, { type: 'item.completed', item: { type: 'agent_message', text: '{"ok":true}' } }, { type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 3 } } ];

test('Worker environment strips provider secrets and API overrides while preserving ordinary variables', () => {
  const environment = subscriptionEnvironment({ ...secrets, OPENAI_API_KEY: 'api-secret', ANTHROPIC_AUTH_TOKEN: 'oauth-secret', OPENAI_BASE_URL: 'https://other.example', ANTHROPIC_BASE_URL: 'https://other.example', GH_TOKEN: 'github-secret', KODO_HOME: '/private/state', CLAUDECODE: '1', KODO_PLAIN: 'state', CODEX_APP_TOOLS_PIPE_PATH: 'parent-tools-pipe', CODEX_SESSION_ID: 'parent-session', CODEX_PERMISSION_PROFILE: 'parent-profile', CODEX_HOME: '/subscription-home', ordinary: 'keep' });
  for (const name of [...Object.keys(secrets), 'OPENAI_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_BASE_URL', 'ANTHROPIC_BASE_URL', 'GH_TOKEN', 'KODO_HOME', 'CLAUDECODE', 'KODO_PLAIN', 'CODEX_APP_TOOLS_PIPE_PATH', 'CODEX_SESSION_ID', 'CODEX_PERMISSION_PROFILE']) assert.equal(environment[name], undefined, name);
  assert.equal(environment.ordinary, 'keep');
  assert.equal(environment.CODEX_HOME, '/subscription-home');
});

test('Explicit clean subscription environments never reintroduce polluted parent variables', async () => {
  const polluted = { DATABASE_URL: 'fixture-private-database', GH_HOST: 'github.fixture', GH_CONFIG_DIR: '/fixture-github-auth', GITHUB_ENTERPRISE_HOST: 'github.fixture', SERVICE_BASE_URL: 'https://fixture-provider', SUBSCRIPTION_FIXTURE_PARENT_ONLY: 'parent-value' };
  const before = Object.fromEntries(Object.keys(polluted).map(name => [name, process.env[name]]));
  Object.assign(process.env, polluted);
  try {
    const clean = { PATH: 'fixture-client-path', CODEX_HOME: '/fixture-codex', ordinary: 'keep' };
    assert.deepEqual(subscriptionEnvironment(clean), clean);
    const seen = [];
    const result = await runSession({ client: 'codex', cwd: process.cwd(), prompt: 'fixture request', schema, readOnly: true, env: clean }, {
      resolveClientImpl: async (client, environment) => { seen.push(environment); return { command: 'fixture', args: [] }; },
      processImpl: async invocation => {
        seen.push(invocation.env);
        if (invocation.args.includes('status')) return { exitCode: 0, stdout: 'Logged in using ChatGPT', stderr: '' };
        for (const event of codexEvents) invocation.onLine(JSON.stringify(event));
        return { exitCode: 0, stdout: '', stderr: '' };
      }
    });
    assert.deepEqual(result.output, { ok: true });
    assert.equal(seen.length, 3);
    for (const environment of seen) assert.deepEqual(environment, clean);
  } finally {
    for (const [name, value] of Object.entries(before)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  }
});

test('Default subscription startup filters parent credentials while retaining native client discovery variables', async () => {
  const polluted = { DATABASE_URL: 'fixture-private-database', GH_HOST: 'github.fixture', GH_CONFIG_DIR: '/fixture-github-auth', GITHUB_USER: 'fixture-user', SERVICE_BASE_URL: 'https://fixture-provider', OPENAI_MODEL: 'api-model', ANTHROPIC_MODEL: 'api-model', ANTHROPIC_API_KEY: 'fixture-api-key', CLAUDECODE: '1', CODEX_APP_TOOLS_PIPE_PATH: 'fixture-pipe', CODEX_HOME: '/fixture-codex-home', SUBSCRIPTION_FIXTURE_ORDINARY: 'keep' };
  const before = Object.fromEntries(Object.keys(polluted).map(name => [name, process.env[name]]));
  Object.assign(process.env, polluted);
  try {
    const checked = [];
    const result = await runSession({ client: 'codex', cwd: process.cwd(), prompt: 'fixture request', schema, readOnly: true }, {
      resolveClientImpl: async (client, environment) => { checked.push(environment); return { command: 'fixture', args: [] }; },
      processImpl: async invocation => {
        checked.push(invocation.env);
        if (invocation.args.includes('status')) return { exitCode: 0, stdout: 'Logged in using ChatGPT', stderr: '' };
        for (const event of codexEvents) invocation.onLine(JSON.stringify(event));
        return { exitCode: 0, stdout: '', stderr: '' };
      }
    });
    assert.deepEqual(result.output, { ok: true });
    assert.equal(checked.length, 3);
    for (const environment of checked) {
      for (const name of Object.keys(polluted).filter(name => !['CODEX_HOME', 'SUBSCRIPTION_FIXTURE_ORDINARY'].includes(name))) assert.equal(environment[name], undefined, name);
      assert.equal(environment.CODEX_HOME, '/fixture-codex-home');
      assert.equal(environment.SUBSCRIPTION_FIXTURE_ORDINARY, 'keep');
      const pathName = Object.keys(process.env).find(name => name.toUpperCase() === 'PATH');
      assert.ok(pathName, 'The native client needs the inherited executable search path');
      assert.equal(environment[pathName], process.env[pathName]);
    }
  } finally {
    for (const [name, value] of Object.entries(before)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  }
});

test('Redaction removes known credentials, bearer headers and Scrape token URLs', () => {
  const raw = `https://api.scrape.do/?token=${secrets.SCRAPEDO_TOKEN}&url=public Authorization: Bearer abcdefghijklmnop ${secrets.GEMINI_API_KEY}`;
  const safe = redact(raw, secrets);
  assert.equal(safe.includes(secrets.SCRAPEDO_TOKEN), false);
  assert.equal(safe.includes(secrets.GEMINI_API_KEY), false);
  assert.equal(safe.includes('abcdefghijklmnop'), false);
  assert.match(safe, /\?token=\[REDACTED\]&url=public/);
});

test('Process runner passes literal stdin and streams complete lines without shell interpolation', async () => {
  const lines = [];
  const input = 'literal $() `code` & | ;\nsecond';
  const result = await runProcess({ command: process.execPath, args: ['-e', "process.stdin.setEncoding('utf8');let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>process.stdout.write(s));"], input, onLine: line => lines.push(line), timeoutMs: 10000 });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, input);
  assert.deepEqual(lines, ['literal $() `code` & | ;', 'second']);
});

test('Process runner cancels a running child and bounds captured output', async () => {
  const controller = new AbortController();
  const pending = runProcess({ command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'], signal: controller.signal, timeoutMs: 10000 });
  controller.abort(new Error('test cancellation'));
  await assert.rejects(pending, /test cancellation/);
  await assert.rejects(runProcess({ command: process.execPath, args: ['-e', "process.stdout.write('a'.repeat(8192));setInterval(()=>{},1000)"], maxOutputBytes: 100, timeoutMs: 10000 }), error => error.code === 'KODO_OUTPUT_LIMIT');
});

test('Subscription checks accept subscription auth and reject API auth without a model call', async () => {
  const resolveClientImpl = async () => ({ command: 'fixture', args: [] });
  const codex = await subscriptionStatus('codex', { resolveClientImpl, processImpl: async invocation => { assert.deepEqual(invocation.args, ['login', 'status']); return { exitCode: 0, stdout: '', stderr: 'Logged in using ChatGPT' }; } });
  assert.equal(codex.auth, 'subscription');
  await assert.rejects(subscriptionStatus('codex', { resolveClientImpl, processImpl: async () => ({ exitCode: 0, stdout: 'Logged in using API key', stderr: '' }) }), error => error.code === 'auth');
  const claude = await subscriptionStatus('claude-code', { resolveClientImpl, processImpl: async () => ({ exitCode: 0, stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty' }), stderr: '' }) });
  assert.equal(claude.available, true);
  await assert.rejects(subscriptionStatus('claude-code', { resolveClientImpl, processImpl: async () => ({ exitCode: 0, stdout: JSON.stringify({ loggedIn: true, authMethod: 'api_key' }), stderr: '' }) }), error => error.code === 'auth');
});

test('Client invocation uses exact session IDs, subscription mode and genuinely read-only reviewers', () => {
  const fresh = sessionInvocation({ client: 'codex', model: 'gpt-6.1-sol', cwd: '/project', readOnly: true, schemaPath: '/schema.json' });
  assert.ok(fresh.args.includes('read-only'));
  assert.ok(fresh.args.includes('--no-daemon'));
  assert.ok(fresh.args.includes('sandbox_mode="read-only"'));
  assert.ok(sessionInvocation({ client: 'codex', cwd: '/project' }).args.includes('sandbox_mode="workspace-write"'));
  assert.ok(fresh.args.includes('forced_login_method="chatgpt"'));
  assert.equal(fresh.args.at(-1), '-');
  const resumed = sessionInvocation({ client: 'codex', sessionId: 'exact-session', cwd: '/project' });
  assert.deepEqual(resumed.args.slice(resumed.args.indexOf('exec')), ['exec', 'resume', 'exact-session', '--json', '-']);
  assert.equal(fresh.args.includes('--ignore-user-config'), false);
  if (process.platform === 'win32') assert.ok(fresh.args.includes('windows.sandbox="elevated"'));
  assert.equal(resumed.args.includes('--last'), false);
  assert.throws(() => sessionInvocation({ client: 'codex', readOnly: true, sessionId: 'prior-write-session' }), error => error.code === 'invalid_output');
  const claude = sessionInvocation({ client: 'claude-code', readOnly: true, schema });
  assert.equal(claude.args[claude.args.indexOf('--tools') + 1], 'Read,Glob,Grep');
  assert.ok(claude.args.includes('--strict-mcp-config'));
  assert.equal(claude.args.includes('--bare'), false);
  assert.match(claude.sessionId, /^[a-f0-9-]{36}$/);
  assert.throws(() => sessionInvocation({ client: 'unknown' }), error => error.code === 'unavailable');
});

test('Codex isolation overrides disable configured MCPs and plugins without rewriting user files', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kodo-isolation-test-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('kodo-isolation-test-'));
    await rm(directory, { recursive: true, force: true });
  });
  const home = path.join(directory, 'home'), project = path.join(directory, 'project');
  await mkdir(home); await mkdir(path.join(project, '.codex'), { recursive: true }); await mkdir(path.join(project, '.git'));
  const userConfig = '[windows]\nsandbox="elevated"\n[mcp_servers."source.with.dot"]\ncommand="some-client"\n[plugins."some-plugin@market"]\nenabled=true\n';
  const projectConfig = '[mcp_servers.project]\ncommand="project-server"\n';
  await writeFile(path.join(home, 'config.toml'), userConfig);
  await writeFile(path.join(project, '.codex/config.toml'), projectConfig);
  const args = await codexIsolationOverrides(project, { CODEX_HOME: home });
  assert.ok(args.includes('mcp_servers."source.with.dot".enabled=false'));
  assert.ok(args.includes('mcp_servers."project".enabled=false'));
  assert.ok(args.includes('plugins."some-plugin@market".enabled=false'));
  assert.ok(args.includes('notify=[]'));
  assert.equal(args.some(value => value.includes('sandbox_mode')), false);
  assert.equal(await readFile(path.join(home, 'config.toml'), 'utf8'), userConfig);
  assert.equal(await readFile(path.join(project, '.codex/config.toml'), 'utf8'), projectConfig);
});

test('Provider event parser requires completion, exact output contract and session identity', () => {
  const result = parseSessionEvents('codex', codexEvents, { schema, model: 'gpt-6.1-sol' });
  assert.equal(result.sessionId, 'session-1');
  assert.deepEqual(result.output, { ok: true });
  assert.equal(result.usage.input_tokens, 10);
  assert.throws(() => parseSessionEvents('codex', codexEvents.slice(0, 2), { schema }), error => error.code === 'invalid_output');
  assert.throws(() => parseSessionEvents('codex', [...codexEvents.slice(0, 1), { type: 'item.completed', item: { type: 'agent_message', text: '{"wrong":true}' } }, codexEvents[2]], { schema }), error => error.code === 'invalid_output');
  const claude = parseSessionEvents('claude-code', [{ type: 'system', subtype: 'init', session_id: 'claude-exact' }, { type: 'result', subtype: 'success', structured_output: { ok: false }, usage: { output_tokens: 2 } }], { schema });
  assert.deepEqual(claude.output, { ok: false });
  assert.equal(claude.sessionId, 'claude-exact');
  assert.throws(() => parseSessionEvents('claude-code', [{ type: 'result', is_error: true, result: 'Usage limit reached' }], { schema, sessionId: 's' }), error => error.code === 'quota');
});

test('Native parser adds nullable metrics while preserving the original usage result', () => {
  const events = [...codexEvents.slice(0, 2), { type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 80, output_tokens: 20 } }];
  const result = parseSessionEvents('codex', events, { schema, durationMs: 25 });
  assert.equal(result.usage.cached_input_tokens, 80);
  assert.equal(result.metrics.usage.totalTokens, 120);
  assert.equal(result.metrics.durationMs, 25);
  assert.equal(result.metrics.nativeRequestCount, null);
});

test('Native session returns monotonic metrics and sanitized completed tool counts', async () => {
  let now = 100;
  const result = await runSession({ client: 'codex', cwd: process.cwd(), prompt: 'fixture task', schema }, {
    nowImpl: () => now,
    resolveClientImpl: async () => ({ command: 'fixture', args: [] }),
    processImpl: async invocation => {
      if (invocation.args.includes('status')) return { exitCode: 0, stdout: 'Logged in using ChatGPT', stderr: '' };
      const item = { id: 'cmd-1', type: 'command_execution', command: secrets.GEMINI_API_KEY };
      for (const event of [{ type: 'item.started', item }, { type: 'item.completed', item }, { type: 'item.completed', item }, ...codexEvents]) invocation.onLine(JSON.stringify(event));
      now = 137.5;
      return { exitCode: 0, stdout: '', stderr: '' };
    }
  });
  assert.equal(result.metrics.durationMs, 37.5);
  assert.equal(result.metrics.toolSteps, 1);
  assert.equal(result.metrics.usage.totalTokens, 13);
  assert.equal(JSON.stringify(result.metrics).includes(secrets.GEMINI_API_KEY), false);
});

test('Native failures retain safe attempt metrics and observed usage on the error', async () => {
  await assert.rejects(runSession({ client: 'codex', cwd: process.cwd(), prompt: 'fixture task', schema }, {
    resolveClientImpl: async () => ({ command: 'fixture', args: [] }),
    processImpl: async invocation => {
      if (invocation.args.includes('status')) return { exitCode: 0, stdout: 'Logged in using ChatGPT', stderr: '' };
      for (const event of [{ type: 'item.completed', item: { id: 'failed-command', type: 'command_execution' } }, ...codexEvents, { type: 'turn.failed', error: { message: 'Usage limit reached' } }]) invocation.onLine(JSON.stringify(event));
      return { exitCode: 1, stdout: '', stderr: 'Usage limit reached' };
    }
  }), error => error.code === 'quota' && error.metrics.toolSteps === 1 && error.metrics.usage.totalTokens === 13 && error.metrics.durationMs >= 0);
});

test('Claude native metrics retain separate cache semantics without retaining tool payloads', async () => {
  const result = await runSession({ client: 'claude-code', cwd: process.cwd(), prompt: 'fixture task', schema, env: {} }, {
    resolveClientImpl: async () => ({ command: 'fixture', args: [] }),
    processImpl: async invocation => {
      if (invocation.args.includes('status')) return { exitCode: 0, stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }), stderr: '' };
      const assistant = { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'claude-tool-1', name: 'Read', input: secrets }] } };
      for (const event of [assistant, assistant, { type: 'result', subtype: 'success', structured_output: { ok: true }, usage: { input_tokens: 2, cache_read_input_tokens: 10, cache_creation_input_tokens: 3, output_tokens: 4 } }]) invocation.onLine(JSON.stringify(event));
      return { exitCode: 0, stdout: '', stderr: '' };
    }
  });
  assert.equal(result.usage.input_tokens, 2);
  assert.equal(result.metrics.usage.totalTokens, 19);
  assert.equal(result.metrics.toolSteps, 1);
  assert.equal(JSON.stringify(result.metrics).includes(secrets.GEMINI_API_KEY), false);
});

test('Invalid native output and interrupted processes retain unknown usage and preserve abort identity', async () => {
  const controller = new AbortController(), reason = new Error('fixture cancelled');
  const dependencies = {
    resolveClientImpl: async () => ({ command: 'fixture', args: [] }),
    processImpl: async invocation => {
      if (invocation.args.includes('status')) return { exitCode: 0, stdout: 'Logged in using ChatGPT', stderr: '' };
      invocation.onLine(JSON.stringify({ type: 'item.completed', item: { id: 'cmd-1', type: 'command_execution' } }));
      if (invocation.signal) { controller.abort(reason); throw reason; }
      return { exitCode: 0, stdout: '', stderr: '' };
    }
  };
  await assert.rejects(runSession({ client: 'codex', cwd: process.cwd(), prompt: 'fixture task', schema }, dependencies), error => error.code === 'invalid_output' && error.metrics.usage.totalTokens === null && error.metrics.toolSteps === 1);
  await assert.rejects(runSession({ client: 'codex', cwd: process.cwd(), prompt: 'fixture task', signal: controller.signal }, dependencies), error => error === reason && error.metrics.toolSteps === 1 && error.metrics.nativeRequestCount === null);
});

test('Session adapter emits identity before completion and never streams tool payloads', async () => {
  const streamed = [], invocations = [];
  const result = await runSession({ client: 'codex', model: 'gpt-6.1-sol', cwd: process.cwd(), prompt: 'literal prompt with $() &', schema, readOnly: true, env: secrets, onEvent: event => streamed.push(event) }, {
    resolveClientImpl: async () => ({ command: 'fixture', args: ['launcher.js'] }),
    processImpl: async invocation => {
      invocations.push(invocation);
      if (invocation.args.includes('status')) return { exitCode: 0, stdout: 'Logged in using ChatGPT', stderr: '' };
      for (const event of [...codexEvents.slice(0, 1), { type: 'item.completed', item: { type: 'command_execution', aggregated_output: secrets.GEMINI_API_KEY } }, ...codexEvents.slice(1)]) invocation.onLine(JSON.stringify(event));
      return { exitCode: 0, stdout: '', stderr: '' };
    }
  });
  assert.deepEqual(result.output, { ok: true });
  assert.equal(streamed[0].sessionId, 'session-1');
  assert.equal(JSON.stringify(streamed).includes(secrets.GEMINI_API_KEY), false);
  assert.equal(invocations[1].input, 'literal prompt with $() &');
  assert.equal(invocations[1].env.GEMINI_API_KEY, undefined);
});

test('Provider schema normalization removes unsupported uniqueness only from wire schemas', async () => {
  const original = { type: 'object', properties: { dependsOn: { type: 'array', items: { type: 'string' }, uniqueItems: true }, uniqueItems: { type: 'string' }, literal: { const: { uniqueItems: true } } }, required: ['dependsOn', 'uniqueItems', 'literal'], additionalProperties: false };
  const normalized = providerSchema(original);
  assert.equal(normalized.properties.dependsOn.uniqueItems, undefined);
  assert.deepEqual(normalized.properties.uniqueItems, { type: 'string' });
  assert.deepEqual(normalized.properties.literal.const, { uniqueItems: true });
  assert.equal(original.properties.dependsOn.uniqueItems, true);
  let observedWireSchema;
  await assert.rejects(runSession({ client: 'codex', model: 'gpt-6.1-sol', cwd: process.cwd(), prompt: 'Return a dependency list', schema: original, readOnly: true }, {
    resolveClientImpl: async () => ({ command: 'fixture', args: [] }),
    processImpl: async invocation => {
      if (invocation.args.includes('status')) return { exitCode: 0, stdout: 'Logged in using ChatGPT', stderr: '' };
      observedWireSchema = JSON.parse(await readFile(invocation.args[invocation.args.indexOf('--output-schema') + 1], 'utf8'));
      for (const event of [{ type: 'thread.started', thread_id: 'schema-session' }, { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({ dependsOn: ['task-a', 'task-a'], uniqueItems: 'ordinary property', literal: { uniqueItems: true } }) } }, { type: 'turn.completed' }]) invocation.onLine(JSON.stringify(event));
      return { exitCode: 0, stdout: '', stderr: '' };
    }
  }), error => error.code === 'invalid_output' && /duplicate/.test(error.message));
  assert.equal(observedWireSchema.properties.dependsOn.uniqueItems, undefined);
});

test('Discovery keeps providers isolated by default and excludes unavailable models after live checks', async () => {
  const options = { statusImpl: async () => ({ available: true }), cacheImpl: async () => [{ slug: 'gpt-6.1-sol' }, { slug: 'gpt-6-astra' }] };
  const local = await discoverProviders({ client: 'codex' }, options);
  assert.ok(local.every(item => item.client === 'codex'));
  assert.equal(local.find(item => item.model === 'gpt-6.1-terra').available, false);
  const mixed = await discoverProviders({ client: 'claude-code', providers: 'both', primaryModel: 'sonnet' }, { ...options, live: true, sessionImpl: async invocation => { if (invocation.model === 'opus') throw new ProviderError('model unavailable'); return { output: { ok: true } }; } });
  assert.equal(mixed[0].model, 'sonnet');
  assert.ok(mixed.some(item => item.client === 'codex'));
  assert.equal(mixed.find(item => item.model === 'opus').available, false);
  assert.equal(mixed.find(item => item.model === 'sonnet').verified, true);
});

test('Discovery respects configured model allowlists and never adds an unapproved primary', async () => {
  const options = { config: { models: { codex: ['gpt-6.1-sol'], 'claude-code': ['sonnet'] } }, statusImpl: async () => ({ available: true }), cacheImpl: async () => [{ slug: 'gpt-6.1-sol' }, { slug: 'gpt-6-astra' }] };
  const result = await discoverProviders({ client: 'codex', providers: 'both', primaryModel: 'gpt-6-astra' }, options);
  assert.deepEqual(result.map(item => item.id), ['codex:gpt-6.1-sol', 'claude-code:sonnet']);
  assert.ok(result.every(item => item.available));
  const unavailable = await discoverProviders({ client: 'codex' }, { ...options, config: { models: { codex: ['not-in-catalog'] } } });
  assert.deepEqual(unavailable.map(item => [item.model, item.available]), [['not-in-catalog', false]]);
  const empty = await discoverProviders({ client: 'codex' }, { ...options, config: { models: { codex: [] } } });
  assert.deepEqual(empty, []);
  await assert.rejects(discoverProviders({ client: 'codex' }, { ...options, config: { models: { codex: 'gpt-6.1-sol' } } }), error => error.code === 'invalid_output');
});

test('HTTP requests retry transient service failures but surface auth and quota with redaction', async () => {
  let calls = 0;
  const result = await requestJson('https://api.example.test/data', { fetchImpl: async () => ++calls === 1 ? response({ error: 'retry' }, 503) : response({ ok: true }) });
  assert.deepEqual(result, { ok: true });
  assert.equal(calls, 2);
  calls = 0;
  await assert.rejects(requestJson('https://api.example.test/data', { secrets, fetchImpl: async () => { calls++; return response({ error: secrets.GEMINI_API_KEY }, 401); } }), error => error.code === 'auth' && !error.message.includes(secrets.GEMINI_API_KEY));
  assert.equal(calls, 1);
  await assert.rejects(requestJson('https://api.example.test/data', { fetchImpl: async () => response({ error: 'quota' }, 429, { 'Retry-After': '120' }) }), error => error.code === 'quota' && Date.parse(error.retryAt) > Date.now());
  await assert.rejects(requestJson('https://api.example.test/data', { fetchImpl: async () => response('not-json') }), error => error.code === 'invalid_output');
  assert.equal(classifyProviderFailure('Model unavailable').code, 'unavailable');
  assert.equal(classifyProviderFailure('Failed to authenticate: OAuth session expired and could not be refreshed').code, 'auth');
});

test('Gemini analysis uses the configured model and rejects invented file evidence', async () => {
  let invocation;
  const fetchImpl = async (url, options) => { invocation = { url, options }; return response({ modelVersion: 'gemini-4-argon', candidates: [{ content: { parts: [{ text: JSON.stringify({ summary: 'Project inspected', files: ['src/app.mjs'], limitations: ['Runtime not checked'] }) }] } }] }); };
  const result = await analyzeGemini({ task: 'Add export', files: [{ path: 'src/app.mjs', content: 'export const value=1;' }] }, { secrets, fetchImpl });
  assert.deepEqual(result.files, ['src/app.mjs']);
  assert.match(invocation.url, /models\/gemini-4-argon:generateContent$/);
  assert.equal(invocation.options.headers['x-goog-api-key'], secrets.GEMINI_API_KEY);
  assert.equal(invocation.url.includes(secrets.GEMINI_API_KEY), false);
  assert.equal(JSON.parse(invocation.options.body).generationConfig.responseMimeType, 'application/json');
  await assert.rejects(analyzeGemini({ task: 'test', files: [] }, { secrets, fetchImpl }), error => error.code === 'invalid_output');
  await assert.rejects(analyzeGemini({ task: 'test' }), error => error.code === 'auth');
});

test('Gemini research query remains optional and enforces a nonempty 250 character boundary', async () => {
  const analyze = researchQuery => analyzeGemini({ task: 'Добавь поиск в каталоге проекта', files: [] }, { secrets, fetchImpl: async (_url, options) => {
    assert.match(JSON.parse(options.body).contents[0].parts[0].text, /concise English search query of 4-12 technical keywords/);
    const output = { summary: 'Relevant architecture', files: [], limitations: [], ...(researchQuery === undefined ? {} : { researchQuery }) };
    return response({ candidates: [{ content: { parts: [{ text: JSON.stringify(output) }] } }] });
  } });
  assert.equal((await analyze(undefined)).researchQuery, undefined);
  assert.equal((await analyze('  Node.js CLI  SQLite search APIs  ')).researchQuery, 'Node.js CLI SQLite search APIs');
  assert.equal((await analyze('a'.repeat(250))).researchQuery.length, 250);
  for (const value of ['a'.repeat(251), '', '   ', null, { query: 'sqlite' }]) await assert.rejects(analyze(value), error => error.code === 'invalid_output');
});

function jevOutput({ model = models[0].id, modelConfidence = 0.95, parallel = 'parallel', parallelConfidence = 0.95, session = 'fresh' } = {}) {
  return { model: 'jev-1.14.0', answers: { model: { type: 'choice', choice: model, confidence: modelConfidence }, execution: { type: 'choice', choice: parallel, confidence: parallelConfidence }, session: { type: 'choice', choice: session, confidence: 0.95 } } };
}

test('Jev scheduling question distinguishes active work from completed ancestors and blocked descendants', async () => {
  let request;
  const node = { id: 'context', parallelismFacts: { taskReady: true, compatibleReadyPeers: [{ id: 'qa' }], conflictingActivePeers: [] }, coordination: [{ id: 'ancestor', status: 'integrated' }, { id: 'future', status: 'pending' }] };
  const result = await decideJev({ task: 'Prepared worktree task', models, node }, { secrets, fetchImpl: async (url, options) => { request = JSON.parse(options.body); return response(jevOutput({ parallelConfidence: .74 })); } });
  assert.deepEqual(request.state.node, node);
  assert.match(request.questions.execution.instructions, /parallelismFacts/);
  assert.match(request.questions.execution.instructions, /completed ancestors.*blocked descendants/i);
  assert.match(request.questions.execution.instructions, /snapshot/i);
  assert.match(request.questions.execution.criteria.serial, /active|ready/i);
  assert.equal(result.parallel, false, 'richer evidence does not override conservative typed confidence');
  assert.equal(result.parallelConfidence, .74);
});

test('Jev exposes independent confidence for model execution and session decisions', async () => {
  const models = [{ id: 'sol', client: 'codex', model: 'gpt-6.1-sol' }, { id: 'astra', client: 'codex', model: 'gpt-6-astra' }];
  const value = { model: 'fixture-jev', answers: {
    model: { type: 'choice', choice: 'sol', confidence: .2 },
    execution: { type: 'choice', choice: 'parallel', confidence: .95 },
    session: { type: 'choice', choice: 'fresh', confidence: .1 }
  } };
  const result = await decideJev({ task: 'Independent prepared module', models, node: { id: 'module', parallel: true } }, { secrets, fetchImpl: async () => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } }) });
  assert.equal(result.model, 'astra'); assert.equal(result.parallel, true);
  assert.equal(result.modelConfidence, .2); assert.equal(result.parallelConfidence, .95); assert.equal(result.sessionConfidence, .1); assert.equal(result.confidence, .1);
});

test('Jev selects only allowed models and falls back conservatively for uncertainty or service failure', async () => {
  let request;
  const result = await decideJev({ task: 'Implement export', models, node: { id: 'export' } }, { secrets, fetchImpl: async (url, options) => { request = JSON.parse(options.body); return response(jevOutput()); } });
  assert.equal(result.model, models[0].id);
  assert.equal(result.parallel, true);
  assert.deepEqual(Object.keys(request.questions.model.criteria), models.map(item => item.id));
  const uncertain = await decideJev({ task: 'Hard change', models, node: { id: 'x' } }, { secrets, fetchImpl: async () => response(jevOutput({ modelConfidence: 0.2, parallelConfidence: 0.3, session: 'continue' })) });
  assert.equal(uncertain.model, models[1].id);
  assert.equal(uncertain.parallel, false);
  assert.equal(uncertain.sessionMode, 'fresh');
  const invalid = await decideJev({ task: 'test', models }, { secrets, fetchImpl: async () => response(jevOutput({ model: 'unapproved-api' })) });
  assert.equal(invalid.fallback, true);
  assert.equal(invalid.model, models[0].id);
  const failed = await decideJev({ task: 'test', models }, { secrets, fetchImpl: async () => response({ error: 'unauthorized' }, 401) });
  assert.equal(failed.fallback, true);
  assert.equal(failed.parallel, false);
  await assert.rejects(decideJev({ task: 'test', models: [] }, { secrets }), error => error.code === 'unavailable');
});

test('Research attempts all sources, caches successful lookups and never uses write endpoints', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (url.includes('redditapis')) return response({ data: { children: [{ data: { title: 'Library discussion', permalink: '/r/node/comments/123/library', selftext: 'Useful library' } }] } });
    if (url.includes('getxapi')) return response({ tweets: [{ id: '456', text: 'A useful sqlite library' }] });
    const target = new URL(url).searchParams.get('q');
    if (target.includes('github.com')) return response('<a href="https://github.com/example/library">Library repository</a>');
    if (target.includes('ycombinator')) return response('<a href="https://news.ycombinator.com/item?id=789">Discussion</a>');
    return response('<a href="https://nodejs.org/api/sqlite.html">SQLite documentation</a>');
  };
  const result = await research({ task: 'nodejs sqlite', budget: 5 }, { secrets, fetchImpl });
  assert.equal(result.requests, 5);
  assert.deepEqual([...new Set(result.items.map(item => item.source))].sort(), ['docs', 'github', 'hackernews', 'reddit', 'x']);
  assert.equal(result.errors.length, 0);
  assert.ok(calls.every(call => call.options.method === 'GET'));
  assert.equal(result.items.find(item => item.source === 'reddit').url, 'https://www.reddit.com/r/node/comments/123/library');
  assert.ok(result.items.every(item => item.verification.startsWith('discovery only')));
  const again = await research({ task: 'nodejs sqlite', cache: result.cache, budget: 0 }, { secrets, fetchImpl });
  assert.equal(again.requests, 0);
  assert.equal(calls.length, 5);
  assert.deepEqual(again.items, result.items);
});

test('Research obeys its request ceiling and a failed source does not stop remaining sources', async () => {
  let calls = 0;
  const limited = await research({ task: 'sqlite', budget: 2 }, { secrets, fetchImpl: async () => { calls++; return response({ results: [] }); } });
  assert.equal(calls, 2);
  assert.equal(limited.requests, 2);
  assert.equal(limited.errors.filter(item => item.code === 'budget').length, 3);
  const mixed = await research({ task: 'sqlite', budget: 5 }, { secrets, fetchImpl: async url => url.includes('redditapis') ? response({ error: secrets.REDDIT_API_KEY }, 403) : response({ results: [] }) });
  assert.equal(mixed.requests, 5);
  assert.equal(mixed.errors[0].source, 'reddit');
  assert.equal(mixed.errors[0].code, 'auth');
  assert.equal(JSON.stringify(mixed.errors).includes(secrets.REDDIT_API_KEY), false);
  const serviceErrors = await research({ task: 'sqlite', budget: 5 }, { secrets, fetchImpl: async () => response({ status: 'error', message: 'authentication required' }) });
  assert.equal(serviceErrors.errors.length, 5);
  assert.ok(serviceErrors.errors.every(error => error.code === 'auth'));
});

test('Research isolates JSON sources and retains only relevant documentation candidates', async () => {
  const result = await research({ task: 'Node.js sqlite search APIs', budget: 5 }, { secrets, fetchImpl: async url => {
    if (url.includes('redditapis') || url.includes('getxapi')) return response({ results: [] });
    const query = new URL(url).searchParams.get('q');
    if (query.includes('site:github.com')) return response({ organic_results: [
      { link: 'https://unrelated.test/sqlite', title: 'SQLite repository mirror' },
      { link: 'https://github.com/topics/sqlite', title: 'SQLite topics' },
      { link: 'https://github.com/example/sqlite-library', title: 'SQLite library' },
      { link: 'https://github.com.evil.test/example/sqlite-library', title: 'SQLite misleading host' }
    ] });
    if (query.includes('site:news.ycombinator.com')) return response({ organic_results: [
      { link: 'https://ycombinator.com/companies', title: 'SQLite startup' },
      { link: 'https://news.ycombinator.com/', title: 'Hacker News sqlite' },
      { link: 'https://news.ycombinator.com/item?id=12345', title: 'SQLite discussion' },
      { link: 'https://news.ycombinator.com/item?id=invalid', title: 'Invalid item' }
    ] });
    return response({ organic_results: [
      { link: 'https://keetools.io/explorer/blocks', title: 'Latest blocks' },
      { link: 'https://docs.unrelated.test/coins', title: 'Digital currencies' },
      { link: 'https://blog.example.test/sqlite', title: 'SQLite comparison' },
      { link: 'https://nodejs.org/api/sqlite.html', title: 'Node.js SQLite documentation' },
      { link: 'https://docs.github.com/en/rest/search', title: 'Search API documentation' }
    ] });
  } });
  assert.deepEqual(result.items.map(item => [item.source, item.url]), [
    ['github', 'https://github.com/example/sqlite-library'],
    ['hackernews', 'https://news.ycombinator.com/item?id=12345'],
    ['docs', 'https://nodejs.org/api/sqlite.html'],
    ['docs', 'https://docs.github.com/en/rest/search']
  ]);
  assert.ok(result.items.every(item => item.verification.startsWith('discovery only')));
});

test('Research bounds the outgoing query and filters off-source HTML links', async () => {
  const queries = [];
  const result = await research({ task: 'sqlite '.repeat(100), budget: 5 }, { secrets, fetchImpl: async url => {
    const parsed = new URL(url);
    queries.push(parsed.searchParams.get('q'));
    if (!url.includes('scrape.do')) return response({ results: [] });
    return response('<a href="https://unrelated.test/sqlite">Unrelated SQLite</a><a href="https://github.com/example/sqlite">SQLite repository</a><a href="https://news.ycombinator.com/item?id=99">SQLite discussion</a><a href="https://nodejs.org/api/sqlite.html">SQLite docs</a>');
  } });
  assert.equal(queries[0].length, 250);
  assert.equal(queries[1].length, 250);
  assert.ok(queries.slice(2).every(query => query.length < 280));
  assert.deepEqual(result.items.map(item => item.source), ['github', 'hackernews', 'docs']);
});
