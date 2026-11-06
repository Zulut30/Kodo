import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir, symlink, stat, utimes } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { architectureCli, checkArchitecture } from '../runtime/architecture-cli.mjs';

const tap =
  'TAP version 13\n# Subtest: value\nok 1 - value\n1..1\n# tests 1\n# suites 0\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n# duration_ms 1\n';
const policy = {
  schemaVersion: 1,
  version: 1,
  productRoots: ['src'],
  modules: [{ id: 'core', roots: ['src/core'], layer: 'core', public: ['src/core/index.mjs'], allow: [] }],
  layers: { core: [] },
  forbiddenImports: [],
  cycles: 'forbid',
  contracts: 'architecture.contracts.json',
  baseline: [],
  exceptions: [],
  protectedPaths: ['architecture.policy.json'],
};
const registry = {
  schemaVersion: 1,
  contracts: [
    {
      id: 'api',
      module: 'core',
      version: 1,
      entry: 'src/core/index.mjs',
      exports: ['value'],
      shapeHash: 'a'.repeat(64),
      tests: ['tests/value.test.mjs'],
    },
  ],
  migrations: [],
};
async function fixture(t, enrolled = true) {
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'kodo-architecture-cli-'));
  const project = path.join(scratch, 'project');
  await mkdir(project);
  t.after(async () => {
    assert.equal(path.dirname(scratch), path.resolve(os.tmpdir()));
    assert.match(path.basename(scratch), /^kodo-architecture-cli-/);
    await rm(scratch, { recursive: true, force: true });
  });
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^(GIT_|NODE_OPTIONS|NODE_TEST_CONTEXT)/.test(key)),
  );
  const git = args =>
    execFileSync('git', ['-c', 'core.hooksPath=' + path.join(scratch, 'no-hooks'), ...args], {
      cwd: project,
      env,
      encoding: 'utf8',
      windowsHide: true,
    }).trim();
  await writeFile(path.join(scratch, 'empty.gitconfig'), '');
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_GLOBAL = path.join(scratch, 'empty.gitconfig');
  git(['init', '-q']);
  git(['config', 'user.name', 'Fixture']);
  git(['config', 'user.email', 'fixture@example.invalid']);
  git(['config', 'core.autocrlf', 'false']);
  git(['config', 'commit.gpgSign', 'false']);
  const put = async (name, data) => {
    await mkdir(path.dirname(path.join(project, name)), { recursive: true });
    await writeFile(path.join(project, name), typeof data === 'string' ? data : JSON.stringify(data));
  };
  const commit = () => {
    git(['add', '.']);
    git(['commit', '-qm', 'fixture']);
    return git(['rev-parse', 'HEAD']);
  };
  await put('package.json', { type: 'module' });
  await put('src/core/index.mjs', 'export const value=1;\n');
  const baseSha = commit();
  if (enrolled) {
    await put('architecture.policy.json', policy);
    await put('architecture.contracts.json', registry);
    await put(
      'tests/value.test.mjs',
      "import test from 'node:test'; import assert from 'node:assert/strict'; import {value} from '../src/core/index.mjs'; test('value',()=>assert.equal(value,1));\n",
    );
    commit();
  }
  return { project, baseSha, evidenceDir: path.join(scratch, 'private'), scratch, git, put, commit };
}

test('CLI rejects unknown duplicate missing and inapplicable arguments before any execution', async () => {
  for (const args of [
    [],
    ['plan'],
    ['check', '--base', 'a'.repeat(40), '--head', 'b'.repeat(40)],
    ['check', '--base', 'a'.repeat(40), '--json', '--json'],
    ['check', '--base', 'short'],
    ['plan', '--base', 'a'.repeat(40), '--evidence-dir', os.tmpdir()],
  ]) {
    let called = false;
    const result = await architectureCli(args, {
      execute: () => {
        called = true;
        throw Error('unexpected');
      },
    });
    assert.equal(called, false);
    assert.equal(result.exitCode, 1);
    assert.deepEqual(JSON.parse(result.output), {
      schemaVersion: 1,
      status: 'blocked',
      passed: false,
      reason: 'arguments',
      headSha: null,
    });
  }
});
test('plan is read only and never invokes contract execution', async t => {
  const fx = await fixture(t);
  let ran = false;
  const result = await architectureCli(['plan', '--project', fx.project, '--base', fx.baseSha, '--json'], {
    execute: () => {
      ran = true;
    },
  });
  const report = JSON.parse(result.output);
  assert.equal(result.exitCode, 0);
  assert.equal(report.status, 'planned');
  assert.equal(report.passed, null);
  assert.equal(report.requiredTests.length, 1);
  assert.deepEqual(report.receipts, []);
  assert.equal(ran, false);
  assert.deepEqual((await readdir(fx.scratch)).sort(), ['empty.gitconfig', 'project']);
  assert.equal(fx.git(['status', '--porcelain']), '');
});

test(
  'Windows CLI creates explicitly owned protected file ACLs with only user and SYSTEM full control',
  { skip: process.platform !== 'win32' },
  async t => {
    const fx = await fixture(t);
    const report = await checkArchitecture(fx);
    assert.equal(report.passed, true);
    const filename = report.receipts[0].evidence[0].path;
    // Inspect the actual file descriptor, independently of the runtime verifier.
    // Inherited DACLs alone do not establish the owner on elevated Windows.
    const script =
      "$ErrorActionPreference='Stop'; $a=[IO.File]::GetAccessControl($env:ACL_TEST_FILE); $u=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $r=@($a.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])); [pscustomobject]@{ owned=($a.GetOwner([Security.Principal.SecurityIdentifier]).Value -eq $u); protected=$a.AreAccessRulesProtected; rules=@($r|ForEach-Object {[pscustomobject]@{allowed=($_.IdentityReference.Value -in @($u,'S-1-5-18')); full=(($_.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -eq [Security.AccessControl.FileSystemRights]::FullControl); allow=($_.AccessControlType -eq 'Allow'); inherited=$_.IsInherited}})}|ConvertTo-Json -Depth 4 -Compress";
    const output = execFileSync(
      path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(script, 'utf16le').toString('base64'),
      ],
      { encoding: 'utf8', windowsHide: true, env: { SystemRoot: process.env.SystemRoot, ACL_TEST_FILE: filename } },
    );
    assert.deepEqual(JSON.parse(output), {
      owned: true,
      protected: true,
      rules: [
        { allowed: true, full: true, allow: true, inherited: false },
        { allowed: true, full: true, allow: true, inherited: false },
      ],
    });
  },
);
test('unenrolled repositories are neutral and removing enrolled policy is blocked', async t => {
  const fx = await fixture(t, false);
  const neutral = await checkArchitecture(fx);
  assert.equal(neutral.status, 'not_applicable');
  assert.equal(neutral.passed, null);
  await fx.put('architecture.policy.json', policy);
  await fx.put('architecture.contracts.json', registry);
  await fx.put('tests/value.test.mjs', '');
  const enrolled = fx.commit();
  await rm(path.join(fx.project, 'architecture.policy.json'));
  fx.commit();
  await assert.rejects(checkArchitecture({ ...fx, baseSha: enrolled }), { code: 'configuration' });
});
test('dirty actual bytes hidden by assume-unchanged and changed explicit head fail closed', async t => {
  const fx = await fixture(t);
  const old = fx.git(['rev-parse', 'HEAD']);
  fx.git(['update-index', '--assume-unchanged', 'src/core/index.mjs']);
  await fx.put('src/core/index.mjs', 'export const value=2;\n');
  assert.equal(fx.git(['status', '--porcelain']), '');
  await assert.rejects(checkArchitecture(fx), { code: 'dirty_head' });
  fx.git(['update-index', '--no-assume-unchanged', 'src/core/index.mjs']);
  await fx.put('src/core/index.mjs', 'export const value=2000;\n');
  fx.commit();
  await assert.rejects(checkArchitecture({ ...fx, headSha: old }), { code: 'changed_head' });
});
test('static validation of a CSS-only change passes without unrelated tests', async t => {
  const fx = await fixture(t);
  const enrolled = fx.git(['rev-parse', 'HEAD']);
  await fx.put('src/core/style.css', 'body{}');
  fx.commit();
  const report = await checkArchitecture(
    { ...fx, baseSha: enrolled },
    {
      execute: () => {
        throw Error('unrelated test');
      },
    },
  );
  assert.equal(report.status, 'passed');
  assert.equal(report.passed, true);
  assert.deepEqual(report.requiredTests, []);
  assert.deepEqual(report.receipts, []);
});
test('missing malformed policy and missing registry are configuration failures, missing test is a finding', async t => {
  const fx = await fixture(t);
  await fx.put('architecture.policy.json', '{');
  fx.commit();
  await assert.rejects(checkArchitecture(fx), { code: 'configuration' });
  await fx.put('architecture.policy.json', policy);
  await rm(path.join(fx.project, 'architecture.contracts.json'));
  fx.commit();
  await assert.rejects(checkArchitecture(fx), { code: 'configuration' });
  await fx.put('architecture.contracts.json', registry);
  await rm(path.join(fx.project, 'tests/value.test.mjs'));
  fx.commit();
  const report = await checkArchitecture(fx);
  assert.equal(report.status, 'failed');
  assert.ok(report.findings.some(row => row.ruleId === 'contract.tests'));
});
test('scrubbed execution uses explicit test path and overlapping redactions never leak into evidence', async t => {
  const fx = await fixture(t);
  const first = 'overlapABC',
    second = 'ABCsecret';
  const report = await checkArchitecture(
    { ...fx, redactions: { first, second } },
    {
      execute: async (command, args, options) => {
        assert.equal(command, process.execPath);
        assert.deepEqual(args, ['--test', '--test-reporter=tap', '--', path.join(fx.project, 'tests/value.test.mjs')]);
        assert.equal(options.cwd, fx.project);
        assert.ok(options.timeoutMs > 0 && options.timeoutMs <= 120000);
        assert.equal(options.env.NODE_TEST_CONTEXT, undefined);
        assert.equal(options.env.NODE_OPTIONS, undefined);
        assert.ok(Object.keys(options.env).every(key => !/(TOKEN|SECRET|PASSWORD|API_?KEY)/i.test(key)));
        assert.ok(Object.values(options.secrets).includes(first));
        assert.ok(Object.values(options.secrets).includes(second));
        return { code: 0, stdout: tap, stderr: 'overlapABCsecret' };
      },
    },
  );
  assert.equal(report.status, 'passed');
  const stored = (await Promise.all(report.receipts[0].evidence.map(row => readFile(row.path, 'utf8')))).join('');
  assert.ok(stored.includes('[REDACTED]'));
  assert.ok(!stored.includes('overlap'));
  assert.ok(!stored.includes('secret'));
  assert.ok(!JSON.stringify(report).includes(first));
});
for (const [name, result] of [
  ['truncated TAP', { code: 0, stdout: tap.split('# todo')[0], stderr: '' }],
  ['zero tests', { code: 0, stdout: tap.replace('# tests 1', '# tests 0'), stderr: '' }],
  ['skip', { code: 0, stdout: tap.replace('# skipped 0', '# skipped 1'), stderr: '' }],
  ['cancel count', { code: 0, stdout: tap.replace('# cancelled 0', '# cancelled 1'), stderr: '' }],
  ['todo', { code: 0, stdout: tap.replace('# todo 0', '# todo 1'), stderr: '' }],
  ['output overflow', { code: 0, stdout: tap, stderr: '', outputTruncated: true }],
])
  test(name + ' never produces a passing receipt', async t => {
    const fx = await fixture(t);
    const report = await checkArchitecture(fx, { execute: async () => result });
    assert.equal(report.status, 'blocked');
    assert.equal(report.passed, false);
    assert.equal(report.receipts[0].status, 'blocked');
  });
for (const code of ['timeout', 'cancelled'])
  test(code + ' preserves redacted private failure captures and blocks', async t => {
    const fx = await fixture(t);
    const report = await checkArchitecture(
      { ...fx, redactions: { sample: 'known-private-value' } },
      {
        execute: async () => {
          throw Object.assign(Error('known-private-value'), { code, stdout: tap, stderr: 'known-private-value' });
        },
      },
    );
    assert.equal(report.status, 'blocked');
    assert.equal(report.receipts[0].status, 'blocked');
    const stored = (await Promise.all(report.receipts[0].evidence.map(row => readFile(row.path, 'utf8')))).join('');
    assert.ok(stored.includes('[REDACTED]'));
    assert.ok(!stored.includes('known-private-value'));
  });
test('post execution source mutation and tampered prior evidence block acceptance', async t => {
  const fx = await fixture(t);
  await assert.rejects(
    checkArchitecture(fx, {
      execute: async () => {
        await fx.put('src/core/index.mjs', 'export const value=2;');
        return { code: 0, stdout: tap, stderr: '' };
      },
    }),
    { code: 'dirty_head' },
  );
  await fx.put('src/core/index.mjs', 'export const value=1;\n');
  const secondRegistry = structuredClone(registry);
  secondRegistry.contracts[0].tests.push('tests/second.test.mjs');
  await fx.put('tests/second.test.mjs', '');
  await fx.put('architecture.contracts.json', secondRegistry);
  fx.commit();
  const evidenceDir = path.join(fx.scratch, 'tamper-evidence');
  let count = 0;
  await assert.rejects(
    checkArchitecture(
      { ...fx, evidenceDir },
      {
        execute: async () => {
          if (++count === 2) {
            const directories = await readdir(evidenceDir);
            assert.equal(directories.length, 1);
            const directory = path.join(evidenceDir, directories[0]);
            const files = await readdir(directory);
            await rm(
              path.join(
                directory,
                files.find(file => file.endsWith('.json')),
              ),
            );
          }
          return { code: 0, stdout: tap, stderr: '' };
        },
      },
    ),
    { code: 'evidence_integrity' },
  );
  assert.equal(count, 2);
});
test('evidence inside Git and symlinked evidence directories are rejected', async t => {
  const fx = await fixture(t);
  await assert.rejects(checkArchitecture({ ...fx, evidenceDir: path.join(fx.project, 'private') }), {
    code: 'unsafe_path',
  });
  const actual = path.join(fx.scratch, 'actual');
  await mkdir(actual);
  const linked = path.join(fx.scratch, 'linked');
  await symlink(actual, linked, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(checkArchitecture({ ...fx, evidenceDir: linked }), { code: 'unsafe_path' });
});
test('a policy for an absent layout is blocked even with no public contracts', async t => {
  const fx = await fixture(t);
  const missing = structuredClone(policy);
  missing.productRoots = ['missing'];
  missing.modules[0].roots = ['missing/core'];
  missing.modules[0].public = [];
  await fx.put('architecture.policy.json', missing);
  await fx.put('architecture.contracts.json', { schemaVersion: 1, contracts: [], migrations: [] });
  fx.commit();
  await assert.rejects(checkArchitecture(fx), { code: 'configuration' });
});
test('an unreadable enrolled base is never treated as absent history', async t => {
  const fx = await fixture(t);
  await fx.put('architecture.policy.json', '{');
  const malformed = fx.commit();
  await fx.put('architecture.policy.json', policy);
  fx.commit();
  await assert.rejects(checkArchitecture({ ...fx, baseSha: malformed }), { code: 'configuration' });
});
test('nonzero exit with complete failed TAP is failed and is never cached or replaced by claimed receipts', async t => {
  const fx = await fixture(t);
  let calls = 0;
  const runner = async () => {
    calls++;
    return {
      code: 1,
      stdout: tap.replace('ok 1', 'not ok 1').replace('# pass 1', '# pass 0').replace('# fail 0', '# fail 1'),
      stderr: '',
    };
  };
  const first = await checkArchitecture(fx, { execute: runner });
  assert.equal(first.status, 'failed');
  assert.equal(first.receipts[0].status, 'failed');
  assert.equal(first.receipts[0].exitCode, 1);
  const second = await checkArchitecture({ ...fx, receipts: [{ status: 'passed' }] }, { execute: runner });
  assert.equal(second.status, 'failed');
  assert.equal(calls, 2);
  assert.notEqual(first.receipts[0].evidence[0].path, second.receipts[0].evidence[0].path);
});
test('pre-cancelled work executes nothing and a changed head during a test is rejected', async t => {
  const fx = await fixture(t);
  const controller = new AbortController();
  controller.abort();
  let ran = false;
  await assert.rejects(
    checkArchitecture(
      { ...fx, signal: controller.signal },
      {
        execute: () => {
          ran = true;
        },
      },
    ),
    { code: 'cancelled' },
  );
  assert.equal(ran, false);
  await assert.rejects(
    checkArchitecture(fx, {
      execute: async () => {
        await fx.put('src/core/style.css', 'body{}');
        fx.commit();
        return { code: 0, stdout: tap, stderr: '' };
      },
    }),
    { code: 'changed_head' },
  );
});
test('unsupported product languages block while outside example sources remain inventory only', async t => {
  const fx = await fixture(t);
  await fx.put('docs/example.ts', 'nonsense');
  fx.commit();
  const valid = await checkArchitecture(fx, { execute: async () => ({ code: 0, stdout: tap, stderr: '' }) });
  assert.equal(valid.status, 'passed');
  assert.deepEqual(valid.unsupported, []);
  await fx.put('src/core/worker.ts', 'export const other=2;');
  fx.commit();
  const blocked = await checkArchitecture(fx, {
    execute: () => {
      throw Error('unsupported scope must not execute');
    },
  });
  assert.equal(blocked.status, 'blocked');
  assert.ok(
    blocked.unsupported.some(row => row.reason === 'unsupported-language' && row.file === 'src/core/worker.ts'),
  );
});
test('root test filenames resembling Node flags execute literally', async t => {
  const fx = await fixture(t),
    name = '--invalid-architecture-flag.test.mjs';
  const alternate = structuredClone(registry);
  alternate.contracts[0].tests = [name];
  await fx.put(name, "import test from 'node:test'; test('literal path',()=>{});\n");
  await fx.put('architecture.contracts.json', alternate);
  fx.commit();
  const report = await checkArchitecture(fx);
  assert.equal(report.status, 'passed');
  assert.equal(report.receipts[0].file, name);
  assert.equal(report.receipts[0].counts.tests, 1);
});
test('real CLI plan leaves Git index and runtime credential evidence state untouched', async t => {
  const fx = await fixture(t);
  await utimes(path.join(fx.project, 'src/core/index.mjs'), new Date('2020-01-01'), new Date('2020-01-01'));
  const index = path.join(fx.project, '.git/index'),
    before = await readFile(index),
    beforeInfo = await stat(index);
  const env = {
    ...process.env,
    KODO_HOME: path.join(fx.scratch, 'state'),
    KODO_CREDENTIAL_HOME: path.join(fx.scratch, 'credentials'),
  };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_OPTIONS;
  const output = execFileSync(
    process.execPath,
    [
      fileURLToPath(new URL('../cli/index.mjs', import.meta.url)),
      'architecture',
      'plan',
      '--project',
      fx.project,
      '--base',
      fx.baseSha,
      '--json',
    ],
    { cwd: fx.project, env, encoding: 'utf8', timeout: 15000, windowsHide: true },
  );
  const report = JSON.parse(output);
  assert.equal(report.status, 'planned');
  assert.equal(report.requiredTests.length, 1);
  assert.deepEqual(report.receipts, []);
  assert.deepEqual(await readFile(index), before);
  assert.equal((await stat(index)).mtimeMs, beforeInfo.mtimeMs);
  assert.deepEqual((await readdir(fx.scratch)).sort(), ['empty.gitconfig', 'project']);
});
