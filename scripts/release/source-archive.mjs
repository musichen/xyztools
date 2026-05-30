#!/usr/bin/env node
/**
 * Create XYZTools-<version>-source.zip via git archive (export-ignore safe).
 *
 * Usage: pnpm run release:source
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT, readReleaseVersion } from './lib/version.mjs';
import { releaseAssetNames } from './lib/naming.mjs';

const version = readReleaseVersion();
const assetsDir = path.join(REPO_ROOT, 'release', 'assets');
const { sourceZip } = releaseAssetNames(version);
const outPath = path.join(assetsDir, sourceZip);
const prefix = `XYZTools-${version}`;

fs.mkdirSync(assetsDir, { recursive: true });

function gitRef() {
  try {
    const tag = execSync('git describe --tags --exact-match 2>/dev/null', {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    }).trim();
    if (tag) return tag;
  } catch {
    /* no exact tag */
  }
  return 'HEAD';
}

const ref = gitRef();
console.log(`Creating source archive ${sourceZip} from git ${ref}…`);

try {
  execSync(
    `git archive --format=zip --prefix="${prefix}/" -o "${outPath}" ${ref}`,
    { cwd: REPO_ROOT, stdio: 'inherit' },
  );
} catch (err) {
  console.error('\ngit archive failed. Commit your tree or set a tag, then retry.');
  process.exit(1);
}

const stat = fs.statSync(outPath);
console.log(`\nWrote ${outPath} (${(stat.size / 1024 / 1024).toFixed(2)} MiB)`);
console.log('Excluded via .gitattributes export-ignore: build outputs, secrets, local snapshots.');
