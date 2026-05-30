# XYZTools desktop (`xyztoolsapp/`)

Tauri 2 + React + Vite shell around the same **`yttool.js`** stack as the terminal tools.

- **Build & run:** see [`../xyztoolsapp/docs/BUILD.md`](../xyztoolsapp/docs/BUILD.md)
- **UI ↔ Rust ↔ Node:** see [`../xyztoolsapp/docs/ARCHITECTURE.md`](../xyztoolsapp/docs/ARCHITECTURE.md)
- **Publishing:** copy installers into [`../release/`](../release/) (see [`../release/README.md`](../release/README.md))

Design reference: **`voicebox/`** (Tauri desktop, local model paths). XYZTools does not bundle Qwen; it reuses **Whisper** weights under an app-local cache directory plus the repo **`whisper-env`** Python.
