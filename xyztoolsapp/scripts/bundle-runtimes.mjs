/**
 * Download Node.js, yt-dlp, and FFmpeg into src-tauri/resources/runtime/<target-triple>/
 * for offline Tauri bundles. Run from repo via `pnpm tauri build` (TAURI_ENV_TARGET_TRIPLE set).
 *
 * Models (Whisper weights) are NOT downloaded here — use the in-app prefetch / install flow.
 * macOS bundles a standalone CPython (install_only) for the in-app Whisper venv installer.
 */
import { mkdirSync, rmSync, copyFileSync, readdirSync, createWriteStream, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP = join(__dirname, '..');
const OUT_BASE = join(APP, 'src-tauri', 'resources', 'runtime');

const NODE_VER = '20.18.1';

const TRIPLE = process.env.TAURI_ENV_TARGET_TRIPLE || execFileSync('rustc', ['--print', 'host-tuple'], { encoding: 'utf8' }).trim();

const NODE_TAR = {
  'aarch64-apple-darwin': `https://nodejs.org/dist/v${NODE_VER}/node-v${NODE_VER}-darwin-arm64.tar.gz`,
  'x86_64-apple-darwin': `https://nodejs.org/dist/v${NODE_VER}/node-v${NODE_VER}-darwin-x64.tar.gz`,
  'x86_64-unknown-linux-gnu': `https://nodejs.org/dist/v${NODE_VER}/node-v${NODE_VER}-linux-x64.tar.xz`,
  'x86_64-pc-windows-msvc': `https://nodejs.org/dist/v${NODE_VER}/node-v${NODE_VER}-win-x64.zip`,
};

/** Standalone CPython for in-app `openai-whisper` install (macOS only in this script). */
const PYTHON_RELEASE = '20241016';
const PYTHON_VER = '3.12.7';
const PYTHON_TAR = {
  'aarch64-apple-darwin': `https://github.com/astral-sh/python-build-standalone/releases/download/${PYTHON_RELEASE}/cpython-${PYTHON_VER}+${PYTHON_RELEASE}-aarch64-apple-darwin-install_only.tar.gz`,
  'x86_64-apple-darwin': `https://github.com/astral-sh/python-build-standalone/releases/download/${PYTHON_RELEASE}/cpython-${PYTHON_VER}+${PYTHON_RELEASE}-x86_64-apple-darwin-install_only.tar.gz`,
};

const FFMPEG_URL = {
  // Apple Silicon: evermeet.cx is Intel-only (see https://evermeet.cx/ffmpeg/apple-silicon-arm).
  'aarch64-apple-darwin': 'https://www.osxexperts.net/ffmpeg81arm.zip',
  // Intel Mac: evermeet.cx static builds.
  'x86_64-apple-darwin': 'https://evermeet.cx/ffmpeg/getrelease/ffmpeg/zip',
  'x86_64-unknown-linux-gnu':
    'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-gpl.tar.xz',
  'x86_64-pc-windows-msvc':
    'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip',
};

async function download(url, dest) {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`GET ${url} -> ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
}

function chmodPlusX(p) {
  if (process.platform === 'win32') return;
  try {
    execFileSync('chmod', ['+x', p], { stdio: 'ignore' });
  } catch {
    /* ignore */
  }
}

function walkFind(dir, name) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) {
      const r = walkFind(p, name);
      if (r) return r;
    } else if (ent.name === name) return p;
  }
  return null;
}

async function main() {
  const nodeUrl = NODE_TAR[TRIPLE];
  const ffUrl = FFMPEG_URL[TRIPLE];
  if (!nodeUrl || !ffUrl) {
    console.error(`No bundle mapping for target triple: ${TRIPLE}`);
    process.exit(1);
  }

  const outDir = join(OUT_BASE, TRIPLE);
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  const tmp = join(APP, 'src-tauri', '.bundle-tmp');
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });

  // --- Node ---
  const nodeArchive = join(tmp, TRIPLE.includes('windows') ? 'node.zip' : TRIPLE.includes('linux') ? 'node.txz' : 'node.tgz');
  console.log('Downloading Node.js …', nodeUrl);
  await download(nodeUrl, nodeArchive);

  if (TRIPLE.includes('windows')) {
    execFileSync('powershell', ['-NoProfile', '-Command', `Expand-Archive -Force -Path '${nodeArchive.replace(/'/g, "''")}' -DestinationPath '${tmp.replace(/'/g, "''")}'`], { stdio: 'inherit' });
    const sub = `node-v${NODE_VER}-win-x64`;
    copyFileSync(join(tmp, sub, 'node.exe'), join(outDir, 'node.exe'));
  } else if (TRIPLE.includes('linux')) {
    mkdirSync(join(tmp, 'nx'), { recursive: true });
    execFileSync('tar', ['-xJf', nodeArchive, '-C', join(tmp, 'nx')], { stdio: 'inherit' });
    const sub = readdirSync(join(tmp, 'nx')).find((s) => s.startsWith('node-v'));
    if (!sub) throw new Error('Node archive extract failed (no node-v* dir)');
    copyFileSync(join(tmp, 'nx', sub, 'bin', 'node'), join(outDir, 'node'));
    chmodPlusX(join(outDir, 'node'));
  } else {
    mkdirSync(join(tmp, 'nx'), { recursive: true });
    execFileSync('tar', ['-xzf', nodeArchive, '-C', join(tmp, 'nx')], { stdio: 'inherit' });
    const sub = readdirSync(join(tmp, 'nx')).find((s) => s.startsWith('node-v'));
    if (!sub) throw new Error('Node archive extract failed (no node-v* dir)');
    copyFileSync(join(tmp, 'nx', sub, 'bin', 'node'), join(outDir, 'node'));
    chmodPlusX(join(outDir, 'node'));
  }

  // --- yt-dlp ---
  // IMPORTANT: download the *standalone* per-OS binary (Python embedded), not
  // the plain `yt-dlp` zipapp asset which requires Python 3.10+ on the user's
  // system. macOS ships Xcode Python 3.9, so the zipapp fails to import.
  const ytdlpAsset = TRIPLE.includes('windows')
    ? 'yt-dlp.exe'
    : TRIPLE.includes('apple-darwin')
      ? 'yt-dlp_macos'
      : TRIPLE === 'aarch64-unknown-linux-gnu'
        ? 'yt-dlp_linux_aarch64'
        : 'yt-dlp_linux';
  const ytdlpUrl = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${ytdlpAsset}`;
  const ytdlpDest = join(outDir, TRIPLE.includes('windows') ? 'yt-dlp.exe' : 'yt-dlp');
  console.log('Downloading yt-dlp …', ytdlpUrl);
  await download(ytdlpUrl, ytdlpDest);
  chmodPlusX(ytdlpDest);

  // --- Python (macOS: for one-click Whisper runtime install inside the app) ---
  const pyUrl = PYTHON_TAR[TRIPLE];
  if (pyUrl) {
    const pyArchive = join(tmp, 'python.tgz');
    console.log('Downloading standalone Python …', pyUrl);
    await download(pyUrl, pyArchive);
    // Extract into outDir so bin/python3 -> python3.12 symlinks stay relative (cpSync
    // would preserve absolute symlinks into .bundle-tmp and break after cleanup).
    execFileSync('tar', ['-xzf', pyArchive, '-C', outDir], { stdio: 'inherit' });
    const pyDest = join(outDir, 'python');
    if (!existsSync(pyDest)) throw new Error('Python archive missing python/ directory');
    const pyBin = join(pyDest, 'bin', 'python3.12');
    if (!existsSync(pyBin)) {
      const alt = join(pyDest, 'bin', 'python3');
      if (!existsSync(alt)) throw new Error('python3.12 not found under python/bin');
    }
    chmodPlusX(pyBin);
    const pyLib = join(pyDest, 'lib', 'libpython3.12.dylib');
    if (!existsSync(pyLib)) {
      const libs = readdirSync(join(pyDest, 'lib')).filter((n) => n.startsWith('libpython3'));
      if (libs.length === 0) throw new Error('libpython3.*.dylib not found under python/lib');
      console.log('Bundled python lib:', libs[0]);
    }
    try {
      const arch = execFileSync('file', ['-b', pyBin], { encoding: 'utf8' }).trim();
      console.log('Bundled python3:', arch);
    } catch {
      /* optional */
    }
  }

  // --- FFmpeg ---
  const isMac = TRIPLE.includes('apple-darwin');
  const ffArchive = join(tmp, TRIPLE.includes('windows') || isMac ? 'ff.zip' : 'ff.txz');
  console.log('Downloading FFmpeg …', ffUrl);
  await download(ffUrl, ffArchive);

  if (TRIPLE.includes('windows')) {
    const ffUnzip = join(tmp, 'ffw');
    mkdirSync(ffUnzip, { recursive: true });
    execFileSync('powershell', ['-NoProfile', '-Command', `Expand-Archive -Force -Path '${ffArchive.replace(/'/g, "''")}' -DestinationPath '${ffUnzip.replace(/'/g, "''")}'`], { stdio: 'inherit' });
    const ffmpeg = walkFind(ffUnzip, 'ffmpeg.exe');
    if (!ffmpeg) throw new Error('ffmpeg.exe not found in archive');
    copyFileSync(ffmpeg, join(outDir, 'ffmpeg.exe'));
  } else if (isMac) {
    const ffUnzip = join(tmp, 'ffm');
    mkdirSync(ffUnzip, { recursive: true });
    execFileSync('unzip', ['-q', '-o', ffArchive, '-d', ffUnzip], { stdio: 'inherit' });
    const ffmpeg = walkFind(ffUnzip, 'ffmpeg');
    if (!ffmpeg) throw new Error('ffmpeg not found in evermeet zip');
    copyFileSync(ffmpeg, join(outDir, 'ffmpeg'));
    chmodPlusX(join(outDir, 'ffmpeg'));
    if (TRIPLE === 'aarch64-apple-darwin') {
      try {
        const arch = execFileSync('file', ['-b', join(outDir, 'ffmpeg')], { encoding: 'utf8' }).trim();
        if (!arch.includes('arm64')) {
          throw new Error(`expected arm64 ffmpeg, got: ${arch}`);
        }
      } catch (e) {
        console.error('FFmpeg architecture check failed:', e.message || e);
        process.exit(1);
      }
    }
  } else {
    mkdirSync(join(tmp, 'ffx'), { recursive: true });
    const tarArgs = ffArchive.endsWith('.xz') ? ['-xJf', ffArchive, '-C', join(tmp, 'ffx')] : ['-xf', ffArchive, '-C', join(tmp, 'ffx')];
    execFileSync('tar', tarArgs, { stdio: 'inherit' });
    const ffmpeg = walkFind(join(tmp, 'ffx'), 'ffmpeg');
    if (!ffmpeg) throw new Error('ffmpeg not found in archive');
    copyFileSync(ffmpeg, join(outDir, 'ffmpeg'));
    chmodPlusX(join(outDir, 'ffmpeg'));
  }

  rmSync(tmp, { recursive: true, force: true });
  console.log('Bundled runtimes →', outDir);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
