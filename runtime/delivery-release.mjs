import { randomUUID } from 'node:crypto';
import { access, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { sha256, fail, parse } from './delivery-process.mjs';
import { operationIntent, operationOutcome } from './delivery-operations.mjs';
import {
  context,
  validateRepository,
  assertFreshRelease,
  acquire,
  releaseOwnedLease,
  fetchBase,
  validateTemporary,
  safeRemove,
  cleanupDelivery,
  versionParts,
  compareVersion,
  releaseInventory,
  sortedPublished,
  publishedReleases,
} from './delivery-context.mjs';

/** Release version preparation, package build/smoke and immutable GitHub Release publication. */
async function pack(ctx, source, destination) {
  const output = parse(
    await ctx.command('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', destination], {
      cwd: source,
    }),
    'npm pack',
  );
  const item = Array.isArray(output) ? output[0] : Object.values(output)[0];
  if (!item || !item.filename || path.basename(item.filename) !== item.filename || !item.filename.endsWith('.tgz'))
    throw fail('invalid_output', 'npm pack did not produce a package');
  return { ...item, filename: path.join(destination, item.filename) };
}

async function smokePackage(ctx, artifact, directory, manifest) {
  // The smoke receipt names the exact bytes it installed.
  const artifactSha256 = sha256(await readFile(artifact));
  const install = path.join(directory, 'install');
  await mkdir(install);
  await ctx.command('npm', ['install', '--prefix', install, '--ignore-scripts', '--no-audit', '--no-fund', artifact], {
    timeoutMs: 180000,
  });
  const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.kodo;
  if (!bin || path.isAbsolute(bin) || bin.split(/[\\/]/).includes('..'))
    throw fail('release_package', 'Package has no valid kodo executable');
  if (
    !/^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/.test(manifest.name ?? '') ||
    manifest.name.split('/').some(part => part === '.' || part === '..')
  )
    throw fail('release_package', 'Package name is not valid');
  const packageRoot = path.join(install, 'node_modules', ...manifest.name.split('/'));
  let installed;
  try {
    installed = parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'), 'installed package manifest');
  } catch {
    throw fail('release_conflict', 'Downloaded archive does not contain the expected package');
  }
  const installedBin = typeof installed.bin === 'string' ? installed.bin : installed.bin?.kodo;
  if (
    installed.name !== manifest.name ||
    installed.version !== manifest.version ||
    installedBin?.replace(/^\.\//, '') !== bin.replace(/^\.\//, '')
  )
    throw fail('release_conflict', 'Archive package identity/version differs from the exact release commit');
  const entry = path.join(packageRoot, bin);
  const help = await ctx.command(process.execPath, [entry, '--help'], { cwd: install });
  if (!/kodo/i.test(help)) throw fail('smoke_failed', 'Installed command did not identify itself as Kodo');
  const list = parse(
    await ctx.command(process.execPath, [entry, 'list', '--json'], { cwd: install }),
    'installed catalog',
  );
  if (!Array.isArray(list) || !list.length) throw fail('smoke_failed', 'Installed package catalog is empty');
  const validation = parse(
    await ctx.command(process.execPath, [entry, 'validate', '--json'], { cwd: install }),
    'installed validation',
  );
  if (validation.valid !== true) throw fail('smoke_failed', 'Installed package failed validation');
  return {
    passed: true,
    commands: ['kodo --help', 'kodo list --json', 'kodo validate --json'],
    node: process.version,
    platform: process.platform,
    artifactSha256,
  };
}

/** An installed smoke counts only for the artifact whose checksum the receipt publishes. */
function assertSmokeBinding(smoke, checksum) {
  if (smoke?.passed !== true || smoke.artifactSha256 !== checksum)
    throw fail('release_conflict', 'Installed smoke was not run on the published artifact');
}

async function writeMetadata(filename, content) {
  const temporary = path.join(path.dirname(filename), `.kodo-version-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify(content, null, 2) + '\n', { flag: 'wx' });
    await rename(temporary, filename);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function prepareReleaseVersion(options) {
  const ctx = context(options);
  validateRepository(ctx.repository, ctx.baseBranch);
  const lease = await acquire(ctx, `release-version:${ctx.repository}:${ctx.baseBranch}`);
  try {
    const filename = path.join(ctx.cwd, 'package.json');
    const manifest = parse(await readFile(filename, 'utf8'), 'package.json');
    versionParts(manifest.version);
    const targetSha = await fetchBase(ctx);
    const targetVersion = parse(
      await ctx.command('git', ['show', `${targetSha}:package.json`]),
      'target package manifest',
    ).version;
    versionParts(targetVersion);
    const floor = ctx.config.delivery?.firstVersion ?? '0.2.0';
    versionParts(floor);
    const releases = parse(
      await ctx.command('gh', [
        'release',
        'list',
        '--repo',
        ctx.repository,
        '--limit',
        '100',
        '--json',
        'tagName,isDraft,isPrerelease',
      ]),
      'release versions',
    );
    const versions = releases
      .filter(
        item =>
          !item.isDraft && !item.isPrerelease && /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(item.tagName),
      )
      .map(item => item.tagName.replace(/^v/, ''))
      .sort(compareVersion);
    const latest = versions.at(-1);
    const saved = ctx.run.releaseAssignment;
    const previousVersion = saved?.version === manifest.version ? saved.previousVersion : manifest.version;
    let version;
    if (
      saved &&
      (manifest.version === saved.version ||
        (saved.baseSha === ctx.run.baseSha && manifest.version === saved.previousVersion)) &&
      compareVersion(saved.version, targetVersion) > 0 &&
      compareVersion(saved.version, floor) >= 0 &&
      (!latest || compareVersion(saved.version, latest) > 0)
    )
      version = saved.version;
    else if (ctx.config.delivery?.nextVersion) version = ctx.config.delivery.nextVersion;
    else {
      const greatest = [previousVersion, targetVersion, latest].filter(Boolean).sort(compareVersion).at(-1);
      const [major, minor, patch] = versionParts(greatest);
      const bumped = `${major}.${minor}.${patch + 1}`;
      version = compareVersion(bumped, floor) >= 0 ? bumped : floor;
    }
    versionParts(version);
    if (
      compareVersion(version, targetVersion) <= 0 ||
      compareVersion(version, floor) < 0 ||
      (latest && compareVersion(version, latest) <= 0)
    )
      throw fail(
        'release_version_mismatch',
        'Assigned release version must exceed target/published versions and satisfy the configured floor',
      );
    // Save intent before atomic metadata writes so a crash cannot bump twice.
    const assignment = {
      version,
      previousVersion: saved?.version === version ? saved.previousVersion : previousVersion,
      baseSha: ctx.run.baseSha,
      prepared: false,
    };
    await ctx.save({ releaseAssignment: assignment });
    const files = [];
    if (manifest.version !== version) {
      manifest.version = version;
      await writeMetadata(filename, manifest);
      files.push('package.json');
    }
    const lockFilename = path.join(ctx.cwd, 'package-lock.json');
    try {
      const lock = parse(await readFile(lockFilename, 'utf8'), 'package-lock.json');
      if (lock.version !== version || (lock.packages?.[''] && lock.packages[''].version !== version)) {
        lock.version = version;
        if (lock.packages?.['']) lock.packages[''].version = version;
        await writeMetadata(lockFilename, lock);
        files.push('package-lock.json');
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const registryFilename = path.join(ctx.cwd, 'registry.json');
    try {
      const registry = parse(await readFile(registryFilename, 'utf8'), 'registry.json');
      if (Array.isArray(registry.components) && typeof registry.version === 'string' && registry.version !== version) {
        registry.version = version;
        await writeMetadata(registryFilename, registry);
        files.push('registry.json');
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    assignment.prepared = true;
    await ctx.save({ releaseAssignment: assignment });
    await ctx.event('delivery.version_prepared', { version, files });
    return { version, changed: files.length > 0, files };
  } finally {
    await releaseOwnedLease(ctx, lease);
  }
}

async function verifyReleaseAssets(ctx, info, { tag, artifact, sha256: checksum }, directory) {
  if (
    !/^v\d+\.\d+\.\d+$/.test(tag ?? '') ||
    path.basename(artifact ?? '') !== artifact ||
    !/^[a-f0-9]{64}$/.test(checksum ?? '')
  )
    throw fail('release_conflict', 'Release receipt is invalid');
  if (
    info.tagName !== tag ||
    !info.assets?.some(asset => asset.name === artifact) ||
    !info.assets?.some(asset => asset.name === 'SHA256SUMS')
  )
    throw fail('release_conflict', 'Published release has incomplete assets');
  const downloaded = path.join(directory, `verify-${randomUUID()}`);
  await mkdir(downloaded);
  for (const filename of [artifact, 'SHA256SUMS'])
    await ctx.command('gh', [
      'release',
      'download',
      tag,
      '--repo',
      ctx.repository,
      '--pattern',
      filename,
      '--dir',
      downloaded,
    ]);
  if (sha256(await readFile(path.join(downloaded, artifact))) !== checksum)
    throw fail('release_conflict', 'Published package differs from its release receipt');
  if ((await readFile(path.join(downloaded, 'SHA256SUMS'), 'utf8')).trim() !== `${checksum}  ${artifact}`)
    throw fail('release_conflict', 'Published checksum file differs from its release receipt');
  return { ...info, downloadedArtifact: path.join(downloaded, artifact) };
}

async function reusableRemotePackage(ctx, info, { tag, expectedSha }, directory) {
  const downloaded = path.join(directory, `recover-${randomUUID()}`);
  await mkdir(downloaded);
  const checksumFile = path.join(downloaded, 'SHA256SUMS');
  const hasChecksum = info.assets?.some(asset => asset.name === 'SHA256SUMS');
  let recorded;
  if (hasChecksum) {
    await ctx.command('gh', [
      'release',
      'download',
      tag,
      '--repo',
      ctx.repository,
      '--pattern',
      'SHA256SUMS',
      '--dir',
      downloaded,
    ]);
    const content = (await readFile(checksumFile, 'utf8')).trim();
    const match = /^([a-f0-9]{64})  ([a-zA-Z0-9_.-]+\.tgz)$/.exec(content);
    if (!match) throw fail('release_conflict', 'Published SHA256SUMS is not a single valid Kodo artifact');
    recorded = { checksum: match[1], filename: match[2] };
  }
  const attested = expectedSha ?? /^SHA-256: ([a-f0-9]{64})\s*$/m.exec(info.body ?? '')?.[1];
  if (!attested || (recorded && recorded.checksum !== attested))
    throw fail('release_conflict', 'Release checksum is not bound to its original commit attestation');
  const archives = (info.assets ?? []).filter(asset => /^[a-zA-Z0-9_.-]+\.tgz$/.test(asset.name));
  const filename = recorded?.filename ?? (archives.length === 1 ? archives[0].name : null);
  if (archives.length > 1 && !recorded) throw fail('release_conflict', 'Release contains ambiguous package archives');
  if (!filename || !archives.some(asset => asset.name === filename))
    return { missingArchive: true, expectedSha: attested, filename, hasChecksum };
  await ctx.command('gh', [
    'release',
    'download',
    tag,
    '--repo',
    ctx.repository,
    '--pattern',
    filename,
    '--dir',
    downloaded,
  ]);
  const archivePath = path.join(downloaded, filename),
    checksum = sha256(await readFile(archivePath));
  if (checksum !== attested)
    throw fail('release_conflict', 'Published archive differs from its original commit attestation');
  if (!hasChecksum) await writeFile(checksumFile, `${checksum}  ${filename}\n`);
  return { archivePath, checksumFile, checksum, filename, hasChecksum };
}

async function getRelease(ctx, tag) {
  return parse(
    await ctx.command('gh', [
      'release',
      'view',
      tag,
      '--repo',
      ctx.repository,
      '--json',
      'url,tagName,assets,isDraft,isPrerelease,body,targetCommitish',
    ]),
    'release information',
  );
}

async function verifyPublishedArtifact(ctx, receipt, directory) {
  if (
    !/^v\d+\.\d+\.\d+$/.test(receipt.tag ?? '') ||
    path.basename(receipt.artifact ?? '') !== receipt.artifact ||
    !/^[a-f0-9]{64}$/.test(receipt.sha256 ?? '')
  )
    throw fail('release_conflict', 'Release receipt is invalid');
  await ctx.command('git', ['fetch', 'origin', '--tags']);
  const actualCommit = (await ctx.command('git', ['rev-parse', `refs/tags/${receipt.tag}^{commit}`])).trim();
  if (actualCommit !== receipt.commit) throw fail('release_conflict', 'Published tag points to a different commit');
  const info = await getRelease(ctx, receipt.tag);
  if (info.isDraft !== false) throw fail('release_conflict', 'Release has not been confirmed published');
  return verifyReleaseAssets(ctx, info, receipt, directory);
}

function assertOwnedDraft(ctx, info, version, candidate) {
  const marker = `<!-- kodo-release:${ctx.run.id}:${candidate} -->`;
  const legacy =
    info.body?.includes(`Kodo ${version}\n`) &&
    info.body.includes(`\nCommit: ${candidate}\n`) &&
    info.body.includes(`\nRun: ${ctx.run.id}\n`);
  if (
    info.tagName !== `v${version}` ||
    info.targetCommitish !== candidate ||
    info.isPrerelease ||
    !(info.body?.includes(marker) || legacy)
  )
    throw fail('release_conflict', 'An unrelated draft already uses this tag; refusing to modify it');
}

async function assertCandidateFresh(ctx, candidate, version, latest) {
  const remoteHead = await fetchBase(ctx);
  const candidateIsAncestor =
    (await ctx.command('git', ['merge-base', candidate, remoteHead], { allowFailure: true })).trim() === candidate;
  // Release inventory may announce a tag created after our initial fetch;
  // explicitly fetch that ref even when origin disables automatic tag following.
  if (latest) await ctx.command('git', ['fetch', 'origin', 'tag', latest.tagName]);
  const latestSha = latest ? (await ctx.command('git', ['rev-parse', `${latest.tagName}^{commit}`])).trim() : null;
  const containsLatest =
    !latestSha ||
    (await ctx.command('git', ['merge-base', latestSha, candidate], { allowFailure: true })).trim() === latestSha;
  assertFreshRelease({
    candidateSha: candidate,
    remoteHead,
    candidateIsAncestor,
    latestSha,
    containsLatest,
    latestVersion: latest?.tagName,
    version,
  });
}

/**
 * Publish an immutable package for an exact merged SHA. The receipt's tag URL
 * and artifact URL are authoritative. Kodo v1 never changes GitHub's mutable
 * "latest" alias, because independent publishers do not share a local lease.
 */
// oxlint-disable-next-line max-lines-per-function, complexity -- debt: docs/kodo-roadmap/MAINTAINABILITY-PLAN.md
export async function releasePackage(options) {
  const ctx = context(options);
  validateRepository(ctx.repository, ctx.baseBranch);
  const candidate = options.mergeCommit;
  if (!/^[a-f0-9]{40,64}$/.test(candidate ?? ''))
    throw fail('configuration', 'A full merged commit SHA is required for release');
  const lease = await acquire(ctx, `release:${ctx.repository}:${ctx.baseBranch}`);
  let directory, source, ownership, primaryError;
  try {
    directory = await mkdtemp(path.join(os.tmpdir(), 'kodo-release-'));
    ownership = await lstat(directory);
    const savedReceipt = ctx.run.delivery?.release;
    if (savedReceipt?.published === true && savedReceipt.commit === candidate) {
      const info = await verifyPublishedArtifact(ctx, savedReceipt, directory);
      const manifest = parse(
        await ctx.command('git', ['show', `${candidate}:package.json`]),
        'release commit manifest',
      );
      if (manifest.version !== savedReceipt.version)
        throw fail('release_conflict', 'Saved release version differs from its exact commit');
      const smoke = await smokePackage(ctx, info.downloadedArtifact, directory, manifest);
      assertSmokeBinding(smoke, savedReceipt.sha256);
      const receipt = { ...savedReceipt, url: info.url, smoke };
      await ctx.save({ delivery: { ...ctx.run.delivery, release: receipt } });
      await operationOutcome(ctx, 'release', 'reconciled', {
        tag: receipt.tag,
        commit: candidate,
        sha256: receipt.sha256,
      });
      return receipt;
    }
    source = path.join(directory, 'source');
    await ctx.command('git', ['fetch', 'origin', ctx.baseBranch, '--tags']);
    await ctx.command('git', ['worktree', 'add', '--detach', source, candidate]);
    const manifest = parse(await readFile(path.join(source, 'package.json'), 'utf8'), 'package.json');
    const version = manifest.version;
    const inventory = await releaseInventory(ctx);
    const releases = sortedPublished(inventory);
    const latest = releases.at(-1);
    const expectedVersion =
      ctx.run.releaseAssignment?.version ??
      (latest ? (ctx.config.delivery?.nextVersion ?? version) : (ctx.config.delivery?.firstVersion ?? version));
    if (version !== expectedVersion)
      throw fail(
        'release_version_mismatch',
        `Reviewed package version ${version} does not match configured release ${expectedVersion}`,
      );
    // Reconciliation of this exact release remains valid after main advances.
    const tag = `v${version}`;
    const taggedCommit = (
      await ctx.command('git', ['rev-parse', '--verify', `refs/tags/${tag}^{commit}`], { allowFailure: true })
    ).trim();
    if (taggedCommit && taggedCommit !== candidate)
      throw fail('release_conflict', 'The proposed release tag already points to another commit');
    let existing = releases.some(item => item.tagName === tag) && taggedCommit === candidate;
    const draft = inventory.find(item => item.tagName === tag && item.isDraft);
    if (draft) assertOwnedDraft(ctx, await getRelease(ctx, tag), version, candidate);
    if (taggedCommit && !existing && !draft)
      throw fail('release_conflict', 'The proposed tag is already in use without a matching Kodo release');
    if (!existing) await assertCandidateFresh(ctx, candidate, version, latest);
    let existingInfo, notes, remotePackage;
    if (existing || draft) {
      existingInfo = await getRelease(ctx, tag);
      assertOwnedDraft(ctx, existingInfo, version, candidate);
      if (draft) existing = existingInfo.isDraft === false;
      remotePackage = await reusableRemotePackage(ctx, existingInfo, { tag }, directory);
    }
    let artifactPath,
      filename,
      checksum,
      checksumFile,
      updateDraftAttestation = false;
    if (remotePackage?.archivePath) {
      ({ archivePath: artifactPath, filename, checksum, checksumFile } = remotePackage);
    } else {
      if (Object.keys(manifest.dependencies ?? {}).length || Object.keys(manifest.devDependencies ?? {}).length) {
        let hasLock = false;
        try {
          await access(path.join(source, 'package-lock.json'));
          hasLock = true;
        } catch {
          /* no lock */
        }
        await ctx.command(
          'npm',
          [
            hasLock ? 'ci' : 'install',
            '--ignore-scripts',
            '--no-audit',
            '--no-fund',
            ...(hasLock ? [] : ['--no-package-lock']),
          ],
          { cwd: source, timeoutMs: 300000 },
        );
      }
      for (const check of [...(ctx.config.commands?.test ?? []), ...(ctx.config.commands?.build ?? [])]) {
        await ctx.command(check.command, check.args ?? [], { cwd: source, timeoutMs: check.timeoutMs ?? 1200000 });
      }
      const artifacts = path.join(directory, 'artifacts');
      await mkdir(artifacts);
      const packed = await pack(ctx, source, artifacts);
      artifactPath = packed.filename;
      filename = path.basename(artifactPath);
      checksum = sha256(await readFile(artifactPath));
      checksumFile = path.join(artifacts, 'SHA256SUMS');
      await writeFile(checksumFile, `${checksum}  ${filename}\n`);
      if (
        remotePackage &&
        (remotePackage.expectedSha !== checksum || (remotePackage.filename && remotePackage.filename !== filename))
      ) {
        // An owned, empty draft has no immutable uploaded bytes yet. A fresh
        // build of its exact commit may update that draft's checksum notes.
        if (existingInfo.isDraft && !existingInfo.assets?.length) updateDraftAttestation = true;
        else
          throw fail(
            'release_conflict',
            'The missing original archive cannot be reproduced without replacing an existing checksum/asset',
          );
      }
    }
    const smoke = await smokePackage(ctx, artifactPath, directory, manifest);
    assertSmokeBinding(smoke, checksum);
    if (!existing) {
      await assertCandidateFresh(ctx, candidate, version, latest);
      const latestBeforePublish = (await publishedReleases(ctx)).at(-1);
      if (latestBeforePublish?.tagName !== latest?.tagName)
        throw fail(
          'stale_release',
          'Published release state changed while preparing the package; prepare its version again',
        );
      notes = path.join(directory, 'notes.md');
      const content = updateDraftAttestation
        ? existingInfo.body.replace(/^SHA-256: [a-f0-9]{64}\s*$/m, `SHA-256: ${checksum}`)
        : `Kodo ${version}\n\n${ctx.run.task}\n\nCommit: ${candidate}\nRun: ${ctx.run.id}\n\nSHA-256: ${checksum}\n\nPackage installation and CLI smoke checks passed on ${process.platform}, Node.js ${process.version}.\n\n<!-- kodo-release:${ctx.run.id}:${candidate} -->\n`;
      await writeFile(notes, content);
    }
    return await ctx.irreversible(async () => {
      // A published release with all its assets is only read: no intent for it. Publishing a
      // draft or uploading a missing asset changes the remote and is announced first.
      const complete = ['SHA256SUMS', filename].every(name => existingInfo?.assets?.some(asset => asset.name === name));
      if (!existing || !complete) await operationIntent(ctx, 'release', { tag, commit: candidate, sha256: checksum });
      let publishedHere = false;
      if (existingInfo) {
        // A process can die after creating the release but before uploading every
        // asset. Upload only absent names; never replace an existing asset.
        if (updateDraftAttestation)
          await ctx.command(
            'gh',
            [
              'release',
              'edit',
              tag,
              '--repo',
              ctx.repository,
              '--notes-file',
              notes,
              '--draft',
              '--latest=false',
              '--target',
              candidate,
            ],
            { ignoreAbort: true },
          );
        if (!existingInfo.assets?.some(asset => asset.name === filename))
          await ctx.command('gh', ['release', 'upload', tag, artifactPath, '--repo', ctx.repository], {
            ignoreAbort: true,
          });
        if (!existingInfo.assets?.some(asset => asset.name === 'SHA256SUMS'))
          await ctx.command('gh', ['release', 'upload', tag, checksumFile, '--repo', ctx.repository], {
            ignoreAbort: true,
          });
      } else {
        await ctx.command(
          'gh',
          [
            'release',
            'create',
            tag,
            artifactPath,
            checksumFile,
            '--repo',
            ctx.repository,
            '--target',
            candidate,
            '--title',
            `Kodo ${version}`,
            '--notes-file',
            notes,
            '--draft',
            '--latest=false',
          ],
          { ignoreAbort: true },
        );
      }
      const ready = await getRelease(ctx, tag);
      if (ready.isDraft) {
        assertOwnedDraft(ctx, ready, version, candidate);
        await verifyReleaseAssets(ctx, ready, { tag, artifact: filename, sha256: checksum }, directory);
        const latestAtPublication = (await publishedReleases(ctx)).at(-1);
        await assertCandidateFresh(ctx, candidate, version, latestAtPublication);
        await ctx.command(
          'gh',
          ['release', 'edit', tag, '--repo', ctx.repository, '--draft=false', '--latest=false', '--target', candidate],
          { ignoreAbort: true },
        );
        publishedHere = true;
      }
      const published = await verifyPublishedArtifact(
        ctx,
        { tag, commit: candidate, artifact: filename, sha256: checksum },
        directory,
      );
      const receipt = {
        version,
        tag,
        commit: candidate,
        url: published.url,
        artifact: filename,
        artifactUrl: `https://github.com/${ctx.repository}/releases/download/${tag}/${filename}`,
        sha256: checksum,
        smoke,
        published: true,
      };
      await ctx.save({ delivery: { ...ctx.run.delivery, mergeCommit: candidate, release: receipt } });
      await ctx.event('delivery.released', receipt);
      // Publication is the operation: `confirmed` when this call made the release public.
      await operationOutcome(ctx, 'release', publishedHere ? 'confirmed' : 'reconciled', {
        tag,
        commit: candidate,
        sha256: checksum,
      });
      return receipt;
    });
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    await cleanupDelivery(
      ctx,
      primaryError,
      [
        async () => {
          if (primaryError?.teardownError)
            throw fail(
              'process_teardown',
              `Release worktree cleanup deferred until owned teardown can be confirmed: ${directory}`,
            );
          if (!source || !(await validateTemporary(directory, 'kodo-release-', ownership))) return;
          try {
            if (
              (await lstat(source)).isSymbolicLink() ||
              (await realpath(source)) !== path.join(await realpath(directory), 'source')
            )
              throw fail('unsafe_path', 'Refusing to remove a linked release worktree');
          } catch (error) {
            if (error.code === 'ENOENT') return;
            throw error;
          }
          await ctx.command('git', ['worktree', 'remove', '--force', source], { ignoreAbort: true, reconcile: true });
        },
        async () => {
          if (primaryError?.teardownError) return; // Keep the source for safe recovery.
          if (directory) await safeRemove(directory, 'kodo-release-', ownership);
        },
        () => releaseOwnedLease(ctx, lease),
      ],
      ctx.run.delivery?.release?.published === true && ctx.run.delivery.release.commit === candidate,
    );
  }
}
