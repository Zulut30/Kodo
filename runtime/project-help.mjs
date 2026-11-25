// `kodo project --help` and `kodo project <action> --help`: the project command reference,
// printed before strict parsing, credentials, state or providers. `kodo --help` lists the
// same lines (cli/index.mjs).

export const PROJECT_USAGE = Object.freeze([
  'kodo project create --file SPEC [--command-id UUID] [--json]',
  'kodo project profile set PROJECT_ID --file PROFILE_JSON [--json]',
  'kodo project profile show PROJECT_ID [--json]',
  'kodo project profile pause-pool PROJECT_ID --subscription ID --until ISO [--json]',
  'kodo project status PROJECT_ID [--json]',
  'kodo project plan PROJECT_ID [--limit 1..24] [--dry-run] [--json]',
  'kodo project resume PROJECT_ID [--retry-failed] [--command-id UUID] [--json]',
  'kodo project drain PROJECT_ID [--max-waves 1..100] [--concurrency N] [--retry-failed] [--command-id UUID] [--json] (default 3, max 5 or profile capacity up to 64)',
  'kodo project cancel|pause PROJECT_ID [--command-id UUID] [--json]',
  'kodo project reprioritize PROJECT_ID TASK_ID --priority 0..100 [--command-id UUID] [--json]',
  'kodo project approve-risk PROJECT_ID TASK_ID --reason TEXT [--command-id UUID] [--json]',
  'kodo project next-wave PROJECT_ID --host t3|orca [--limit N] [--stall-minutes N] [--retry-failed] [--json] (default 3, max 5 or profile capacity up to 64)',
  'kodo project complete-task PROJECT_ID TASK_ID --head SHA [--defer-gate] [--attempt UUID] [--command-id UUID] [--json]',
  'kodo project complete-task PROJECT_ID TASK_ID --head SHA --abandon --attempt UUID [--command-id UUID] [--json]',
  'kodo project gc-worktrees PROJECT_ID [--json]',
  'kodo project gates PROJECT_ID [--retry-failed] [--json]',
  'kodo project bootstrap "IDEA" --root PATH [--prepare] [--client codex|claude-code] [--model MODEL] [--json]',
  'kodo project apply-spec --root PATH [--file SPEC_JSON] [--command-id UUID] [--json]',
  'kodo project extend PROJECT_ID "FEATURE" [--prepare] [--client codex|claude-code] [--model MODEL] [--command-id UUID] [--json]',
  'kodo project append-milestone PROJECT_ID --file MILESTONE_JSON [--command-id UUID] [--json]',
  'kodo project report PROJECT_ID [--json]',
]);

const HEADING = 'Команды проекта Kodo (docs/PROJECTS.md, docs/BLUEPRINT.md, docs/T3-HOST.md):';
const asked = argv => Array.isArray(argv) && (argv[0] === 'help' || argv.some(arg => arg === '--help' || arg === '-h'));

/** The help outcome when argv asks for it, otherwise null. Exit 0; `--json` gives the report. */
export function projectHelp(argv) {
  if (!asked(argv)) return null;
  // `project help ACTION` and `project ACTION --help` both name the action.
  const target = argv[0] === 'help' ? argv[1] : argv[0];
  const own = PROJECT_USAGE.filter(line => line.split(' ')[2].split('|').includes(target));
  const usage = own.length ? own : [...PROJECT_USAGE];
  const report = { schemaVersion: 1, projectId: null, revision: null, result: { status: 'help', usage } };
  return {
    report,
    exitCode: 0,
    output: argv.includes('--json') ? JSON.stringify(report, null, 2) : [HEADING, ...usage].join('\n'),
  };
}
