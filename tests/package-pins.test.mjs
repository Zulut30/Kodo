import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// A release .tgz installs without our lockfile, so ranges would re-resolve on
// every user machine. Every direct dependency must name one exact version.
test('Direct dependencies are pinned to exact versions', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const loose = [];
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'])
    for (const [name, version] of Object.entries(pkg[field] ?? {}))
      if (!/^\d+\.\d+\.\d+$/.test(version)) loose.push(`${field}.${name}=${version}`);
  assert.deepEqual(loose, []);
});

test('Lockfile records the pinned direct dependency versions', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
  const drift = [];
  for (const field of ['dependencies', 'devDependencies'])
    for (const [name, version] of Object.entries(pkg[field] ?? {})) {
      if (lock.packages[''][field]?.[name] !== version) drift.push(`root ${field}.${name}`);
      if (lock.packages[`node_modules/${name}`]?.version !== version) drift.push(`installed ${name}`);
    }
  assert.deepEqual(drift, []);
});
