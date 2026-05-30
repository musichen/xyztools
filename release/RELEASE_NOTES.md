# XYZTools 0.0.1

First packaged release of the **XYZTools** desktop app (Tauri): YouTube → MP3, playlists, and transcripts with bundled Node, yt-dlp, and FFmpeg.

## Install

| Platform | File | Notes |
|----------|------|--------|
| **macOS** (Apple Silicon) | `XYZTools.arm64.0.0.1.dmg` | Open DMG, drag **XYZTools** to Applications |
| **macOS** (Intel) | `XYZTools.x64.0.0.1.dmg` | Same as above |
| **Windows** | `XYZTools_0.0.1_x64-setup.exe` | Run installer (NSIS) |
| **Windows** (optional) | `XYZTools-0.0.1-x64.msi` | MSI if built on Windows |
| **Linux** | `xyztools_0.0.1_amd64.deb` | `sudo dpkg -i xyztools_0.0.1_amd64.deb` |
| **Source** | `XYZTools-0.0.1-source.zip` | Build yourself — see `xyztoolsapp/docs/BUILD.md` |

Verify downloads with `SHA256SUMS` in this folder.

## What is not bundled

- **Whisper model weights** — downloaded on first use inside the app (~hundreds of MB per model).
- **Whisper Python runtime** — optional one-time install from the app UI on macOS.

## Changes

- Initial desktop release layout and installers (build on each OS to produce platform artifacts).
