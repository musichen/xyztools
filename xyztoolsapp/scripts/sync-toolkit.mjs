/**
 * Copy Node toolkit (yttool + index + whisper script + package.json) into
 * src-tauri/resources/toolkit and install production node_modules (no Puppeteer browser download).
 */
import { cpSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..', '..');
const DEST = join(__dirname, '..', 'src-tauri', 'resources', 'toolkit');

const FILES = ['index.js', 'yttool.js', 'whisper_transcribe.py', 'package.json'];

function main() {
  rmSync(DEST, { recursive: true, force: true });
  mkdirSync(DEST, { recursive: true });
  for (const f of FILES) {
    const src = join(REPO, f);
    if (!existsSync(src)) throw new Error(`Missing ${src}`);
    cpSync(src, join(DEST, f));
  }
  const pkgPath = join(DEST, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  delete pkg.devDependencies;
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
  execSync('npm install --omit=dev', {
    cwd: DEST,
    stdio: 'inherit',
    env: { ...process.env, PUPPETEER_SKIP_CHROMIUM_DOWNLOAD: '1' },
  });
  console.log('Toolkit synced →', DEST);
}

main();
