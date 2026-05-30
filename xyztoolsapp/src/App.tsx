import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useCallback, useEffect, useState } from 'react';
import logoMark from '../assets/logo/xyztools_logo.png';

type WhisperModel = 'tiny' | 'base' | 'small' | 'medium' | 'large';

type WhisperRuntimeStatus = {
  bundledPython: boolean;
  venvReady: boolean;
  modelsDir: string;
  venvDir: string;
};

export default function App() {
  const [urls, setUrls] = useState<string[]>(['']);
  const [outputParent, setOutputParent] = useState('');
  const [mp3, setMp3] = useState(true);
  const [playlist, setPlaylist] = useState(false);
  const [transcript, setTranscript] = useState(true);
  const [markdown, setMarkdown] = useState(false);
  const [whisperModel, setWhisperModel] = useState<WhisperModel>('base');
  const [whisperStatus, setWhisperStatus] = useState<WhisperRuntimeStatus | null>(null);
  const [log, setLog] = useState('');
  const [busy, setBusy] = useState(false);
  const [pickingFolder, setPickingFolder] = useState(false);

  const refreshWhisperStatus = useCallback(async () => {
    try {
      const s = await invoke<WhisperRuntimeStatus>('whisper_runtime_status');
      setWhisperStatus(s);
    } catch {
      setWhisperStatus(null);
    }
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listen<{ line: string }>('job-log', (e) => {
      setLog((prev) => prev + e.payload.line);
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const def = await invoke<string>('default_output_parent');
        setOutputParent((prev) => prev || def);
      } catch {
        /* ignore */
      }
      await refreshWhisperStatus();
    })();
  }, [refreshWhisperStatus]);

  const updateUrl = (i: number, value: string) => {
    setUrls((prev) => prev.map((u, idx) => (idx === i ? value : u)));
  };
  const addUrlRow = () => setUrls((prev) => [...prev, '']);
  const removeUrlRow = (i: number) => {
    setUrls((prev) => (prev.length <= 1 ? [''] : prev.filter((_, idx) => idx !== i)));
  };

  const appendLog = useCallback((s: string) => {
    setLog((prev) => prev + s);
  }, []);

  const pickFolder = async () => {
    if (pickingFolder) return;
    setPickingFolder(true);
    try {
      const picked = await invoke<string | null>('pick_output_folder');
      if (picked) {
        setOutputParent(picked);
      }
    } finally {
      setPickingFolder(false);
    }
  };

  const installWhisperRuntime = async () => {
    setBusy(true);
    setLog('');
    try {
      await invoke('install_whisper_runtime');
      appendLog('\nWhisper runtime install finished.\n');
    } catch (e) {
      appendLog(`\nError: ${String(e)}\n`);
    } finally {
      await refreshWhisperStatus();
      setBusy(false);
    }
  };

  const prefetchModel = async () => {
    setBusy(true);
    setLog('');
    try {
      const dir = await invoke<string>('whisper_models_dir');
      appendLog(`Model cache: ${dir}\n`);
      await invoke('prefetch_whisper_model', { model: whisperModel, cacheDir: dir });
      appendLog(`\nModel "${whisperModel}" weights are cached.\n`);
    } catch (e) {
      appendLog(`\nError: ${String(e)}\n`);
    } finally {
      setBusy(false);
    }
  };

  const run = async () => {
    const cleaned = urls.map((u) => u.trim()).filter(Boolean);
    if (cleaned.length === 0) {
      appendLog('Enter at least one YouTube URL.\n');
      return;
    }
    if (!outputParent.trim()) {
      appendLog('Choose an output folder.\n');
      return;
    }
    if (!mp3 && !playlist && !transcript && !markdown) {
      appendLog('Select at least one output type.\n');
      return;
    }
    setBusy(true);
    setLog('');
    try {
      const cacheDir = await invoke<string>('whisper_models_dir');
      await invoke('run_conversion', {
        payload: {
          youtubeUrls: cleaned,
          outputParent: outputParent.trim(),
          mp3,
          mp3Playlist: playlist,
          transcript: transcript || markdown,
          markdown,
          whisperModel,
          whisperCacheDir: cacheDir,
        },
      });
      appendLog('\n--- Finished ---\n');
    } catch (e) {
      appendLog(`\nError: ${String(e)}\n`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="app">
      <header className="brand">
        <img className="brand-logo" src={logoMark} width={44} height={44} alt="" />
        <div className="brand-text">
          <h1>XYZTools</h1>
          <p className="sub">
            YouTube → MP3, transcripts, and Markdown. yt-dlp, ffmpeg, and Node are bundled in the
            app. Whisper (when captions are unavailable) installs once into app storage — no
            terminal required.
          </p>
        </div>
      </header>

      <div className="card">
        <label>YouTube URLs</label>
        {urls.map((u, i) => (
          <div className="row url-row" key={i} style={{ marginTop: i === 0 ? '0' : '0.5rem' }}>
            <input
              type="url"
              placeholder={i === 0 ? 'https://www.youtube.com/watch?v=…' : 'Another URL…'}
              value={u}
              onChange={(e) => updateUrl(i, e.target.value)}
              disabled={busy}
            />
            <button
              type="button"
              className="btn-icon"
              aria-label="Remove URL"
              title="Remove"
              onClick={() => removeUrlRow(i)}
              disabled={busy || (urls.length === 1 && !u)}
            >
              −
            </button>
          </div>
        ))}
        <div className="row" style={{ marginTop: '0.6rem' }}>
          <button type="button" className="btn-secondary" onClick={addUrlRow} disabled={busy}>
            + Add another URL
          </button>
          <span className="hint">Queued top-to-bottom; each runs through every selected output.</span>
        </div>
      </div>

      <div className="card">
        <label>Output location</label>
        <div className="row" style={{ marginTop: '0.35rem' }}>
          <input type="text" readOnly value={outputParent} placeholder="Pick a folder…" />
          <button
            type="button"
            className="btn-secondary"
            disabled={busy || pickingFolder}
            onClick={() => void pickFolder()}
          >
            {pickingFolder ? 'Opening…' : 'Browse…'}
          </button>
        </div>
        <p className="hint">
          Each video is written under <code>&lt;folder&gt;/output/&lt;title_videoId&gt;/</code> with matching
          basenames for MP3, transcript <code>.txt</code>, and optional <code>.md</code>.
        </p>
      </div>

      <div className="card">
        <label>Outputs</label>
        <div className="row" style={{ marginTop: '0.45rem' }}>
          <label className="check">
            <input type="checkbox" checked={mp3} onChange={(e) => setMp3(e.target.checked)} />
            Single video → MP3
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={playlist}
              onChange={(e) => setPlaylist(e.target.checked)}
            />
            Playlist → MP3s
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={transcript}
              onChange={(e) => {
                const v = e.target.checked;
                setTranscript(v);
                if (!v) setMarkdown(false);
              }}
            />
            Transcript (captions / Whisper; playlist URLs transcribe each video)
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={markdown}
              onChange={(e) => {
                const v = e.target.checked;
                setMarkdown(v);
                if (v) setTranscript(true);
              }}
              disabled={busy}
            />
            Also export Markdown (<code>.md</code>)
          </label>
        </div>
      </div>

      <div className="card">
        <label>Whisper (offline transcription)</label>
        <p className="hint" style={{ marginTop: '0.35rem' }}>
          {whisperStatus?.venvReady
            ? 'Runtime installed — ready when YouTube captions are missing.'
            : 'One-time setup (~1–2 GB): installs into app storage, not system Python.'}
          {whisperStatus && (
            <>
              {' '}
              Bundled Python: {whisperStatus.bundledPython ? 'yes' : 'use system Python'}.
            </>
          )}
        </p>
        <label htmlFor="model" style={{ marginTop: '0.5rem' }}>
          Model size
        </label>
        <select
          id="model"
          value={whisperModel}
          onChange={(e) => setWhisperModel(e.target.value as WhisperModel)}
          disabled={busy}
        >
          {(['tiny', 'base', 'small', 'medium', 'large'] as const).map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
        <div className="row" style={{ marginTop: '0.65rem', flexWrap: 'wrap', gap: '0.5rem' }}>
          <button
            type="button"
            className="btn-secondary"
            disabled={busy || whisperStatus?.venvReady}
            onClick={() => void installWhisperRuntime()}
          >
            {whisperStatus?.venvReady ? 'Whisper installed' : '1. Install Whisper runtime'}
          </button>
          <button type="button" className="btn-secondary" disabled={busy} onClick={() => void prefetchModel()}>
            2. Download model weights
          </button>
        </div>
        <p className="hint">
          Step 1 downloads PyTorch + <code>openai-whisper</code> into{' '}
          <code>~/Library/Application Support/xyztoolsapp/whisper-venv</code>. Step 2 caches the{' '}
          <code>.pt</code> file under <code>whisper-models</code>. Caption-only transcripts skip
          both steps.
        </p>
      </div>

      <div className="row" style={{ marginBottom: '0.75rem' }}>
        <button type="button" className="btn-primary" disabled={busy} onClick={() => void run()}>
          {busy ? 'Running…' : 'Run'}
        </button>
      </div>

      <label>Log</label>
      <div className="log">{log || '…'}</div>
    </div>
  );
}
