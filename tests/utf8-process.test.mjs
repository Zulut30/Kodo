import test from 'node:test';
import assert from 'node:assert/strict';
import { execute as runCommand } from '../runtime/command.mjs';
import { execute as runDelivery } from '../runtime/delivery.mjs';

const stdout = '🌍 Привет, Kodo';
const stderr = 'Ошибка: русский текст';
const script = `const out=Buffer.from(${JSON.stringify(stdout)}),err=Buffer.from(${JSON.stringify(stderr)});process.stdout.write(out.subarray(0,1));process.stderr.write(err.subarray(0,1));setTimeout(()=>{process.stdout.write(out.subarray(1));process.stderr.write(err.subarray(1));},80);`;

for (const [name, execute] of [['worker/coordinator', runCommand], ['delivery', runDelivery]]) {
  test(`${name} command capture preserves UTF-8 characters split across pipe chunks`, async () => {
    const result = await execute(process.execPath, ['-e', script]);
    assert.equal(result.code, 0); assert.equal(result.stdout, stdout); assert.equal(result.stderr, stderr);
    assert.equal(result.stdout.includes('\uFFFD'), false);
  });
}
