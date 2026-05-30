#!/usr/bin/env node
/**
 * Copy Tauri bundle artifacts into release/assets/ with stable names + SHA256SUMS.
 *
 * Usage (repo root): pnpm run release:collect
 * Env: RELEASE_VERSION, XYZTOOLS_BUNDLE_DIR (override bundle search path)
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT, readReleaseVersion } from './lib/version.mjs';
import { mapBundleToReleaseName } from './lib/naming.mjs';

const version = readReleaseVersion();
const assetsDir = path.join(REPO_ROOT, 'release', 'assets');
const defaultBundleRoot = path.join(
  REPO_ROOT,
  'xyztoolsapp',
  'src-tauri',
  'target',
  'release',
  'bundle',
);

const bundleRoot = process.env.XYZTOOLS_BUNDLE_DIR
  ? path.resolve(process.env.XYZTOOLS_BUNDLE_DIR)
  : defaultBundleRoot;

const INSTALLER_EXT = new Set(['.dmg', '.deb', '.msi', '.exe', '.appimage']);

function walkFiles(dir, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, acc);
    else acc.push(full);
  }
  return acc;
}

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

function copyArtifact(src, destName) {
  const dest = path.join(assetsDir, destName);
  fs.mkdirSync(assetsDir, { recursive: true });
  fs.copyFileSync(src, dest);
  console.log(`  ${path.basename(src)} → ${destName}`);
  return dest;
}

console.log(`XYZTools release collect — v${version}`);
console.log(`Bundle root: ${bundleRoot}`);

if (!fs.existsSync(bundleRoot)) {
  console.error(
    `\nNo bundle directory. Build first:\n  cd xyztoolsapp && pnpm tauri build\n`,
  );
  process.exit(1);
}

const candidates = walkFiles(bundleRoot).filter((f) => {
  const ext = path.extname(f).toLowerCase();
  return INSTALLER_EXT.has(ext);
});

if (candidates.length === 0) {
  console.error(`\nNo installer files (.dmg, .deb, .msi, .exe, .AppImage) under ${bundleRoot}`);
  process.exit(1);
}

const staged = [];
const usedNames = new Set();

for (const src of candidates) {
  const base = path.basename(src);
  const releaseName = mapBundleToReleaseName(base, version);
  if (!releaseName) {
    console.log(`  skip (unmapped): ${base}`);
    continue;
  }
  if (usedNames.has(releaseName)) {
    console.log(`  skip (duplicate ${releaseName}): ${base}`);
    continue;
  }
  usedNames.add(releaseName);
  staged.push(copyArtifact(src, releaseName));
}

const checksumLines = [];
for (const file of staged) {
  const sum = sha256File(file);
  checksumLines.push(`${sum}  ${path.basename(file)}`);
}

const sumsPath = path.join(assetsDir, 'SHA256SUMS');
fs.writeFileSync(sumsPath, checksumLines.join('\n') + '\n');
console.log(`\nWrote ${checksumLines.length} installer(s) + SHA256SUMS → release/assets/`);
