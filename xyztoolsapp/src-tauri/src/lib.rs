use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::Write;
use std::path::PathBuf;
use std::process::Stdio;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::oneshot;

/// Rust build target (matches `resources/runtime/<triple>/` from bundle-runtimes.mjs).
const BUILD_TARGET: &str = include_str!(concat!(env!("OUT_DIR"), "/target_triple.txt"));

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunJob {
    /// One or more YouTube URLs (processed sequentially). Empty entries are skipped.
    pub youtube_urls: Vec<String>,
    pub output_parent: String,
    pub mp3: bool,
    pub mp3_playlist: bool,
    pub transcript: bool,
    /// When true, transcript phase also writes a `.md` next to `.txt` (caption path + Whisper).
    pub markdown: bool,
    pub whisper_model: String,
    pub whisper_cache_dir: Option<String>,
}

#[derive(Clone, Serialize)]
struct LogLine {
    line: String,
}

/// Monorepo root (dev): two levels above `src-tauri`.
fn dev_repo_root() -> Result<PathBuf, String> {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let repo = manifest_dir
        .parent()
        .and_then(|p| p.parent())
        .ok_or("could not resolve dev repo root")?;
    repo.canonicalize().map_err(|e| e.to_string())
}

fn toolkit_from_resources(app: &AppHandle) -> Option<PathBuf> {
    let dir = app.path().resource_dir().ok()?;
    // Tauri preserves the `resources/` prefix from tauri.conf.json inside the .app/Resources,
    // so the real path is `Resources/resources/toolkit/`. Older layouts (or future config tweaks)
    // might drop that prefix, so probe both for robustness.
    for candidate in [dir.join("resources").join("toolkit"), dir.join("toolkit")] {
        if candidate.join("yttool.js").is_file() {
            return candidate.canonicalize().ok();
        }
    }
    None
}

fn toolkit_root(app: &AppHandle) -> Result<PathBuf, String> {
    if let Ok(p) = std::env::var("XYZTOOLS_TOOLKIT_DIR") {
        let pb = PathBuf::from(p.trim());
        if pb.join("yttool.js").is_file() {
            return pb.canonicalize().map_err(|e| e.to_string());
        }
    }
    if let Some(t) = toolkit_from_resources(app) {
        return Ok(t);
    }
    let dev = dev_repo_root()?;
    if dev.join("yttool.js").is_file() {
        return Ok(dev);
    }
    Err(
        "Could not find toolkit (yttool.js). Run a production build or set XYZTOOLS_TOOLKIT_DIR.".into(),
    )
}

fn bundled_runtime_dir(app: &AppHandle) -> Option<PathBuf> {
    let res = app.path().resource_dir().ok()?;
    let node_name = if cfg!(windows) { "node.exe" } else { "node" };
    for base in [res.join("resources").join("runtime"), res.join("runtime")] {
        let d = base.join(BUILD_TARGET);
        if d.join(node_name).is_file() {
            return Some(d);
        }
    }
    None
}

fn bundled_node(app: &AppHandle) -> Option<PathBuf> {
    let d = bundled_runtime_dir(app)?;
    Some(d.join(if cfg!(windows) { "node.exe" } else { "node" }))
}

fn bundled_ytdlp(app: &AppHandle) -> Option<PathBuf> {
    let d = bundled_runtime_dir(app)?;
    let p = d.join(if cfg!(windows) { "yt-dlp.exe" } else { "yt-dlp" });
    p.is_file().then_some(p)
}

fn bundled_ffmpeg(app: &AppHandle) -> Option<PathBuf> {
    let d = bundled_runtime_dir(app)?;
    let p = d.join(if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" });
    p.is_file().then_some(p)
}

/// Standalone CPython shipped next to node (macOS bundles from bundle-runtimes.mjs).
fn bundled_python(app: &AppHandle) -> Option<PathBuf> {
    let d = bundled_runtime_dir(app)?;
    for p in [
        d.join("python").join("bin").join("python3.12"),
        d.join("python").join("bin").join(if cfg!(windows) {
            "python.exe"
        } else {
            "python3"
        }),
        d.join(if cfg!(windows) {
            "python3.exe"
        } else {
            "python3"
        }),
    ] {
        if p.is_file() {
            return Some(p);
        }
    }
    None
}

fn bundled_python_tree(app: &AppHandle) -> Option<PathBuf> {
    let d = bundled_runtime_dir(app)?;
    let tree = d.join("python");
    tree.is_dir().then_some(tree)
}

fn app_support_dir() -> Result<PathBuf, String> {
    let base = dirs::data_local_dir().ok_or("data_local_dir unavailable")?;
    let d = base.join("xyztoolsapp");
    std::fs::create_dir_all(&d).map_err(|e| e.to_string())?;
    Ok(d)
}

fn whisper_venv_dir() -> Result<PathBuf, String> {
    Ok(app_support_dir()?.join("whisper-venv"))
}

fn venv_python_exe(venv: &std::path::Path) -> PathBuf {
    if cfg!(windows) {
        venv.join("Scripts").join("python.exe")
    } else {
        venv.join("bin").join("python3")
    }
}

fn venv_pip_exe(venv: &std::path::Path) -> PathBuf {
    if cfg!(windows) {
        venv.join("Scripts").join("pip.exe")
    } else {
        venv.join("bin").join("pip3")
    }
}

fn whisper_import_ok(py: &std::path::Path) -> bool {
    std::process::Command::new(py)
        .args(["-c", "import whisper"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

fn resolve_python_for_venv(app: &AppHandle) -> Result<PathBuf, String> {
    if let Some(p) = bundled_python(app) {
        return Ok(p);
    }
    which::which(if cfg!(windows) { "python" } else { "python3" })
        .or_else(|_| which::which("python3.12"))
        .map_err(|_| {
            "Python not found. Rebuild XYZTools (macOS bundle includes python3) or install Python 3.12+."
                .into()
        })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WhisperRuntimeStatus {
    pub bundled_python: bool,
    pub venv_ready: bool,
    pub models_dir: String,
    pub venv_dir: String,
}

#[tauri::command]
fn whisper_runtime_status(app: AppHandle) -> Result<WhisperRuntimeStatus, String> {
    let venv = whisper_venv_dir()?;
    let py = venv_python_exe(&venv);
    let models = whisper_models_dir()?;
    Ok(WhisperRuntimeStatus {
        bundled_python: bundled_python(&app).is_some(),
        venv_ready: py.is_file() && whisper_import_ok(&py),
        models_dir: models,
        venv_dir: venv.to_string_lossy().to_string(),
    })
}

async fn run_logged_command(app: &AppHandle, mut cmd: Command) -> Result<(), String> {
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| format!("spawn failed: {e}"))?;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let app_out = app.clone();
    let app_err = app.clone();
    let h_out = tokio::spawn(async move {
        if let Some(out) = stdout {
            drain_reader(app_out, out).await;
        }
    });
    let h_err = tokio::spawn(async move {
        if let Some(err) = stderr {
            drain_reader(app_err, err).await;
        }
    });
    let status = child.wait().await.map_err(|e| e.to_string())?;
    let _ = h_out.await;
    let _ = h_err.await;
    if status.success() {
        Ok(())
    } else {
        Err(format!("command exited with code {}", status.code().unwrap_or(-1)))
    }
}

/// Create app-local venv and pip-install openai-whisper (one-time, ~1–2 GB download).
#[tauri::command]
async fn install_whisper_runtime(app: AppHandle) -> Result<(), String> {
    let base_py = resolve_python_for_venv(&app)?;
    let venv = whisper_venv_dir()?;
    let venv_py = venv_python_exe(&venv);

    if venv_py.is_file() && whisper_import_ok(&venv_py) {
        emit_log(&app, "Whisper runtime already installed.\n").await;
        return Ok(());
    }

    emit_log(
        &app,
        &format!(
            "Installing Whisper runtime (one-time)…\n  Python: {}\n  Venv:   {}\n",
            base_py.display(),
            venv.display()
        ),
    )
    .await;
    emit_log(
        &app,
        "This downloads PyTorch + openai-whisper (~1–2 GB). Use Wi‑Fi if possible.\n\n",
    )
    .await;

    if venv.exists() {
        emit_log(&app, "Removing previous incomplete venv…\n").await;
        std::fs::remove_dir_all(&venv).map_err(|e| e.to_string())?;
    }
    std::fs::create_dir_all(&venv).map_err(|e| e.to_string())?;

    #[cfg(target_os = "macos")]
    {
        let xattr_targets: Vec<PathBuf> = bundled_python_tree(&app)
            .into_iter()
            .chain(std::iter::once(base_py.clone()))
            .collect();
        for target in xattr_targets {
            let _ = std::process::Command::new("xattr")
                .args([
                    "-dr",
                    "com.apple.quarantine",
                    target.to_string_lossy().as_ref(),
                ])
                .status();
        }
    }

    emit_log(&app, "Creating virtual environment…\n").await;
    let mut venv_cmd = Command::new(&base_py);
    venv_cmd.args(["-m", "venv"]).arg(&venv);
    run_logged_command(&app, venv_cmd).await?;

    let pip = venv_pip_exe(&venv);
    if !pip.is_file() {
        return Err(format!("pip not found at {}", pip.display()));
    }

    emit_log(&app, "Upgrading pip…\n").await;
    let mut pip_up = Command::new(&pip);
    pip_up.args(["install", "--upgrade", "pip"]);
    run_logged_command(&app, pip_up).await?;

    emit_log(&app, "Installing openai-whisper (this can take several minutes)…\n").await;
    let mut pip_whisper = Command::new(&pip);
    pip_whisper.args(["install", "openai-whisper"]);
    run_logged_command(&app, pip_whisper).await?;

    if !whisper_import_ok(&venv_py) {
        return Err("Install finished but `import whisper` failed.".into());
    }

    emit_log(
        &app,
        "Whisper runtime ready. Use “Download model weights” for the .pt file, then run transcripts.\n",
    )
    .await;
    Ok(())
}

fn resolve_node(app: &AppHandle) -> Result<PathBuf, String> {
    if let Some(p) = bundled_node(app) {
        return Ok(p);
    }
    // GUI-launched .app processes on macOS do not inherit the user shell PATH, so common
    // Homebrew locations are invisible to `which`. Probe a few before failing.
    if let Ok(p) = which::which("node") {
        return Ok(p);
    }
    for candidate in [
        "/opt/homebrew/bin/node",
        "/usr/local/bin/node",
        "/usr/bin/node",
    ] {
        let pb = PathBuf::from(candidate);
        if pb.is_file() {
            return Ok(pb);
        }
    }
    Err(format!(
        "Node.js not found. Looked for the bundled runtime under resources/runtime/{BUILD_TARGET}/node \
         and on PATH (including /opt/homebrew/bin, /usr/local/bin). Rebuild the app or install Node."
    ))
}

async fn emit_log(app: &AppHandle, s: &str) {
    let _ = app.emit(
        "job-log",
        LogLine {
            line: s.to_string(),
        },
    );
}

async fn drain_reader(app: AppHandle, r: impl tokio::io::AsyncRead + Unpin) {
    let mut reader = BufReader::new(r);
    let mut line = String::new();
    loop {
        line.clear();
        match reader.read_line(&mut line).await {
            Ok(0) => break,
            Ok(_) => emit_log(&app, &line).await,
            Err(_) => break,
        }
    }
}

async fn run_node_phase(
    app: AppHandle,
    toolkit: &std::path::Path,
    cwd: &std::path::Path,
    url: &str,
    format: &str,
    env_extra: &[(&str, &str)],
    phase_env: &[(&str, &str)],
) -> Result<i32, String> {
    let node = resolve_node(&app)?;
    let script = toolkit.join("yttool.js");
    let mut cmd = Command::new(&node);
    cmd.arg(&script)
        .args(["convert", url, "--format", format])
        .current_dir(cwd)
        .env("YTTOOL_ROOT", toolkit)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    if let Some(p) = bundled_ytdlp(&app) {
        cmd.env("YT_DLP_PATH", &p);
    }
    if let Some(p) = bundled_ffmpeg(&app) {
        cmd.env("XYZTOOLS_FFMPEG_PATH", &p);
    }

    for (k, v) in env_extra {
        cmd.env(k, v);
    }
    for (k, v) in phase_env {
        cmd.env(k, v);
    }

    let mut child = cmd.spawn().map_err(|e| format!("spawn failed: {e}"))?;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let app_out = app.clone();
    let app_err = app.clone();
    let h_out = tokio::spawn(async move {
        if let Some(out) = stdout {
            drain_reader(app_out, out).await;
        }
    });
    let h_err = tokio::spawn(async move {
        if let Some(err) = stderr {
            drain_reader(app_err, err).await;
        }
    });
    let status = child.wait().await.map_err(|e| e.to_string())?;
    let _ = h_out.await;
    let _ = h_err.await;
    Ok(status.code().unwrap_or(-1))
}

/// Folder picker: use non-blocking `pick_folder` + oneshot (not `blocking_pick_folder` on IPC),
/// which can break macOS event routing and look like a dialog loop.
#[tauri::command]
async fn pick_output_folder(app: AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = oneshot::channel::<Option<String>>();
    app.dialog()
        .file()
        .set_title("Choose output folder")
        .pick_folder(move |folder| {
            let _ = tx.send(folder.map(|p| p.to_string()));
        });
    let folder = rx
        .await
        .map_err(|_| "Folder picker closed unexpectedly.".to_string())?;
    Ok(folder)
}

/// Sensible default for the "Output location" picker, per OS conventions:
/// macOS / Windows / Linux Downloads folder, falling back to the home directory.
#[tauri::command]
fn default_output_parent() -> Result<String, String> {
    let p = dirs::download_dir()
        .or_else(dirs::home_dir)
        .ok_or_else(|| "Could not resolve a default output folder.".to_string())?;
    Ok(p.to_string_lossy().to_string())
}

#[tauri::command]
fn whisper_models_dir() -> Result<String, String> {
    let base = dirs::data_local_dir().ok_or("data_local_dir unavailable")?;
    let d = base.join("xyztoolsapp").join("whisper-models");
    std::fs::create_dir_all(&d).map_err(|e| e.to_string())?;
    Ok(d.to_string_lossy().to_string())
}

/// Official Whisper model URLs (mirrors `whisper/__init__.py::_MODELS`).
/// SHA-256 is the second-last URL segment; we verify it after download.
fn whisper_model_url(name: &str) -> Option<&'static str> {
    match name {
        "tiny.en" => Some("https://openaipublic.azureedge.net/main/whisper/models/d3dd57d32accea0b295c96e26691aa14d8822fac7d9d27d5dc00b4ca2826dd03/tiny.en.pt"),
        "tiny" => Some("https://openaipublic.azureedge.net/main/whisper/models/65147644a518d12f04e32d6f3b26facc3f8dd46e5390956a9424a650c0ce22b9/tiny.pt"),
        "base.en" => Some("https://openaipublic.azureedge.net/main/whisper/models/25a8566e1d0c1e2231d1c762132cd20e0f96a85d16145c3a00adf5d1ac670ead/base.en.pt"),
        "base" => Some("https://openaipublic.azureedge.net/main/whisper/models/ed3a0b6b1c0edf879ad9b11b1af5a0e6ab5db9205f891f668f8b0e6c6326e34e/base.pt"),
        "small.en" => Some("https://openaipublic.azureedge.net/main/whisper/models/f953ad0fd29cacd07d5a9eda5624af0f6bcf2258be67c92b79389873d91e0872/small.en.pt"),
        "small" => Some("https://openaipublic.azureedge.net/main/whisper/models/9ecf779972d90ba49c06d968637d720dd632c55bbf19d441fb42bf17a411e794/small.pt"),
        "medium.en" => Some("https://openaipublic.azureedge.net/main/whisper/models/d7440d1dc186f76616474e0ff0b3b6b879abc9d1a4926b7adfa41db2d497ab4f/medium.en.pt"),
        "medium" => Some("https://openaipublic.azureedge.net/main/whisper/models/345ae4da62f9b3d59415adc60127b97c714f32e89e936602e85993674d08dcb1/medium.pt"),
        "large-v1" => Some("https://openaipublic.azureedge.net/main/whisper/models/e4b87e7e0bf463eb8e6956e646f1e277e901512310def2c24bf0e11bd3c28e9a/large-v1.pt"),
        "large-v2" => Some("https://openaipublic.azureedge.net/main/whisper/models/81f7c96c852ee8fc832187b0132e569d6c3065a3252ed18e56effd0b6a73e524/large-v2.pt"),
        "large-v3" | "large" => Some("https://openaipublic.azureedge.net/main/whisper/models/e5b1a55b89c1367dacf97e3e19bfd829a01529dbfdeefa8caeb59b3f1b81dadb/large-v3.pt"),
        "large-v3-turbo" | "turbo" => Some("https://openaipublic.azureedge.net/main/whisper/models/aff26ae408abcba5fbf8813c21e62b0941638c5f6eebfb145be0c9839262a19a/large-v3-turbo.pt"),
        _ => None,
    }
}

fn human_bytes(n: u64) -> String {
    const UNITS: [&str; 5] = ["B", "KiB", "MiB", "GiB", "TiB"];
    let mut v = n as f64;
    let mut u = 0;
    while v >= 1024.0 && u < UNITS.len() - 1 {
        v /= 1024.0;
        u += 1;
    }
    format!("{:.1} {}", v, UNITS[u])
}

/// Prefetch a Whisper checkpoint by downloading the official `.pt` directly
/// (no Python required). Stored exactly where `openai-whisper` expects it
/// (`{cache_dir}/{model}.pt`), so later transcription reuses the file.
#[tauri::command]
async fn prefetch_whisper_model(
    app: AppHandle,
    model: String,
    cache_dir: String,
) -> Result<(), String> {
    let url = whisper_model_url(&model).ok_or_else(|| {
        format!(
            "Unknown Whisper model '{model}'. Supported: tiny, base, small, medium, large-v3, turbo (+ .en variants)."
        )
    })?;
    let expected_sha = url
        .split('/')
        .rev()
        .nth(1)
        .ok_or_else(|| "Malformed Whisper URL".to_string())?
        .to_string();
    let filename = url
        .rsplit('/')
        .next()
        .ok_or_else(|| "Malformed Whisper URL".to_string())?
        .to_string();

    let cache_root = PathBuf::from(&cache_dir);
    std::fs::create_dir_all(&cache_root).map_err(|e| e.to_string())?;
    let dest = cache_root.join(&filename);

    emit_log(
        &app,
        &format!("Whisper prefetch: {model}\n  cache: {}\n  url:   {url}\n", cache_root.display()),
    )
    .await;

    if dest.is_file() {
        emit_log(&app, "Existing file found; verifying SHA-256…\n").await;
        if file_sha256(&dest).await? == expected_sha {
            emit_log(&app, &format!("Already cached & verified: {}\n", dest.display())).await;
            return Ok(());
        }
        emit_log(&app, "Checksum mismatch — re-downloading.\n").await;
    }

    let tmp = dest.with_extension("pt.part");
    let _ = std::fs::remove_file(&tmp);

    let client = reqwest::Client::builder()
        .user_agent("xyztoolsapp/0.1 (+desktop)")
        .build()
        .map_err(|e| format!("HTTP client error: {e}"))?;

    let mut resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("Network error: {e}. Check internet connection."))?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {} downloading model.", resp.status()));
    }
    let total = resp.content_length().unwrap_or(0);
    emit_log(
        &app,
        &format!("Downloading… ({} expected)\n", if total > 0 { human_bytes(total) } else { "size unknown".into() }),
    )
    .await;

    let mut file = std::fs::File::create(&tmp).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    let mut got: u64 = 0;
    let mut last_step: u64 = 0;
    while let Some(chunk) = resp
        .chunk()
        .await
        .map_err(|e| format!("Network error during download: {e}"))?
    {
        file.write_all(&chunk).map_err(|e| e.to_string())?;
        hasher.update(&chunk);
        got += chunk.len() as u64;
        if total > 0 {
            let pct = ((got * 100) / total).min(100);
            if pct >= last_step + 5 || pct == 100 {
                last_step = pct - (pct % 5);
                emit_log(
                    &app,
                    &format!("  {pct:>3}%  ({} / {})\n", human_bytes(got), human_bytes(total)),
                )
                .await;
            }
        } else if got - last_step >= 4 * 1024 * 1024 {
            last_step = got;
            emit_log(&app, &format!("  {}\n", human_bytes(got))).await;
        }
    }
    drop(file);

    let actual = format!("{:x}", hasher.finalize());
    if actual != expected_sha {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!(
            "SHA-256 mismatch after download (expected {expected_sha}, got {actual}). Please try again."
        ));
    }
    std::fs::rename(&tmp, &dest).map_err(|e| e.to_string())?;
    emit_log(
        &app,
        &format!("Whisper model ready: {}\n", dest.display()),
    )
    .await;
    Ok(())
}

async fn file_sha256(path: &std::path::Path) -> Result<String, String> {
    let path = path.to_path_buf();
    tokio::task::spawn_blocking(move || -> Result<String, String> {
        let mut f = std::fs::File::open(&path).map_err(|e| e.to_string())?;
        let mut hasher = Sha256::new();
        let mut buf = [0u8; 64 * 1024];
        loop {
            let n = std::io::Read::read(&mut f, &mut buf).map_err(|e| e.to_string())?;
            if n == 0 {
                break;
            }
            hasher.update(&buf[..n]);
        }
        Ok(format!("{:x}", hasher.finalize()))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn run_conversion(app: AppHandle, payload: RunJob) -> Result<(), String> {
    let toolkit = toolkit_root(&app)?;
    let out_parent = PathBuf::from(&payload.output_parent);
    std::fs::create_dir_all(&out_parent).map_err(|e| e.to_string())?;
    let output_dir = out_parent.join("output");
    std::fs::create_dir_all(&output_dir).map_err(|e| e.to_string())?;
    let out_str = output_dir.to_string_lossy().to_string();

    let cache = payload
        .whisper_cache_dir
        .clone()
        .unwrap_or_else(|| "".to_string());

    let mut env_pairs: Vec<(String, String)> = vec![
        ("XYZTOOLS_OUTPUT_DIR".into(), out_str.clone()),
        ("XYZTOOLS_WHISPER_MODEL".into(), payload.whisper_model.clone()),
    ];
    if !cache.is_empty() {
        env_pairs.push(("WHISPER_DOWNLOAD_ROOT".into(), cache));
    }

    let mut phases: Vec<&str> = Vec::new();
    let transcript = payload.transcript || payload.markdown;
    if payload.mp3 {
        phases.push("mp3");
    }
    if payload.mp3_playlist {
        phases.push("mp3-playlist");
    }
    if transcript {
        phases.push("txt");
    }
    if phases.is_empty() {
        return Err("Select at least one output.".into());
    }

    let urls: Vec<String> = payload
        .youtube_urls
        .into_iter()
        .map(|u| u.trim().to_string())
        .filter(|u| !u.is_empty())
        .collect();
    if urls.is_empty() {
        return Err("Enter at least one YouTube URL.".into());
    }

    let node = resolve_node(&app)?;
    emit_log(
        &app,
        &format!(
            "Toolkit: {}\nNode: {}\nCWD: {}\nYTTOOL_ROOT={}\n",
            toolkit.display(),
            node.display(),
            out_parent.display(),
            toolkit.display()
        ),
    )
    .await;
    if let Some(p) = bundled_ytdlp(&app) {
        emit_log(&app, &format!("Bundled yt-dlp: {}\n", p.display())).await;
    }
    if let Some(p) = bundled_ffmpeg(&app) {
        emit_log(&app, &format!("Bundled ffmpeg: {}\n", p.display())).await;
    }

    if transcript {
        let venv = whisper_venv_dir()?;
        let venv_py = venv_python_exe(&venv);
        if whisper_import_ok(&venv_py) {
            env_pairs.push((
                "XYZTOOLS_PYTHON".into(),
                venv_py.to_string_lossy().to_string(),
            ));
            emit_log(
                &app,
                &format!("Whisper Python: {}\n", venv_py.display()),
            )
            .await;
        } else {
            emit_log(
                &app,
                "Whisper runtime not installed — caption transcripts may still work; \
                 click “Install Whisper runtime” in the app for videos without captions.\n",
            )
            .await;
        }
    }

    let total = urls.len();
    for (idx, url) in urls.iter().enumerate() {
        emit_log(
            &app,
            &format!("\n############ ({}/{}) {url} ############\n", idx + 1, total),
        )
        .await;
        for fmt in &phases {
            emit_log(&app, &format!("=== yttool convert --format {fmt} ===\n")).await;
            let refs: Vec<(&str, &str)> = env_pairs
                .iter()
                .map(|(a, b)| (a.as_str(), b.as_str()))
                .collect();
            let phase_md: Vec<(&str, &str)> = if *fmt == "txt" && payload.markdown {
                vec![("XYZTOOLS_EXPORT_MD", "1")]
            } else {
                vec![]
            };
            let code = run_node_phase(
                app.clone(),
                &toolkit,
                &out_parent,
                url,
                fmt,
                &refs,
                &phase_md,
            )
            .await?;
            if code != 0 {
                emit_log(&app, &format!("Phase {fmt} exited with code {code}\n")).await;
            }
        }
    }

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            pick_output_folder,
            default_output_parent,
            whisper_models_dir,
            whisper_runtime_status,
            install_whisper_runtime,
            prefetch_whisper_model,
            run_conversion
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
