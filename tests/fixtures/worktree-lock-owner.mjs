import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { makeWorktree } from '../../runtime/workspace.mjs';

// Run the real add, but deliver its close event to makeWorktree only on request.
// The test can kill the lock owner here without orphaning a Git subprocess.
const spawn = childProcess.spawn;
childProcess.spawn = (command, args, options) => {
  const child = spawn(command, args, options);
  if (command === 'git' && args.includes('worktree') && args.includes('add')) {
    const emit = child.emit.bind(child);
    child.emit = (event, ...values) => {
      if (event !== 'close') return emit(event, ...values);
      process.once('message', () => emit(event, ...values));
      process.send('add pending');
      return true;
    };
  }
  return child;
};
syncBuiltinESMExports();
await makeWorktree(...process.argv.slice(2));
process.disconnect();
