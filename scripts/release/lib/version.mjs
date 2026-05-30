import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, '../../..');

export function normalizeVersion(raw) {
  const v = raw.trim();
  return v.startsWith('v') ? v.slice(1) : v;
}

export function readReleaseVersion() {
  const fromEnv = process.env.RELEASE_VERSION?.trim();
  if (fromEnv) return normalizeVersion(fromEnv);

  const versionFile = path.join(REPO_ROOT, 'release', 'VERSION');
  if (fs.existsSync(versionFile)) {
    return fs.readFileSync(versionFile, 'utf8').trim();
  }

  const tauriConf = path.join(REPO_ROOT, 'xyztoolsapp', 'src-tauri', 'tauri.conf.json');
  if (fs.existsSync(tauriConf)) {
    const conf = JSON.parse(fs.readFileSync(tauriConf, 'utf8'));
    if (conf.version) return String(conf.version);
  }

  throw new Error('Set RELEASE_VERSION or release/VERSION or xyztoolsapp tauri.conf.json version');
}
