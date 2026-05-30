First public release of **XYZTools** — YouTube audio (MP3), playlists, and transcripts from a desktop app or CLI. Bundled Node, yt-dlp, and FFmpeg; Whisper models download on first use.

## What's included

- **Desktop app** (Tauri) — URL, output folder, MP3 / playlist / transcript, Whisper model prefetch
- **CLI** — `pnpm exec xyztools` interactive menu, or `node yttool.js convert …`
- **Installers** per platform below + source archive for building yourself

## What is not bundled

- Whisper **model weights** (downloaded inside the app on first use, ~hundreds of MB per model)
- Whisper **Python runtime** on macOS (optional one-time setup from the app UI)

---

## macOS

| Arch | Installer |
|------|-----------|
| Apple Silicon (arm64) | `XYZTools.arm64.0.0.1.dmg` |
| Intel (x64) | `XYZTools.x64.0.0.1.dmg` *(build on Intel Mac or CI)* |

Open the DMG, drag **XYZTools** to Applications.

---

## Windows

| Type | Installer |
|------|-----------|
| NSIS setup (x64) | `XYZTools_0.0.1_x64-setup.exe` |
| MSI (optional) | `XYZTools-0.0.1-x64.msi` |

---

## Linux

| Format | Package |
|--------|---------|
| Debian/Ubuntu amd64 | `xyztools_0.0.1_amd64.deb` |

```bash
sudo dpkg -i xyztools_0.0.1_amd64.deb
```

---

## Source

| Archive | File |
|---------|------|
| Source zip | `XYZTools-0.0.1-source.zip` |

Build instructions: `xyztoolsapp/docs/BUILD.md`

---

## Verify downloads

Attach `SHA256SUMS` with the release assets, then:

```bash
shasum -a 256 -c SHA256SUMS
```

---

## Changes in 0.0.1

- Initial packaged desktop release (Tauri + React)
- Interactive CLI (`xyztools-cli`)
- Unified `yttool.js` / `yttool.py` for MP3, playlists, and transcripts
- GitHub Actions release workflow for multi-platform installers
