# Releases (GitHub-style)

This folder mirrors how [VSCodium publishes releases](https://github.com/VSCodium/vscodium/releases): **versioned installers + source archive + checksums**, staged locally before you attach them to a GitHub Release.

**Do not commit large binaries.** Only docs and empty `assets/` are tracked; built files land in `release/assets/` (gitignored).

## Layout

```
release/
  VERSION                 # current release (0.0.1)
  README.md               # this file
  RELEASE_NOTES.md        # copy into GitHub release description
  assets/                 # staging (gitignored except .gitkeep)
    XYZTools.arm64.0.0.1.dmg
    XYZTools_0.0.1_x64-setup.exe
    xyztools_0.0.1_amd64.deb
    XYZTools-0.0.1-source.zip
    SHA256SUMS
```

## Build pipeline

### 1. Build installers (on each OS, or CI)

```bash
pnpm install
cd xyztoolsapp
pnpm tauri build
```

Artifacts are created under `xyztoolsapp/src-tauri/target/release/bundle/` (`.dmg`, `.deb`, `.exe` / `.msi`, `.AppImage`).

### 2. Stage into `release/assets/`

From the **repository root**:

```bash
pnpm run release:collect
```

Copies bundle outputs into `release/assets/` with stable names and writes `SHA256SUMS`.

### 3. Source archive (any OS, needs git)

```bash
pnpm run release:source
```

Produces `XYZTools-<version>-source.zip` from `git archive` (respects `.gitattributes` `export-ignore` — no `node_modules`, secrets, or machine-local snapshots).

### 4. Full stage

```bash
pnpm run release:stage
```

Runs collect (if bundles exist) + source zip.

### 5. Publish on GitHub

1. Tag: `git tag v0.0.1 && git push origin v0.0.1`
2. **Releases → New release** → tag `v0.0.1`
3. Paste `release/RELEASE_NOTES.md` as the description
4. Upload everything in `release/assets/`
5. Attach `SHA256SUMS` for verification

## Expected asset names (0.0.1)

| Platform | Artifact |
|----------|----------|
| macOS arm64 | `XYZTools.arm64.0.0.1.dmg` |
| macOS x64 | `XYZTools.x64.0.0.1.dmg` |
| Windows | `XYZTools_0.0.1_x64-setup.exe` (and/or `XYZTools-0.0.1-x64.msi`) |
| Linux | `xyztools_0.0.1_amd64.deb` |
| Source | `XYZTools-0.0.1-source.zip` |

Build each platform on its native OS (or use GitHub Actions matrix) — you cannot produce a `.dmg` on Linux without cross-compilation tooling.

**v0.0.1 local status:** macOS arm64 DMG staged in `release/assets/` after `pnpm run release:build` on Apple Silicon. Windows `.exe` and Linux `.deb` are produced by the Release workflow when you push tag `v0.0.1`.

## Verify checksums

```bash
cd release/assets
shasum -a 256 -c SHA256SUMS
```

## What users should get

Published assets are **installers and source only** — reusable on other machines without your dev paths, caches, or secrets. Never upload `output/`, `node_modules/`, `target/`, `.env`, or local snapshot docs.
