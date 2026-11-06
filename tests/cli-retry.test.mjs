import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
test('CLI automatic quota retries preserve host preparation and explicit plan files', async t => {
  for (const prepare of [true, false])
    await t.test(prepare ? 'host-preparation' : 'explicit-plan', async subtest => {
      const directory = await mkdtemp(path.join(os.tmpdir(), 'kodo-cli-retry-'));
      subtest.after(async () => {
        assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
        assert.ok(path.basename(directory).startsWith('kodo-cli-retry-'));
        await rm(directory, { recursive: true, force: true });
      });
      const git = args =>
        execFileSync('git', args, { cwd: directory, encoding: 'utf8', windowsHide: true, stdio: 'pipe' });
      git(['init', '-b', 'main']);
      git(['config', 'user.name', 'CLI Retry Test']);
      git(['config', 'user.email', 'retry@example.invalid']);
      await writeFile(path.join(directory, 'baseline.txt'), 'baseline\n');
      git(['add', '.']);
      git(['commit', '-m', 'baseline']);
      const planFile = path.join(directory, 'plan.json');
      await writeFile(planFile, JSON.stringify({ summary: 'fixture plan', tasks: [] }));
      const hook = path.join(directory, 'engine-fixture.mjs');
      const expected = prepare ? { prepare: true } : { planFile };
      await writeFile(
        hook,
        `import assert from 'node:assert/strict';
import {Engine} from ${JSON.stringify(pathToFileURL(path.join(root, 'runtime/engine.mjs')).href)};
let calls=0;
Engine.prototype.run=async function(id,options){
 calls++;
 if(calls===1) return this.store.updateRun(id,{state:'waiting_limits',error:{code:'quota',retryAt:new Date(Date.now()+80).toISOString()}});
 assert.equal(calls,2);
 const expected=${JSON.stringify(expected)};
 for(const [key,value] of Object.entries(expected)) assert.equal(options[key],value,'automatic retry lost '+key);
 return this.store.updateRun(id,{state:${JSON.stringify(prepare ? 'awaiting_plan' : 'succeeded')},retryConfirmed:true});
};\n`,
      );
      const result = spawnSync(
        process.execPath,
        [
          '--import',
          pathToFileURL(hook).href,
          path.join(root, 'cli/index.mjs'),
          'run',
          'fixture task',
          '--project',
          directory,
          ...(prepare ? ['--prepare'] : ['--plan', planFile]),
          '--json',
        ],
        {
          cwd: directory,
          encoding: 'utf8',
          windowsHide: true,
          timeout: 30000,
          env: {
            ...process.env,
            KODO_HOME: path.join(directory, 'state'),
            KODO_CREDENTIAL_HOME: path.join(directory, 'credentials'),
          },
        },
      );
      assert.equal(result.status, 0, result.stderr);
      const value = JSON.parse(result.stdout);
      assert.equal(value.state, prepare ? 'awaiting_plan' : 'succeeded');
      assert.equal(value.retryConfirmed, true);
    });
});
