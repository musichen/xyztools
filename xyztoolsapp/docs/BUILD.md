# XYZTools desktop (Tauri)

## What ships in a release

Production `pnpm tauri build` runs, in order:

1. **`node scripts/bundle-runtimes.mjs`** — downloads **Node.js**, **yt-dlp**, and **FFmpeg** for the current Rust target into `src-tauri/resources/runtime/<target-triple>/`. Requires network at **build** time only. **macOS Apple Silicon** FFmpeg comes from [osxexperts.net](https://www.osxexperts.net/) (native arm64); **macOS Intel** uses [evermeet.cx](https://evermeet.cx/ffmpeg/) (evermeet does not ship arm64 — see their [Apple Silicon note](https://evermeet.cx/ffmpeg/apple-silicon-arm)). **Linux/Windows** use [BtbN FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds).
2. **`node scripts/sync-toolkit.mjs`** — copies `index.js`, `yttool.js`, `whisper_transcribe.py`, and root `package.json` into `src-tauri/resources/toolkit/`, then runs `npm install --omit=dev` (Puppeteer browser download skipped).
3. **`pnpm run build`** — Vite frontend.

**Whisper weight files are not bundled** (they are large). End users download them on first use (see below) or place them in the cache directory manually.

## Prerequisites (developers building installers)

- **Rust** (stable) and **Cargo** — [rustup](https://rustup.rs/)
- **pnpm** (workspace uses `pnpm@10`)
- **Network** for the pre-build download step
- **tar** (macOS/Linux) and, on Windows, **PowerShell** with `Expand-Archive` for extracting archives

**End users** of the built DMG / MSI / AppImage / `.deb` do **not** need Node, yt-dlp, or ffmpeg on PATH; the app uses the bundled copies under `Resources` (platform-specific layout).

## Development

### Run the full Tauri desktop app (recommended)

Hot-reload UI + native Rust commands:

```bash
pnpm install                     # at the monorepo root
cd xyztoolsapp
pnpm tauri dev                   # opens the desktop window
```

The Rust backend looks for `yttool.js` (and friends) in this order:

1. **`XYZTOOLS_TOOLKIT_DIR`** — absolute path to a folder containing `yttool.js` (override).
2. **`resource_dir()/toolkit`** — populated only after a production build (`pnpm tauri build`).
3. **Monorepo root** — two levels above `xyztoolsapp/src-tauri` (default dev fallback).

In dev mode you still need **Node**, **yt-dlp**, **ffmpeg** on PATH (these are only bundled when running a real release build). For Whisper-based transcription, install **`openai-whisper`** as below.

### Browser-only UI preview (no Rust commands)

Useful for tweaking layout/styles only:

```bash
cd xyztoolsapp
pnpm dev                         # Vite at http://localhost:1420
```

`pick_output_folder`, `prefetch_whisper_model`, and `run_conversion` are Tauri commands and will throw `window.__TAURI__ undefined` in a normal browser — use `pnpm tauri dev` to exercise them.

### Debug release build (signed-style installer, faster than full release)

```bash
cd xyztoolsapp
pnpm tauri build --debug         # produces a debug .app/.dmg/.AppImage
```

### Whisper for end users (no terminal)

Release builds on **macOS** bundle a standalone `python3` next to `node` / `yt-dlp` / `ffmpeg`. In the app:

1. **Install Whisper runtime** — creates `~/Library/Application Support/xyztoolsapp/whisper-venv` and pip-installs `openai-whisper` + PyTorch (~1–2 GB, one-time, needs internet).
2. **Download model weights** — caches the `.pt` file under `whisper-models` (no Python required for this step).

During conversion, XYZTools sets `XYZTOOLS_PYTHON` to the app venv when step 1 succeeded. **Caption transcripts** often work without either step.

Developers can still use repo `whisper-env` or system Python; `yttool.js` honors `XYZTOOLS_PYTHON` first.

## Production build

```bash
cd xyztoolsapp
pnpm install
pnpm tauri build
```

Artifacts appear under `xyztoolsapp/src-tauri/target/release/bundle/`. Large downloaded folders (`resources/runtime`, `resources/toolkit`) are gitignored; CI or release machines recreate them on each build.

### macOS DMG step (`bundle_dmg.sh`) failed

Tauri’s DMG step runs AppleScript (Finder layout) and `hdiutil`. Failures are often **transient** and the CLI hides the shell script’s stderr.

1. Re-run with logs: `pnpm exec tauri build --verbose` (or `pnpm tauri build --verbose`).
2. Ensure enough **free disk space** (the RW image can be hundreds of MB before compression).
3. Remove stale intermediates and retry (zsh-safe — globs that match nothing do not error):

   ```bash
   rm -rf src-tauri/target/release/bundle/dmg
   find src-tauri/target/release/bundle/macos -maxdepth 1 -name 'rw.*.dmg' -delete 2>/dev/null
   pnpm tauri build
   ```

4. Quit other **hdiutil** / **Disk Image Mounter** jobs if a previous run was interrupted.

#### `hdiutil: couldn't unmount "diskN" - Resource busy`

The DMG builder mounts a **temporary** volume under `/Volumes/dmg.*`. If anything keeps that volume open, unmount fails and the whole DMG step aborts.

**Do this, then rebuild:**

1. **Close Finder windows** that show the grey `dmg.*` volume (or eject it from the sidebar).
2. **Quit Quick Look** if a preview from that volume is open (`⌘W`).
3. **List and force-unmount** leftover Tauri temp volumes (names look like `dmg.64UVU1`):

   ```bash
   ls /Volumes | grep '^dmg\.'
   diskutil unmount force "/Volumes/dmg.XXXXXX"   # replace with the name you see
   ```

   If it still sticks, find the device and detach:

   ```bash
   diskutil list
   hdiutil detach -force /dev/disk5    # use the disk identifier from diskutil list, not blindly disk5
   ```

4. **Retry** `pnpm tauri build` (or wait ~30s and retry — sometimes `mds` / Spotlight briefly locks the volume).

**Skip the DMG** and only produce `XYZTools.app` (same binaries, no `bundle_dmg.sh`):

```bash
cd xyztoolsapp
pnpm run tauri:build:app          # alias: pnpm exec tauri build -b app
```

The `.app` ends up under `src-tauri/target/release/bundle/macos/XYZTools.app`. Add a DMG later with `pnpm run tauri:build:dmg` when nothing is using `/Volumes/dmg.*`.

The bundle **identifier** must not end with `.app` (Tauri warns about that); this project uses `app.xyztools.xyztools` in `tauri.conf.json`.

### Supported bundle targets (runtimes script)

The download map includes: `aarch64-apple-darwin`, `x86_64-apple-darwin`, `x86_64-unknown-linux-gnu`, `x86_64-pc-windows-msvc`. Add more triples in `scripts/bundle-runtimes.mjs` if you cross-compile to other hosts.

## Whisper models (not in the DMG)

Weight files are downloaded **directly** by the Rust backend (no Python required) from OpenAI's public CDN — the exact same URLs and SHA-256s that `openai-whisper`'s `whisper.load_model()` uses internally. Files are stored at `{cache}/{model}.pt`, so when Python `openai-whisper` later loads the model it finds the cache hit and skips re-downloading.

Default cache directory (also exported as `WHISPER_DOWNLOAD_ROOT` during conversion):

- **macOS:** `~/Library/Application Support/xyztoolsapp/whisper-models` (via `dirs::data_local_dir()`)
- **Linux:** `~/.local/share/xyztoolsapp/whisper-models`
- **Windows:** `%LOCALAPPDATA%\xyztoolsapp\whisper-models`

Supported model names (matching `whisper.available_models()`): `tiny`, `tiny.en`, `base`, `base.en`, `small`, `small.en`, `medium`, `medium.en`, `large-v1`, `large-v2`, `large-v3`, `large` (alias of `large-v3`), `large-v3-turbo`, `turbo`.

**Transcription** uses the app-local venv when installed (see above), or dev `whisper-env` / system Python. Model prefetch only downloads weights. **Ollama** / whisper.cpp are not integrated in this shell yet.

## Environment variables

| Variable | Purpose |
|----------|---------|
| `XYZTOOLS_TOOLKIT_DIR` | Absolute path to folder containing `yttool.js` (dev override) |

Child **Node** processes receive:

| Variable | Purpose |
|----------|---------|
| `YTTOOL_ROOT` | Toolkit root (`yttool.js` resolves `index.js` / `whisper_transcribe.py`) |
| `YT_DLP_PATH` | Bundled `yt-dlp` binary when present |
| `XYZTOOLS_FFMPEG_PATH` | Bundled `ffmpeg` binary when present |
| `XYZTOOLS_OUTPUT_DIR` | Absolute `…/output` under the user-chosen folder |
| `XYZTOOLS_WHISPER_MODEL` | e.g. `base`, `medium` |
| `WHISPER_DOWNLOAD_ROOT` | Whisper weight cache directory |

## Reference project

**voicebox** (`../voicebox/`) — Tauri 2 + React patterns. XYZTools bundles a **Node + yt-dlp + ffmpeg** runtime instead of a single sidecar binary.
