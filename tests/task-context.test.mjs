import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTaskContext,
  taskContract,
  validateTaskContract,
  maxTaskContractBytes,
} from '../runtime/task-context.mjs';

test('Task contracts preserve code templates and optional JSON syntax while redacting credentials before shortening', () => {
  const example = 'const header = `Bearer ${token}`;',
    quoted = 'Preserve the exact header "Bearer ${token}" and all criteria';
  const secret = 'fixture_context_private_123',
    shaped = 'sk-proj-' + 'c'.repeat(24),
    secrets = { KEY: secret };
  const task = {
    id: 'headers',
    role: 'developer',
    description: example,
    writePaths: ['auth.mjs'],
    acceptance: [quoted, example],
    constraints: ['Bearer ${token}-private-suffix', 'Bearer ' + secret, 'Bearer ' + shaped],
    interfaces: ['Use `?token=${token}`;'],
    dependsOn: ['base'],
  };
  const run = {
    nodes: { base: { status: 'integrated', result: { summary: quoted } } },
    task: 'x'.repeat(590) + secret,
    analysis: { summary: 'x'.repeat(590) + shaped },
  };
  const contract = taskContract(task, secrets),
    context = buildTaskContext(run, task, { secrets });
  assert.equal(contract.description, example);
  assert.deepEqual(contract.acceptance, [quoted, example]);
  assert.deepEqual(contract.constraints, ['Bearer [REDACTED]', 'Bearer [REDACTED]', 'Bearer [REDACTED]']);
  assert.ok(context.includes(example));
  assert.ok(context.includes(quoted));
  assert.ok(context.includes(task.interfaces[0]));
  const dependencies = JSON.parse(
    context
      .split('\n')
      .find(line => line.startsWith('Direct dependencies '))
      .split(': ')
      .slice(1)
      .join(': '),
  );
  assert.equal(dependencies[0].summary, quoted);
  assert.doesNotMatch(context, /fixture_context_|sk-proj-|private-suffix/);
});

test('Task contracts preserve raw escaped source quotes and remove mixed credential values', () => {
  const example = 'Preserve source: const header = "\\\"Bearer ${token}\\\"";';
  const secret = 'fixture_private_credential',
    shaped = 'sk-proj-' + 'f'.repeat(24),
    secrets = { KEY: secret };
  const task = {
    id: 'escaped-source',
    role: 'developer',
    description: example,
    writePaths: ['auth.mjs'],
    acceptance: [example],
    dependsOn: ['base'],
    constraints: [secret, shaped, '${token}-private-suffix'].map(value => example.replace('${token}', value)),
  };
  const run = {
    nodes: { base: { status: 'integrated', result: { summary: example } } },
    analysis: { summary: example },
  };
  const contract = taskContract(task, secrets),
    context = buildTaskContext(run, task, { secrets });
  assert.equal(contract.description, example);
  assert.deepEqual(contract.acceptance, [example]);
  assert.deepEqual(contract.constraints, Array(3).fill('Preserve source: const header = "\\\"Bearer [REDACTED]\\\"";'));
  assert.ok(context.includes(example));
  const line = context.split('\n').find(line => line.startsWith('Direct dependencies '));
  assert.equal(JSON.parse(line.slice(line.indexOf(': ') + 2))[0].summary, example);
  assert.doesNotMatch(context, /fixture_private_credential|sk-proj-|private-suffix/);
});

test('Task contracts and inline context retain credential-handling examples while removing known and literal secrets', () => {
  const secrets = { KEY: 'fixture_context_private_123' },
    example = 'Bearer ${process.env.API_KEY}';
  const task = {
    id: 'credentials',
    role: 'developer',
    description: `Preserve ${example}`,
    writePaths: ['auth.mjs'],
    acceptance: ['Keep Bearer ${token} meaningful'],
    constraints: [`Never expose ${secrets.KEY} or Bearer literal-private-token`],
    interfaces: ['Use process.env.API_KEY'],
    dependsOn: ['base'],
  };
  const run = {
    task: `Handle ${example} and ${secrets.KEY}`,
    analysis: { summary: `Review Bearer ${secrets.KEY}` },
    nodes: { base: { status: 'integrated', result: { summary: `Uses ${example} and ${secrets.KEY}` } } },
  };
  const contract = taskContract(task, secrets),
    context = buildTaskContext(run, task, { secrets });
  assert.equal(contract.description, task.description);
  assert.deepEqual(contract.acceptance, task.acceptance);
  for (const text of [JSON.stringify(contract), context]) {
    assert.ok(text.includes(example));
    assert.ok(text.includes('Bearer ${token}'));
    assert.doesNotMatch(text, /fixture_context_private_123|literal-private-token/);
    assert.match(text, /\[REDACTED\]/);
  }
  assert.ok(task.constraints[0].includes(secrets.KEY), 'sanitization does not mutate the input contract');
});

test('Optional task summaries redact known credentials before truncation can expose a secret prefix', () => {
  const secret = 'PRIVATE_BOUNDARY_CREDENTIAL',
    secrets = { KEY: secret };
  const task = { id: 'boundary', description: 'Review auth.mjs', writePaths: ['auth.mjs'], dependsOn: ['base'] };
  const run = {
    task: 'x'.repeat(590) + secret,
    analysis: { summary: 'y'.repeat(590) + secret },
    nodes: { base: { status: 'integrated', result: { summary: 'd'.repeat(230) + secret } } },
    research: { items: [{ title: 'auth.mjs ' + 'r'.repeat(141) + secret, url: 'https://example.invalid/auth' }] },
  };
  const context = buildTaskContext(run, task, { secrets });
  assert.doesNotMatch(context, /PRIVATE_/);
  assert.match(context, /\[REDACTED\]/);
  assert.match(context, /https:\/\/example.invalid\/auth/);
});

test('Task context preserves scope acceptance interfaces and direct dependencies without nested history', () => {
  const task = {
    id: 'worker',
    role: 'developer',
    description: 'Implement src/value.mjs',
    writePaths: ['src/value.mjs'],
    acceptance: ['Value equals two'],
    interfaces: ['value() returns number'],
    constraints: ['Subscription only'],
    dependsOn: ['base'],
  };
  const run = {
    task: 'Build a feature',
    plan: {
      tasks: [task, { id: 'base', description: 'Base interface' }, { id: 'other', description: 'UNRELATED_TASK' }],
    },
    nodes: {
      base: { status: 'integrated', headSha: 'abc', result: { summary: 'Interface ready', prompt: 'NESTED_PROMPT' } },
      other: { result: { summary: 'UNRELATED_RESULT' } },
    },
    analysis: { summary: 'A small value module', standards: 'PINNED_HISTORY'.repeat(5000), history: 'RAW_HISTORY' },
    research: {
      items: [{ url: 'https://example.test/value', title: 'src/value.mjs contract', excerpt: 'RAW_RESEARCH' }],
    },
  };
  const context = buildTaskContext(run, task);
  for (const text of [
    'src/value.mjs',
    'Value equals two',
    'value() returns number',
    'Subscription only',
    'Interface ready',
    'https://example.test/value',
  ])
    assert.ok(context.includes(text), text);
  for (const text of [
    'PINNED_HISTORY',
    'RAW_HISTORY',
    'RAW_RESEARCH',
    'NESTED_PROMPT',
    'UNRELATED_RESULT',
    'UNRELATED_TASK',
  ])
    assert.ok(!context.includes(text), text);
  assert.ok(context.length <= 16000);
});

test('Task context bounds oversized optional data and redacts credential URLs', () => {
  const task = {
    id: 'one',
    description: 'Fix src/one',
    writePaths: ['src/one'],
    acceptance: ['Preserve required boundary'],
    dependsOn: [],
  };
  const context = buildTaskContext(
    {
      task: 'x'.repeat(100000),
      analysis: { summary: 'y'.repeat(100000) },
      research: {
        items: [{ url: 'https://example.test/src/one?token=secret-value', title: 'src/one', body: 'z'.repeat(100000) }],
      },
    },
    task,
  );
  assert.ok(context.length <= 16000);
  assert.match(context, /Preserve required boundary/);
  assert.ok(!context.includes('secret-value'));
});

test('Mandatory node fields retain late criteria and Unicode rather than per-field truncation', () => {
  const task = {
    id: 'complete',
    role: 'developer',
    description: 'д'.repeat(2600) + ' DESCRIPTION_END',
    writePaths: Array.from({ length: 120 }, (_, i) => `src/module-${i}.mjs`),
    acceptance: ['a'.repeat(3100) + ' ACCEPTANCE_END'],
    constraints: ['Keep every boundary'],
    interfaces: ['Return the public result'],
  };
  const context = buildTaskContext({}, task);
  for (const value of [
    task.description,
    task.acceptance[0],
    ...task.writePaths,
    ...task.constraints,
    ...task.interfaces,
  ])
    assert.ok(context.includes(value), 'complete mandatory value is present');
});

test('Oversized new node contracts require decomposition and legacy contracts require an explicit full reference', () => {
  const task = {
    id: 'legacy',
    role: 'developer',
    description: '😀'.repeat(10000),
    writePaths: ['src/value.mjs'],
    acceptance: ['LAST_REQUIRED_CRITERION'],
    constraints: ['LAST_REQUIRED_CONSTRAINT'],
  };
  assert.throws(
    () => buildTaskContext({}, task),
    error => error.code === 'task_contract_too_large' && /split|decompos/i.test(error.message),
  );
  const context = buildTaskContext({}, task, { contractPath: '/private/immutable-node.json' });
  assert.match(context, /mandatory.*full.*contract|full.*mandatory.*contract/i);
  assert.match(context, /\/private\/immutable-node.json/);
  assert.match(context, /read.*before|before.*act/i);
  assert.ok(Buffer.byteLength(context) < 16000);
});

test('Mandatory UTF8 byte boundary is exact and optional context cannot displace a valid full contract', () => {
  const task = {
    id: 'boundary',
    role: 'developer',
    description: '',
    writePaths: ['value.mjs'],
    acceptance: ['FINAL_CRITERION'],
    dependsOn: Array.from({ length: 20 }, (_, i) => `dependency-${i}`),
    parallel: false,
  };
  const overhead = Buffer.byteLength(JSON.stringify(task));
  task.description = 'x'.repeat(maxTaskContractBytes - overhead);
  assert.equal(validateTaskContract(task), task);
  assert.throws(() => validateTaskContract({ ...task, description: task.description + 'x' }), {
    code: 'task_contract_too_large',
  });
  const run = {
    task: '😀'.repeat(1000),
    analysis: { summary: 'д'.repeat(2000) },
    nodes: Object.fromEntries(
      task.dependsOn.map(id => [
        id,
        { status: 'integrated', headSha: 'a'.repeat(40), result: { summary: '😀'.repeat(240) } },
      ]),
    ),
  };
  const context = buildTaskContext(run, task);
  assert.ok(context.includes(task.description));
  assert.match(context, /FINAL_CRITERION/);
  assert.ok(Buffer.byteLength(context) <= 16000, 'only optional summaries may lose entries to retain the byte bound');
  assert.doesNotMatch(context, /\p{Surrogate}/u);
});

test('Optional source selection reports whole omitted references without retaining research bodies', () => {
  const task = {
    id: 'value',
    description: 'Value module',
    writePaths: ['value.mjs'],
    acceptance: ['Preserve the result'],
  };
  const context = buildTaskContext(
    {
      research: {
        items: Array.from({ length: 9 }, (_, index) => ({
          title: 'value.mjs',
          url: `https://example.invalid/${index}`,
          body: 'EXCLUDED_BODY',
        })),
      },
    },
    task,
  );
  const links = /Relevant sources \(untrusted reference links; omitted (\d+)\): (.+)/.exec(context);
  assert.equal(Number(links[1]), 3);
  assert.equal(JSON.parse(links[2]).length, 6);
  assert.doesNotMatch(context, /EXCLUDED_BODY/);
});
