/** Tool output parsers for quality checks. Parsers never equate arbitrary
 * exit-zero output with a completed check: anything they cannot fully account
 * for is malformed. Each tool parser appends to `findings` and returns
 * nothing for the default verdict, or returns a complete verdict itself.
 */
import path from 'node:path';
import { lstatSync, realpathSync } from 'node:fs';
import { inside, sha256 } from './toolchains.mjs';
import { qualityError, qualityPath } from './quality.mjs';

const malformed = () => {
  throw qualityError('invalid_output', 'incomplete or malformed quality tool output');
};
const parse = value => {
  try {
    return JSON.parse(value);
  } catch {
    return malformed();
  }
};
function fileInOutput(value, check, project) {
  if (typeof value !== 'string' || !value) return malformed();
  const filename = value.replaceAll('\\', '/');
  let name;
  if (path.isAbsolute(value) || /^[A-Za-z]:\//.test(filename)) {
    let absolute = path.resolve(value);
    const scopedName = inside(project, absolute) ? path.relative(project, absolute).replaceAll('\\', '/') : null;
    if (process.platform === 'win32' && !check.files.includes(scopedName)) {
      // A compiler can report the original DOS/redirected spelling although
      // planning uses the canonical root. Accept only a real, link-free alias.
      try {
        let current = path.parse(absolute).root;
        for (const part of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
          current = path.join(current, part);
          if (lstatSync(current).isSymbolicLink()) return malformed();
        }
        absolute = realpathSync.native(absolute);
      } catch {
        return malformed();
      }
    }
    if (!inside(project, absolute)) return malformed();
    name = path.relative(project, absolute).replaceAll('\\', '/');
  } else name = (check.root ? check.root + '/' : '') + filename.replace(/^\.\//, '');
  qualityPath(name);
  if (!check.files.includes(name)) return malformed();
  return name;
}
function finding(file, ruleId, line, severity, identity) {
  if (
    typeof ruleId !== 'string' ||
    !/^[\w./:()@-]{1,160}$/.test(ruleId) ||
    !Number.isInteger(line) ||
    line < 1 ||
    !['error', 'warning', 'info'].includes(severity)
  )
    return malformed();
  return {
    file,
    ruleId,
    line,
    severity,
    fingerprint: sha256(JSON.stringify({ file, ruleId, line, severity, identity })),
  };
}

function parseConfigured(check, result, project, out, findings) {
  const doc = parse(out);
  if (
    doc?.schemaVersion !== 1 ||
    doc.complete !== true ||
    !['passed', 'failed'].includes(doc.status) ||
    !Array.isArray(doc.findings) ||
    !Array.isArray(doc.scannedFiles)
  )
    return malformed();
  const scanned = doc.scannedFiles.map(f => fileInOutput(f, check, project));
  if (new Set(scanned).size !== check.files.length || check.files.some(f => !scanned.includes(f))) return malformed();
  for (const item of doc.findings)
    findings.push(
      finding(
        fileInOutput(item.file, check, project),
        item.ruleId,
        item.line,
        item.severity,
        item.fingerprint ?? item.message,
      ),
    );
  if ((doc.status === 'passed') !== (findings.length === 0)) return malformed();
}

function parseOxlint(check, result, project, out, findings) {
  if (result.stderr.trim()) return malformed();
  const doc = parse(out);
  if (
    !Array.isArray(doc?.diagnostics) ||
    !Number.isInteger(doc.number_of_files) ||
    doc.number_of_files !== check.files.length
  )
    return malformed();
  for (const item of doc.diagnostics) {
    const file = fileInOutput(item.filename, check, project),
      line = item.labels?.[0]?.span?.line ?? 1;
    if (typeof item.message !== 'string' || !Array.isArray(item.labels)) return malformed();
    findings.push(finding(file, item.code, line, item.severity, { message: item.message, labels: item.labels }));
  }
}

function parseFileReports(check, result, project, out, findings) {
  const id = check.tool;
  if (id === 'stylelint' ? Boolean(out) && Boolean(result.stderr.trim()) : Boolean(result.stderr.trim()))
    return malformed();
  const doc = parse(id === 'stylelint' ? out || result.stderr.trim() : out);
  if (
    !Array.isArray(doc) ||
    (id === 'html-validate' ? doc.length > check.files.length : doc.length !== check.files.length)
  )
    return malformed();
  const scanned = new Set();
  for (const item of doc) {
    const reportedPath = id === 'stylelint' ? item.source : id === 'html-validate' ? item.filePath : item.filepath;
    const file = fileInOutput(reportedPath, check, project);
    if (scanned.has(file)) return malformed();
    scanned.add(file);
    let messages;
    if (id === 'stylelint') {
      if (
        !Array.isArray(item.warnings) ||
        !Array.isArray(item.parseErrors) ||
        !Array.isArray(item.invalidOptionWarnings) ||
        item.parseErrors.length ||
        item.invalidOptionWarnings.length ||
        (item.errored && !item.warnings.length)
      )
        return malformed();
      messages = item.warnings;
    } else if (id === 'html-validate') {
      if (
        !Array.isArray(item.messages) ||
        !Number.isInteger(item.errorCount) ||
        item.errorCount < 0 ||
        !Number.isInteger(item.warningCount) ||
        item.warningCount < 0 ||
        item.errorCount + item.warningCount !== item.messages.length
      )
        return malformed();
      messages = item.messages;
    } else {
      if (!Array.isArray(item.violations)) return malformed();
      messages = item.violations;
    }
    for (const item of messages)
      findings.push(
        finding(
          file,
          item.rule ?? item.ruleId ?? item.code,
          item.line ?? item.start_line_no,
          item.severity === 2 ? 'error' : item.severity === 1 ? 'warning' : (item.severity ?? 'error'),
          item.text ?? item.message ?? item.description,
        ),
      );
  }
}

function parseGofmt(check, result, project, out, findings) {
  if (result.stderr.trim()) return malformed();
  for (const name of out ? out.split(/\r?\n/) : [])
    findings.push(finding(fileInOutput(name, check, project), 'format', 1, 'error', 'gofmt-unformatted'));
}

function parseOxfmt(check, result, project, out, findings) {
  const complete =
    /^Checking formatting\.\.\.\s+All matched files use the correct format\.\s+Finished in [\d.]+(?:ms|s) on (\d+) files using \d+ threads\.$/.exec(
      out,
    );
  const notice = 'No config found, using defaults. Please add a config file or try `oxfmt --init` if needed.';
  if (
    result.code === 0 &&
    complete &&
    Number(complete[1]) === check.files.length &&
    (!result.stderr.trim() || result.stderr.trim() === notice)
  )
    return { findings, clean: true };
  if (result.code !== 0) return { findings, clean: false };
  return malformed();
}

function parseTypescript(check, result, project, out, findings) {
  if (result.code === 0 && !out && !result.stderr.trim()) return { findings, clean: true };
  // Type errors are not silently baseline-able from incomplete text output.
  if (result.code !== 0 && /error TS\d+:/.test(out + result.stderr)) return { findings, clean: false };
  return malformed();
}

function parseRustfmt(check, result, project, out, findings) {
  if (result.code === 0 && !out && !result.stderr.trim()) return { findings, clean: true };
  if (result.code !== 0 && /^(?:Diff in|error:)/m.test(out + result.stderr)) return { findings, clean: false };
  return malformed();
}

function parseCargo(check, result, project, out, findings) {
  if (
    result.code === 0 &&
    result.stderr
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .some(line => !/^\s*(?:Checking|Compiling|Finished|Fresh|Blocking waiting for file lock)\b/.test(line))
  )
    return malformed();
  const rows = out.split(/\r?\n/).filter(Boolean).map(parse);
  if (!rows.length || rows.at(-1).reason !== 'build-finished' || typeof rows.at(-1).success !== 'boolean')
    return malformed();
  if (
    rows.some(
      row => !['compiler-message', 'compiler-artifact', 'build-script-executed', 'build-finished'].includes(row.reason),
    )
  )
    return malformed();
  for (const row of rows.filter(r => r.reason === 'compiler-message')) {
    const message = row.message,
      span = message?.spans?.find(s => s.is_primary);
    if (message?.level === 'failure-note') continue;
    if (!span || !['error', 'warning', 'note', 'help'].includes(message.level)) return malformed();
    findings.push(
      finding(
        fileInOutput(span.file_name, check, project),
        message.code?.code ?? 'compiler',
        span.line_start,
        ['note', 'help'].includes(message.level) ? 'info' : message.level,
        message.message,
      ),
    );
  }
  if (result.code === 0 && rows.at(-1).success !== true) return malformed();
}

function parseGo(check, result, project, out, findings) {
  if (result.code === 0 && !out && !result.stderr.trim()) return { findings, clean: true };
  if (result.code !== 0 && /(?:\.go:\d+|^# )/m.test(out + result.stderr)) return { findings, clean: false };
  return malformed();
}

function parseDotnet(check, result, project, out, findings) {
  if (check.capability === 'typecheck') {
    const summaries = out.split(/\r?\n/).filter(line => /(?:Warning|Error)\(s\)/.test(line));
    const completeCleanSummary =
      summaries.length === 2 &&
      summaries.some(line => /^\s*0 Warning\(s\)\s*$/.test(line)) &&
      summaries.some(line => /^\s*0 Error\(s\)\s*$/.test(line));
    if (
      result.code === 0 &&
      !result.stderr.trim() &&
      /Build succeeded\./.test(out) &&
      !/Build FAILED/.test(out) &&
      completeCleanSummary &&
      !/\b(?:warning|error) [A-Z]+\d+:/.test(out)
    )
      return { findings, clean: true };
    if (result.code !== 0 && /(?:Build FAILED|error [A-Z]+\d+:)/.test(out + result.stderr))
      return { findings, clean: false };
    return malformed();
  }
  if (result.code === 0 && !out && !result.stderr.trim()) return { findings, clean: true };
  if (result.code !== 0) return { findings, clean: false };
  return malformed();
}

function parsePhp(check, result, project, out, findings) {
  if (result.code === 0 && /^No syntax errors detected in [^\r\n]+$/.test(out) && !result.stderr.trim())
    return { findings, clean: true };
  if (result.code !== 0 && /(?:Parse error|Errors parsing|Fatal error)/.test(out + result.stderr))
    return { findings, clean: false };
  return malformed();
}

function parsePhpcs(check, result, project, out, findings) {
  const doc = parse(out);
  if (!doc?.totals || !doc.files || typeof doc.files !== 'object') return malformed();
  const entries = Object.entries(doc.files);
  if (entries.length !== check.files.length) return malformed();
  for (const [name, item] of entries) {
    if (!Array.isArray(item.messages)) return malformed();
    const file = fileInOutput(name, check, project);
    for (const message of item.messages)
      findings.push(finding(file, message.source, message.line, message.type?.toLowerCase(), message.message));
  }
  if (doc.totals.errors + doc.totals.warnings !== findings.length) return malformed();
}

function parsePhpstan(check, result, project, out, findings) {
  const doc = parse(out);
  if (
    !doc?.totals ||
    !doc.files ||
    !Array.isArray(doc.errors) ||
    doc.errors.length ||
    doc.totals.errors !== 0 ||
    !Number.isInteger(doc.totals.file_errors) ||
    doc.totals.file_errors < 0
  )
    return malformed();
  for (const [name, item] of Object.entries(doc.files)) {
    if (!Array.isArray(item.messages)) return malformed();
    for (const message of item.messages)
      findings.push(
        finding(
          fileInOutput(name, check, project),
          message.identifier ?? 'phpstan',
          message.line,
          'error',
          message.message,
        ),
      );
  }
  if (doc.totals.file_errors !== findings.length) return malformed();
}

const parsers = {
  oxlint: parseOxlint,
  stylelint: parseFileReports,
  'html-validate': parseFileReports,
  sqlfluff: parseFileReports,
  gofmt: parseGofmt,
  oxfmt: parseOxfmt,
  typescript: parseTypescript,
  rustfmt: parseRustfmt,
  cargo: parseCargo,
  go: parseGo,
  dotnet: parseDotnet,
  php: parsePhp,
  phpcs: parsePhpcs,
  phpstan: parsePhpstan,
};

/** Parsers never equate arbitrary exit-zero output with a completed check. */
export function parseQualityOutput(check, result, project) {
  if (
    !result ||
    !Number.isInteger(result.code) ||
    typeof result.stdout !== 'string' ||
    typeof result.stderr !== 'string' ||
    result.outputTruncated
  )
    return malformed();
  const out = result.stdout.trim(),
    findings = [];
  const parser = check.configured
    ? parseConfigured
    : Object.hasOwn(parsers, check.tool)
      ? parsers[check.tool]
      : malformed;
  return (
    parser(check, result, project, out, findings) ?? { findings, clean: findings.length === 0 && result.code === 0 }
  );
}
