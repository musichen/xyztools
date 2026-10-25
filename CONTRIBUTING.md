# Contributing to XYZTools

## Setup

Follow the install sections in the [README](README.md), including the Python version and pyenv notes for transcription. The Node entry point is `index.js`:

```bash
npm start        # same as node index.js
npm run transcribe
```

## Test manually

Run the tool on a short public video and confirm the transcript output. If Whisper setup fails, `./fix_whisper_install.sh` recreates the `whisper-env` environment (see Troubleshooting in the README).

Release scripts (`release:collect`, `release:source`, `release:stage`, `release:build`) are maintainer tooling for packaging the Tauri app; you do not need them for a normal change.

## Pull requests

Create a branch from `main`, keep the change focused, and note the video and method you tested with in the PR.
