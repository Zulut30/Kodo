/** Offline Architecture Guardian composition. No Engine, credentials or session startup. */
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { lstat, realpath, mkdir, mkdtemp, writeFile, readFile, chmod } from 'node:fs/promises';
import { readArchitectureGraph } from './architecture-graph.mjs';
import { validateArchitecturePolicy, evaluateArchitecture } from './architecture-policy.mjs';
import { ContractRegistry } from './contract-registry.mjs';
import { applyArchitectureDebt, evaluateArchitectureProtection } from './architecture-debt.mjs';
import { inspectCurrentSource } from './ci-graph.mjs';
import { execute as command } from './command.mjs';
import { execute } from './delivery.mjs';
import { workerEnvironment, redact } from './security.mjs';
import { inside, noLinks, relativeFile } from './toolchains.mjs';
import { assertPrivateArtifactPath } from './progress.mjs';

const POLICY = 'architecture.policy.json';
const MAX_OUTPUT = 20 * 1024 ** 2;
const reasons = new Set([
  'arguments',
  'configuration',
  'unsafe_path',
  'dirty_head',
  'changed_head',
  'scope_limit',
  'cancelled',
  'timeout',
  'evidence_integrity',
]);
const sha = value => typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
const fail = code => Object.assign(new Error('Architecture check blocked'), { code });
const digest = value => createHash('sha256').update(value).digest('hex');
function canonical(value) {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  )
    return value;
  if (Array.isArray(value)) return value.map(canonical);
  if (value && Object.getPrototypeOf(value) === Object.prototype)
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map(key => [key, canonical(value[key])]),
    );
  throw fail('configuration');
}
const hash = value => digest(JSON.stringify(canonical(value)));
const runtime = () => ({
  node: process.versions.node,
  abi: process.versions.modules,
  platform: process.platform,
  arch: process.arch,
});
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
function safeFile(file) {
  try {
    if (file !== file.normalize('NFC')) throw fail('unsafe_path');
    return relativeFile(file);
  } catch {
    throw fail('unsafe_path');
  }
}

// Collect original match ranges first, including crossings/prefixes; sequential
// replacements can otherwise reveal part of another known removed value.
function cleanCapture(text, secrets) {
  const pending = [...new Set(Object.values(secrets))]
    .filter(value => typeof value === 'string' && value.length > 0)
    .map(value => ({ value, index: text.indexOf(value) }))
    .filter(row => row.index >= 0);
  const parts = [];
  let cursor = 0,
    start = -1,
    end = 0;
  const flush = () => {
    if (start >= 0) {
      parts.push(text.slice(cursor, start), '[REDACTED]');
      cursor = end;
    }
  };
  while (pending.length) {
    let first = 0;
    for (let index = 1; index < pending.length; index++) if (pending[index].index < pending[first].index) first = index;
    const row = pending[first];
    if (start < 0 || row.index > end) {
      flush();
      start = row.index;
      end = row.index + row.value.length;
    } else end = Math.max(end, row.index + row.value.length);
    row.index = text.indexOf(row.value, row.index + 1);
    if (row.index < 0) pending.splice(first, 1);
  }
  flush();
  return redact(parts.join('') + text.slice(cursor));
}
function childContext(redactions) {
  if (
    !redactions ||
    typeof redactions !== 'object' ||
    Array.isArray(redactions) ||
    Object.values(redactions).some(value => typeof value !== 'string')
  )
    throw fail('configuration');
  const env = Object.fromEntries(
    Object.entries(workerEnvironment()).filter(
      ([key]) => !/^(?:NODE_OPTIONS|NODE_PATH|NODE_TEST_CONTEXT|NODE_V8_COVERAGE|GIT_.*)$/i.test(key),
    ),
  );
  const values = [
    ...Object.values(redactions),
    ...Object.entries(process.env)
      .filter(([key]) => !(key in env))
      .map(([, value]) => value),
  ];
  return {
    env,
    secrets: Object.fromEntries([...new Set(values.filter(Boolean))].map((value, index) => ['removed' + index, value])),
  };
}

async function canonicalProject(project) {
  if (typeof project !== 'string' || !project) throw fail('arguments');
  try {
    const requested = path.resolve(project);
    await noLinks(requested);
    return await realpath(requested);
  } catch {
    throw fail('unsafe_path');
  }
}
async function git(project, args, context) {
  context.checkpoint();
  try {
    return (
      await command('git', args, {
        cwd: project,
        signal: context.signal,
        timeoutMs: Math.min(30000, context.remaining()),
        rawOutput: true,
        env: { ...context.env, GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1' },
      })
    ).stdout;
  } catch (error) {
    throw fail(reasons.has(error.code) ? error.code : 'configuration');
  }
}
async function fence(project, headSha, context) {
  if ((await git(project, ['rev-parse', '--verify', 'HEAD'], context)).trim() !== headSha) throw fail('changed_head');
  let state;
  if (context.readOnly) {
    // The shared inspector's Git status may refresh the index. Isolate its
    // environment rather than mutating process.env across concurrent callers.
    const script = `import { inspectCurrentSource } from ${JSON.stringify(new URL('./ci-graph.mjs', import.meta.url).href)}; let input=''; for await (const chunk of process.stdin) input+=chunk; process.stdout.write(await inspectCurrentSource(JSON.parse(input)));`;
    state = (
      await command(process.execPath, ['--input-type=module', '--eval', script], {
        cwd: project,
        input: JSON.stringify({ project, headSha }),
        env: { ...context.env, GIT_OPTIONAL_LOCKS: '0' },
        signal: context.signal,
        timeoutMs: context.remaining(),
        secrets: context.secrets,
        rawOutput: true,
      })
    ).stdout;
  } else state = await inspectCurrentSource({ project, headSha });
  if (state !== 'clean') throw fail('dirty_head');
  context.checkpoint();
}
async function inventory(project, revision, context) {
  if ((await git(project, ['rev-parse', '--verify', `${revision}^{commit}`], context)).trim() !== revision)
    throw fail('configuration');
  const rows = (await git(project, ['ls-tree', '-rz', '--full-tree', revision], context)).split('\0').filter(Boolean);
  if (rows.length > 20000) throw fail('scope_limit');
  return rows.map(row => {
    const match = /^(\d{6}) (blob|commit) ([a-f0-9]+)\t([\s\S]+)$/.exec(row);
    if (!match || match[3].length !== revision.length) throw fail('configuration');
    return { mode: match[1], type: match[2], oid: match[3], path: safeFile(match[4]) };
  });
}
// Absent means no tree entry, never a failed Git read or JSON parse. Verify the
// blob identity too: decoding errors cannot silently change a document's bytes.
async function document(project, files, name, context, optional = false) {
  safeFile(name);
  const entry = files.find(row => row.path === name);
  if (!entry) {
    if (optional) return null;
    throw fail('configuration');
  }
  if (entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode)) throw fail('unsafe_path');
  const size = Number((await git(project, ['cat-file', '-s', entry.oid], context)).trim());
  if (!Number.isSafeInteger(size) || size < 1 || size > 4 * 1024 ** 2) throw fail('scope_limit');
  const text = await git(project, ['cat-file', 'blob', entry.oid], context),
    bytes = Buffer.from(text);
  const oid = createHash(entry.oid.length === 40 ? 'sha1' : 'sha256')
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest('hex');
  if (bytes.length !== size || oid !== entry.oid) throw fail('configuration');
  try {
    const value = JSON.parse(text);
    if (value === null) throw fail('configuration');
    return value;
  } catch {
    throw fail('configuration');
  }
}
// C validates the original strict records before this normalization. Preserve
// append-only migration order; only declared sets and contract IDs are sorted.
function normalizedRegistry(value) {
  return {
    schemaVersion: 1,
    contracts: value.contracts
      .map(row => ({ ...row, tests: [...row.tests].sort(), exports: [...row.exports] }))
      .sort((a, b) => compare(a.id, b.id)),
    migrations: value.migrations.map(row => ({
      ...row,
      consumers: [...row.consumers].sort(),
      tests: row.tests
        .map(mapping => ({ module: mapping.module, files: [...mapping.files].sort() }))
        .sort((a, b) => compare(a.module, b.module)),
    })),
  };
}
function validateLayout(files, policy) {
  for (const root of [...policy.productRoots, ...policy.modules.flatMap(module => module.roots)]) {
    if (
      !files.some(
        row => row.path.startsWith(root + '/') && row.type === 'blob' && ['100644', '100755'].includes(row.mode),
      )
    )
      throw fail('configuration');
  }
}

async function evidenceLocation(target, project) {
  if (typeof target !== 'string' || !path.isAbsolute(target)) throw fail('unsafe_path');
  try {
    const requested = path.resolve(target);
    await noLinks(requested);
    assertPrivateArtifactPath(requested);
    let ancestor = requested;
    const missing = [];
    for (;;) {
      try {
        ancestor = path.join(await realpath(ancestor), ...missing);
        break;
      } catch (error) {
        if (error.code !== 'ENOENT' || ancestor === path.dirname(ancestor)) throw error;
        missing.unshift(path.basename(ancestor));
        ancestor = path.dirname(ancestor);
      }
    }
    if (
      inside(project, ancestor) ||
      inside(ancestor, project) ||
      ancestor === path.parse(ancestor).root ||
      ancestor === (await realpath(os.homedir()))
    )
      throw fail('unsafe_path');
    await noLinks(ancestor);
    assertPrivateArtifactPath(ancestor);
    return ancestor;
  } catch {
    throw fail('unsafe_path');
  }
}
async function privateDirectory(target, project, context) {
  const parent = await evidenceLocation(target, project);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  await noLinks(parent);
  assertPrivateArtifactPath(parent);
  const directory = await mkdtemp(path.join(parent, 'architecture-'));
  if (process.platform === 'win32') {
    const script =
      "$ErrorActionPreference='Stop'; $user=[Security.Principal.WindowsIdentity]::GetCurrent().User; $acl=[Security.AccessControl.DirectorySecurity]::new(); $acl.SetOwner($user); $acl.SetAccessRuleProtection($true,$false); foreach($sid in @($user,[Security.Principal.SecurityIdentifier]::new('S-1-5-18'))) { $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')) }; [IO.Directory]::SetAccessControl($env:ARCHITECTURE_EVIDENCE_DIRECTORY,$acl)";
    await execute(
      path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(script, 'utf16le').toString('base64'),
      ],
      {
        env: { ...context.env, ARCHITECTURE_EVIDENCE_DIRECTORY: directory },
        signal: context.signal,
        timeoutMs: Math.min(20000, context.remaining()),
        secrets: context.secrets,
      },
    );
  }
  return directory;
}
async function capture(directory, index, result, error, context) {
  const { secrets } = context;
  const record = {
    stdout: cleanCapture(typeof result?.stdout === 'string' ? result.stdout : '', secrets),
    stderr: cleanCapture(typeof result?.stderr === 'string' ? result.stderr : '', secrets),
    error: error
      ? {
          code: reasons.has(error.code) ? error.code : 'configuration',
          message: cleanCapture(String(error.message ?? ''), secrets),
          stack: cleanCapture(String(error.stack ?? ''), secrets),
        }
      : null,
  };
  const bytes = Buffer.from(JSON.stringify(record) + '\n');
  if (bytes.length > MAX_OUTPUT * 2) throw fail('scope_limit');
  const filename = path.join(directory, `test-${index}.json`);
  try {
    await noLinks(filename);
    assertPrivateArtifactPath(filename);
    await writeFile(filename, bytes, { flag: 'wx', mode: 0o600 });
    if (process.platform === 'win32') {
      // DACL inheritance does not determine the owner of new files on elevated
      // Windows. Assign both only here, at coordinator-owned creation.
      const script =
        "$ErrorActionPreference='Stop'; [Console]::InputEncoding=[Text.UTF8Encoding]::new($false); $p=[Console]::In.ReadToEnd()|ConvertFrom-Json; $user=[Security.Principal.WindowsIdentity]::GetCurrent().User; $acl=[Security.AccessControl.FileSecurity]::new(); $acl.SetOwner($user); $acl.SetAccessRuleProtection($true,$false); foreach($sid in @($user,[Security.Principal.SecurityIdentifier]::new('S-1-5-18'))) { $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','Allow')) }; [IO.File]::SetAccessControl($p[0],$acl)";
      await command(
        path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
        [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-EncodedCommand',
          Buffer.from(script, 'utf16le').toString('base64'),
        ],
        {
          input: JSON.stringify([filename]),
          env: context.env,
          signal: context.signal,
          timeoutMs: Math.min(20000, context.remaining()),
          secrets,
        },
      );
    } else await chmod(filename, 0o400);
  } catch {
    throw fail('evidence_integrity');
  }
  return { path: filename, bytes: bytes.length, sha256: digest(bytes) };
}
async function verifyEvidence(receipts, directory) {
  for (const receipt of receipts)
    for (const entry of receipt.evidence) {
      try {
        if (!inside(directory, entry.path) || entry.path === directory) throw fail('evidence_integrity');
        await noLinks(entry.path);
        assertPrivateArtifactPath(entry.path);
        const info = await lstat(entry.path);
        if (!info.isFile() || info.nlink !== 1 || info.size !== entry.bytes || info.size > MAX_OUTPUT * 2)
          throw fail('evidence_integrity');
        if (process.platform !== 'win32' && info.mode & 0o077) throw fail('evidence_integrity');
        if (digest(await readFile(entry.path)) !== entry.sha256) throw fail('evidence_integrity');
      } catch {
        throw fail('evidence_integrity');
      }
    }
}
async function verifyPrivacy(directory, receipts, context) {
  try {
    await noLinks(directory);
    assertPrivateArtifactPath(directory);
    const info = await lstat(directory);
    if (!info.isDirectory()) throw fail('evidence_integrity');
    if (process.platform !== 'win32') {
      if (info.mode & 0o077) throw fail('evidence_integrity');
      return;
    }
    // Verify the owned directory and every receipt file after the untrusted
    // test. No ACL repairs at acceptance time: changed privacy blocks evidence.
    const script =
      "$ErrorActionPreference='Stop'; [Console]::InputEncoding=[Text.UTF8Encoding]::new($false); $paths=[Console]::In.ReadToEnd()|ConvertFrom-Json; $user=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; foreach($p in $paths) { $directory=[IO.Directory]::Exists($p); $acl=if($directory){[IO.Directory]::GetAccessControl($p)}else{[IO.File]::GetAccessControl($p)}; if($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $user) {exit 1}; if($directory -and -not $acl.AreAccessRulesProtected) {exit 1}; $rules=$acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]); foreach($r in $rules) { if($r.IdentityReference.Value -notin @($user,'S-1-5-18') -or $r.AccessControlType -ne 'Allow') {exit 1} }; foreach($id in @($user,'S-1-5-18')) { $full=$false; foreach($r in $rules) { if($r.IdentityReference.Value -eq $id -and ($r.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -eq [Security.AccessControl.FileSystemRights]::FullControl) {$full=$true} }; if(-not $full) {exit 1} } }";
    await command(
      path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(script, 'utf16le').toString('base64'),
      ],
      {
        env: context.env,
        signal: context.signal,
        timeoutMs: Math.min(20000, context.remaining()),
        input: JSON.stringify([directory, ...receipts.flatMap(row => row.evidence.map(entry => entry.path))]),
        secrets: context.secrets,
      },
    );
  } catch {
    throw fail('evidence_integrity');
  }
}
function tapCounts(stdout) {
  if (typeof stdout !== 'string' || !/^TAP version 13\r?\n/.test(stdout) || /^Bail out!/m.test(stdout)) return null;
  const counts = {};
  for (const key of ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo']) {
    const matches = [...stdout.matchAll(new RegExp('^# ' + key + ' (\\d+)\\r?$', 'gm'))];
    if (matches.length !== 1 || !Number.isSafeInteger(Number(matches[0][1]))) return null;
    counts[key] = Number(matches[0][1]);
  }
  const plans = [...stdout.matchAll(/^1\.\.(\d+)\r?$/gm)];
  const results = [...stdout.matchAll(/^(?:not )?ok (\d+)(?:\s|$)/gm)];
  const footer =
    /^1\.\.\d+\r?\n# tests \d+\r?\n# suites \d+\r?\n# pass \d+\r?\n# fail \d+\r?\n# cancelled \d+\r?\n# skipped \d+\r?\n# todo \d+\r?\n# duration_ms (\d+(?:\.\d+)?)\r?\n?$/m.exec(
      stdout,
    );
  if (
    plans.length !== 1 ||
    Number(plans[0][1]) < 1 ||
    results.length !== Number(plans[0][1]) ||
    results.some((row, index) => Number(row[1]) !== index + 1) ||
    !footer ||
    footer.index + footer[0].length !== stdout.length ||
    !Number.isFinite(Number(footer[1])) ||
    counts.tests < 1 ||
    counts.pass + counts.fail + counts.cancelled + counts.skipped + counts.todo !== counts.tests
  )
    return null;
  return counts;
}

async function compose(options, ports, plan) {
  if (!options || !sha(options.baseSha) || (options.headSha !== undefined && !sha(options.headSha)))
    throw fail('arguments');
  const began = performance.now(),
    { env, secrets } = childContext(options.redactions ?? {});
  const context = {
    env,
    secrets,
    signal: options.signal,
    readOnly: plan,
    remaining: () => Math.max(0, Math.floor(120000 - (performance.now() - began))),
    checkpoint: () => {
      if (options.signal?.aborted) throw fail('cancelled');
      if (performance.now() - began >= 120000) throw fail('timeout');
    },
  };
  context.checkpoint();
  const project = await canonicalProject(options.project ?? process.cwd());
  const root = path.resolve((await git(project, ['rev-parse', '--show-toplevel'], context)).trim());
  await noLinks(root);
  if ((await realpath(root)) !== project) throw fail('unsafe_path');
  const headSha = options.headSha ?? (await git(project, ['rev-parse', '--verify', 'HEAD'], context)).trim();
  if (!sha(headSha)) throw fail('configuration');
  await fence(project, headSha, context);
  const baseFiles = await inventory(project, options.baseSha, context),
    headFiles = await inventory(project, headSha, context);
  const rawBase = await document(project, baseFiles, POLICY, context, true),
    rawHead = await document(project, headFiles, POLICY, context, true);
  const basePolicy = rawBase === null ? null : validateArchitecturePolicy(rawBase),
    headPolicy = rawHead === null ? null : validateArchitecturePolicy(rawHead);
  const changedPaths = [
    ...new Set(
      (
        await git(
          project,
          [
            'diff',
            '--no-ext-diff',
            '--no-textconv',
            '--no-renames',
            '--name-only',
            '-z',
            options.baseSha,
            headSha,
            '--',
          ],
          context,
        )
      )
        .split('\0')
        .filter(Boolean),
    ),
  ]
    .sort()
    .map(safeFile);
  if (changedPaths.length > 20000) throw fail('scope_limit');
  const protection = evaluateArchitectureProtection({ basePolicy, headPolicy, changedPaths });
  if (basePolicy && !headPolicy) throw fail('configuration');
  let report = {
    schemaVersion: 1,
    status: 'not_applicable',
    passed: null,
    headSha,
    basePolicyState: basePolicy ? 'present' : 'absent',
    baseRulesEvaluated: false,
    hashes: {
      source: hash(headFiles.map(({ path, mode, oid }) => ({ path, mode, oid }))),
      policy: hash(null),
      registry: hash(null),
    },
    findings: [],
    unsupported: [],
    debt: { schemaVersion: 1, activeFindings: [], debt: [], invalidEntries: [] },
    requiredTests: [],
    receipts: [],
    requiresReview: protection.requiresReview,
    fullVerificationRequired: protection.fullVerificationRequired,
  };
  if (!headPolicy) {
    await fence(project, headSha, context);
    return report;
  }
  validateLayout(headFiles, headPolicy);
  if (basePolicy) validateLayout(baseFiles, basePolicy);
  const baseRegistry = basePolicy ? await document(project, baseFiles, basePolicy.contracts, context) : null;
  const headRegistry = await document(project, headFiles, headPolicy.contracts, context);
  const baseGraph = await readArchitectureGraph({
    project,
    headSha: options.baseSha,
    policy: basePolicy ?? headPolicy,
  });
  const headGraph = await readArchitectureGraph({ project, headSha, policy: headPolicy });
  context.checkpoint();
  const baseFindings = basePolicy ? evaluateArchitecture({ policy: basePolicy, graph: baseGraph }).findings : [];
  const headFindings = evaluateArchitecture({ policy: headPolicy, graph: headGraph }).findings;
  const contracts = new ContractRegistry().plan({
    base: baseRegistry,
    head: headRegistry,
    baseGraph,
    headGraph,
    changedPaths,
  });
  const now = ports.now ?? (() => new Date().toISOString());
  const debtAt = () =>
    applyArchitectureDebt({
      findings: headFindings,
      baseFindings,
      baseline: headPolicy.baseline,
      exceptions: headPolicy.exceptions,
      changedPaths,
      now: now(),
    });
  const unsupported = new Map();
  for (const [graph, registry] of [
    [baseGraph, baseRegistry],
    [headGraph, headRegistry],
  ])
    for (const row of graph.unsupported) {
      if (
        row.scope !== 'exports' ||
        graph.nodes.some(node => node.path === row.file && node.public) ||
        registry?.contracts.some(contract => contract.entry === row.file)
      )
        unsupported.set(row.id, row);
    }
  report = {
    ...report,
    hashes: {
      source: headGraph.sourceHash,
      policy: hash(headPolicy),
      registry: hash(normalizedRegistry(headRegistry)),
    },
    baseRulesEvaluated: basePolicy !== null,
    unsupported: [...unsupported.values()].sort((a, b) => compare(a.id, b.id)),
    requiredTests: contracts.requiredTests,
  };
  const update = () => {
    report.debt = debtAt();
    report.findings = [
      ...new Map([...report.debt.activeFindings, ...contracts.findings].map(row => [row.id, row])).values(),
    ].sort((a, b) => compare(a.id, b.id));
    report.status =
      report.unsupported.length ||
      report.debt.invalidEntries.length ||
      report.receipts.some(row => row.status === 'blocked')
        ? 'blocked'
        : report.findings.length || report.receipts.some(row => row.status === 'failed')
          ? 'failed'
          : plan
            ? 'planned'
            : 'passed';
    report.passed = report.status === 'planned' ? null : report.status === 'passed';
  };
  update();
  await fence(project, headSha, context);
  const evidenceTarget = options.evidenceDir ?? path.join(os.tmpdir(), 'kodo-architecture-evidence');
  if (!plan && options.evidenceDir !== undefined) await evidenceLocation(evidenceTarget, project);
  let directory;
  if (!plan && report.status === 'passed' && report.requiredTests.length) {
    directory = await privateDirectory(evidenceTarget, project, context);
    const fingerprint = runtime();
    for (const { file } of report.requiredTests) {
      context.checkpoint();
      await verifyEvidence(report.receipts, directory);
      await fence(project, headSha, context);
      safeFile(file);
      if (
        !/\.test\.(?:mjs|js)$/.test(file) ||
        !headFiles.some(row => row.path === file && ['100644', '100755'].includes(row.mode))
      )
        throw fail('configuration');
      const start = performance.now();
      let observation, error;
      try {
        // Node's test subprocess can reinterpret a leading '-' basename even
        // after the parent's '--'. The absolute filename also fences that hop.
        observation = await (ports.execute ?? execute)(
          process.execPath,
          ['--test', '--test-reporter=tap', '--', path.join(project, file)],
          {
            cwd: project,
            signal: context.signal,
            timeoutMs: context.remaining(),
            env,
            secrets,
            allowFailure: true,
            maxOutputBytes: MAX_OUTPUT,
          },
        );
      } catch (cause) {
        error = cause;
        observation = cause.result ?? cause;
      }
      const evidence = [await capture(directory, report.receipts.length, observation, error, context)];
      const counts = tapCounts(observation?.stdout),
        exitCode = Number.isInteger(observation?.code) && observation.code >= 0 ? observation.code : null;
      const incomplete =
        error ||
        !counts ||
        typeof observation?.stderr !== 'string' ||
        observation?.outputTruncated ||
        exitCode === null ||
        observation?.signal ||
        Buffer.byteLength(observation?.stdout ?? '') + Buffer.byteLength(observation?.stderr ?? '') > MAX_OUTPUT;
      const status =
        incomplete || (counts && (counts.cancelled || counts.skipped || counts.todo))
          ? 'blocked'
          : exitCode !== 0 || counts.fail
            ? 'failed'
            : 'passed';
      report.receipts.push({
        id: hash([headSha, file, report.hashes.source, report.hashes.policy, report.hashes.registry, fingerprint]),
        file,
        status,
        exitCode,
        durationMs: performance.now() - start,
        headSha,
        sourceHash: report.hashes.source,
        policyHash: report.hashes.policy,
        registryHash: report.hashes.registry,
        runtime: fingerprint,
        counts,
        evidence,
      });
      await verifyEvidence(report.receipts, directory);
      await fence(project, headSha, context);
      if (hash(runtime()) !== hash(fingerprint)) throw fail('changed_head');
      if (status === 'blocked') break;
    }
  }
  if (directory) {
    await verifyEvidence(report.receipts, directory);
    await verifyPrivacy(directory, report.receipts, context);
  }
  await fence(project, headSha, context);
  update();
  return report;
}

/** Fresh local observation only: no imported receipts or cached claims accepted. */
export async function checkArchitecture(options, ports = {}) {
  return compose(options, ports, false);
}

function parse(argv) {
  const [action, ...args] = argv;
  if (!['plan', 'check'].includes(action)) throw fail('arguments');
  const options = { project: process.cwd() },
    seen = new Set();
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (
      !['--project', '--base', '--json', ...(action === 'check' ? ['--evidence-dir'] : [])].includes(flag) ||
      seen.has(flag)
    )
      throw fail('arguments');
    seen.add(flag);
    if (flag === '--json') continue;
    const value = args[++index];
    if (!value || value.startsWith('-')) throw fail('arguments');
    if (flag === '--project') options.project = value;
    if (flag === '--base') options.baseSha = value;
    if (flag === '--evidence-dir') {
      if (!path.isAbsolute(value)) throw fail('arguments');
      options.evidenceDir = value;
    }
  }
  if (!sha(options.baseSha)) throw fail('arguments');
  return { action, options };
}
export async function architectureCli(argv, ports = {}) {
  try {
    const { action, options } = parse(argv);
    const report = await compose(
      { ...options, signal: ports.signal, redactions: ports.redactions },
      ports,
      action === 'plan',
    );
    return { report, output: JSON.stringify(report), exitCode: ['failed', 'blocked'].includes(report.status) ? 1 : 0 };
  } catch (error) {
    const report = {
      schemaVersion: 1,
      status: 'blocked',
      passed: false,
      reason: reasons.has(error.code) ? error.code : 'configuration',
      headSha: null,
    };
    return { report, output: JSON.stringify(report), exitCode: 1 };
  }
}
