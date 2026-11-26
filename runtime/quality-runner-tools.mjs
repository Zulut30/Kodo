import path from 'node:path';
import os from 'node:os';
import { access, lstat, mkdir, mkdtemp, readFile, realpath } from 'node:fs/promises';
import { inside, noLinks, sha256 } from './toolchains.mjs';
import { workerEnvironment } from './security.mjs';
import { qualityError, qualityPath } from './quality.mjs';

export const managed = new Set(['oxlint', 'oxfmt', 'typescript', 'stylelint', 'html-validate', 'sqlfluff']);
const relative = (root, file) => './' + (root ? file.slice(root.length + 1) : file);
export async function toolIdentity(tool) {
  return sha256(
    JSON.stringify({
      command: tool.command,
      args: tool.args ?? [],
      version: tool.version ?? null,
      binaryHash: tool.binaryHash ?? null,
      installationHash: tool.receipt ? sha256(await readFile(tool.receipt)) : null,
    }),
  );
}

export async function nativeTool(id) {
  if (!['node', 'dotnet', 'cargo', 'rustc', 'rustfmt', 'rustup', 'go', 'gofmt', 'php'].includes(id))
    throw qualityError('unsupported', 'unknown native quality runtime');
  if (id === 'node')
    return { command: process.execPath, args: [], env: {}, binaryHash: sha256(await readFile(process.execPath)) };
  for (const directory of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    if (!path.isAbsolute(directory)) continue;
    const filename = path.join(directory, id + (process.platform === 'win32' ? '.exe' : ''));
    try {
      await access(filename);
      const actual = await realpath(filename),
        info = await lstat(actual);
      if (!info.isFile() || info.size > 256 * 1024 * 1024) continue;
      return { command: filename, args: [], env: {}, binaryHash: sha256(await readFile(actual)) };
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR', 'EACCES'].includes(error.code)) throw error;
    }
  }
  throw qualityError('missing', 'native quality runtime is not installed');
}
/** @param {any} check @param {typeof nativeTool} nativeResolve */
export async function qualityNativeTool(check, nativeResolve) {
  if (!check.toolchain) return nativeResolve(['phpcs', 'phpstan'].includes(check.tool) ? 'php' : check.tool);
  const rustup = await nativeResolve('rustup');
  return { ...rustup, args: [...(rustup.args ?? []), 'run', check.toolchain, check.tool] };
}
export async function privateDirectory(target, project) {
  const requested = path.resolve(target);
  await noLinks(requested);
  // The project is canonical; compare evidence in that same namespace even
  // when its not-yet-created leaf is supplied through a Windows alias.
  let current = requested;
  const missing = [];
  let absolute;
  for (;;) {
    try {
      absolute = path.join(await realpath(current), ...missing);
      break;
    } catch (error) {
      if (error.code !== 'ENOENT' || current === path.dirname(current)) throw error;
      missing.unshift(path.basename(current));
      current = path.dirname(current);
    }
  }
  await noLinks(absolute);
  if (
    inside(project, absolute) ||
    inside(absolute, project) ||
    absolute === path.parse(absolute).root ||
    absolute === (await realpath(os.homedir()))
  )
    throw qualityError(
      'unsafe_evidence',
      'quality evidence must be in a dedicated private directory outside the project',
    );
  for (let current = absolute; ; current = path.dirname(current)) {
    try {
      await lstat(path.join(current, '.git'));
      throw qualityError('unsafe_evidence', 'quality evidence must be outside Git');
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
    }
    if (current === path.dirname(current)) break;
  }
  await mkdir(absolute, { recursive: true, mode: 0o700 });
  return mkdtemp(path.join(absolute, 'quality-'));
}
export function environment(home) {
  const base = workerEnvironment(),
    safe = {};
  for (const [key, value] of Object.entries(base))
    if (
      /^(?:PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|LANG|LC_ALL|NUMBER_OF_PROCESSORS|PROCESSOR_ARCHITECTURE|DOTNET_ROOT|DOTNET_ROOT_X64)$/i.test(
        key,
      )
    )
      safe[key] = value;
  return {
    ...safe,
    HOME: home,
    USERPROFILE: home,
    APPDATA: home,
    LOCALAPPDATA: home,
    TEMP: home,
    TMP: home,
    TMPDIR: home,
    XDG_CONFIG_HOME: home,
    XDG_CACHE_HOME: home,
    NO_COLOR: '1',
    FORCE_COLOR: '0',
    CI: '1',
    DO_NOT_TRACK: '1',
    DOTNET_CLI_HOME: home,
    DOTNET_NOLOGO: '1',
    DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1',
    DOTNET_CLI_TELEMETRY_OPTOUT: '1',
    DOTNET_CLI_WORKLOAD_UPDATE_NOTIFY_DISABLE: '1',
    DOTNET_CLI_UI_LANGUAGE: 'en-US',
    VSLANG: '1033',
    RUSTUP_HOME: process.env.RUSTUP_HOME || path.join(os.homedir(), '.rustup'),
    RUSTUP_AUTO_INSTALL: '0',
    CARGO_HOME: home,
    CARGO_TARGET_DIR: path.join(home, 'cargo-target'),
    CARGO_NET_OFFLINE: 'true',
    GOENV: 'off',
    GOWORK: 'off',
    GO111MODULE: 'on',
    GOTOOLCHAIN: 'local',
    GOPROXY: 'off',
    GOSUMDB: 'off',
    GOFLAGS: '-mod=readonly',
    GOPATH: path.join(home, 'go-path'),
    GOCACHE: path.join(home, 'go-cache'),
    GOMODCACHE: path.join(home, 'go-mod'),
    PYTHONDONTWRITEBYTECODE: '1',
    PYTHONNOUSERSITE: '1',
    PIP_DISABLE_PIP_VERSION_CHECK: '1',
    NPM_CONFIG_UPDATE_NOTIFIER: 'false',
  };
}
export function validVersion(id, output, version) {
  if (typeof output !== 'string' || output.length > 4096) return false;
  const v = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
    text = output.trim();
  const patterns = {
    oxlint: `^(?:Version: )?${v}$`,
    oxfmt: `^(?:Version: )?${v}$`,
    typescript: `^Version ${v}$`,
    stylelint: `^${v}$`,
    'html-validate': `^(?:html-validate-)?${v}$`,
    sqlfluff: `^(?:python -m )?sqlfluff, version ${v}$`,
    node: `^v${v}$`,
    dotnet: `^${v}$`,
    cargo: `^cargo ${v}(?: \\([^\\r\\n]+\\))?$`,
    rustc: `^rustc ${v}(?: \\([^\\r\\n]+\\))?$`,
    clippy: `^clippy ${v}(?: \\([^\\r\\n]+\\))?$`,
    rustfmt: `^rustfmt ${v}(?:-(?:stable|nightly))?(?: \\([^\\r\\n]+\\))?$`,
    go: `^go version go${v} [a-z0-9]+/[a-z0-9]+$`,
    php: `^PHP ${v} \\(cli\\)(?:[^\\r\\n]*)(?:\\r?\\nCopyright \\(c\\) The PHP Group(?:[\\s\\S]*))?$`,
    phpcs: `^PHP_CodeSniffer version ${v} \\(stable\\)(?:[^\\r\\n]*)$`,
    phpstan: `^PHPStan - PHP Static Analysis Tool ${v}$`,
    phpunit: `^PHPUnit ${v}(?:[^\\r\\n]*)$`,
  };
  return Boolean(patterns[id] && new RegExp(patterns[id]).test(text));
}

export function argumentsFor(check, home, plan) {
  const files = check.files.map(f => relative(check.root, f)),
    manifest = check.manifest ? relative(check.root, check.manifest) : undefined;
  if (check.configured) return check.configured.args;
  switch (check.tool) {
    case 'oxlint':
      return [
        '--format',
        'json',
        '--deny-warnings',
        '--no-ignore',
        ...(check.frameworks?.includes('react') ? ['--react-plugin', '--jsx-a11y-plugin'] : []),
        ...(check.frameworks?.includes('next') ? ['--nextjs-plugin'] : []),
        ...files,
      ];
    case 'oxfmt':
      return ['--check', ...files];
    case 'typescript':
      return [
        '--noEmit',
        '--incremental',
        'false',
        '--pretty',
        'false',
        ...(plan.config.strictness === 'strict' ? ['--strict'] : []),
        '--project',
        check.typecheckConfig.path,
      ];
    case 'stylelint':
      return ['--formatter', 'json', ...files];
    case 'html-validate':
      return ['--formatter', 'json', '--max-warnings', '0', ...files];
    case 'sqlfluff':
      return ['lint', '--format', 'json', '--dialect', check.dialect, '--disable-progress-bar', ...files];
    case 'rustfmt':
      return ['--check', '--edition', check.edition, ...files];
    case 'cargo':
      return [
        check.capability === 'lint' ? 'clippy' : 'check',
        '--offline',
        '--locked',
        '--manifest-path',
        manifest,
        '--message-format=json',
        ...(check.capability === 'lint' ? ['--', '-D', 'warnings'] : []),
      ];
    case 'gofmt':
      return ['-l', ...files];
    case 'go':
      return check.capability === 'typecheck'
        ? ['build', '-o', path.join(home, 'go-output') + path.sep, './...']
        : ['vet', './...'];
    case 'dotnet':
      return check.capability === 'typecheck'
        ? [
            'build',
            manifest,
            '--no-restore',
            '--nologo',
            '-p:TreatWarningsAsErrors=true',
            `-p:OutputPath=${path.join(home, 'dotnet-output')}`,
          ]
        : [
            'format',
            ...(check.capability === 'lint' ? ['analyzers'] : ['whitespace']),
            manifest,
            '--verify-no-changes',
            '--no-restore',
            '--include',
            ...files,
          ];
    case 'php':
      return ['-n', '-l', files[0]];
    case 'phpcs':
      return [
        check.entry,
        '--report=json',
        `--standard=${check.frameworks?.includes('wordpress') ? 'WordPress' : 'PSR12'}`,
        ...files,
      ];
    case 'phpstan':
      return [check.entry, 'analyse', '--no-progress', '--error-format=json', ...files];
    default:
      throw qualityError('unsupported', 'unsupported quality command');
  }
}
export async function safeProjectEntrypoint(project, entry) {
  qualityPath(entry);
  const filename = path.join(project, entry);
  await noLinks(filename);
  const info = await lstat(filename);
  if (!info.isFile() || info.nlink > 1 || info.size > 32 * 1024 * 1024)
    throw qualityError('unsafe_path', 'unsafe quality project executable');
  return sha256(await readFile(filename));
}
export function typeScriptConfigContent(check, plan) {
  return (
    JSON.stringify({
      extends: path.join(plan.project, check.manifest),
      files: check.files.map(file => path.join(plan.project, file)),
      include: [],
      exclude: [],
      // Roots are already inventoried. Never let imports/references expand the
      // compiler program beyond the source hashes bound into this receipt.
      compilerOptions: {
        noResolve: true,
        types: [],
        typeRoots: [],
        noEmit: true,
        noCheck: false,
        skipLibCheck: false,
        skipDefaultLibCheck: false,
        incremental: false,
        composite: false,
        declaration: false,
        declarationMap: false,
        emitDeclarationOnly: false,
      },
    }) + '\n'
  );
}
export async function intactTypeScriptConfig(item, check, plan, evidenceRoot) {
  if (!item || path.dirname(item.path) !== evidenceRoot) return false;
  await noLinks(item.path);
  const info = await lstat(item.path);
  if (!info.isFile() || info.nlink > 1 || info.size > 4 * 1024 * 1024) return false;
  const content = await readFile(item.path),
    expected = typeScriptConfigContent(check, plan);
  return content.length === item.bytes && sha256(content) === item.sha256 && content.toString('utf8') === expected;
}
