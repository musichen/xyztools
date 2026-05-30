# XYZTools desktop (`xyztoolsapp/`)

Tauri 2 + React + Vite shell around the same **`yttool.js`** stack as the terminal tools.

- **Build & run:** see [`../xyztoolsapp/docs/BUILD.md`](../xyztoolsapp/docs/BUILD.md)
- **UI ↔ Rust ↔ Node:** see [`../xyztoolsapp/docs/ARCHITECTURE.md`](../xyztoolsapp/docs/ARCHITECTURE.md)
- **Publishing:** copy installers into [`../release/`](../release/) (see [`../release/README.md`](../release/README.md))

Whisper model weights are not bundled in the installer; they download on first use into an app-local cache. Developers can also use the repo **`whisper-env`** Python environment.
