use anyhow::{anyhow, bail, Context, Result};
use futures_util::StreamExt;
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    io::Cursor,
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri::{AppHandle, Manager, Runtime};
use tokio::{fs, io::AsyncWriteExt, sync::watch};

#[derive(Deserialize)]
struct Artifact {
    name: String,
    url: String,
    bytes: u64,
    sha256: Option<String>,
}

#[derive(Deserialize)]
struct Wheel {
    url: String,
    sha256: String,
}

static MODELS: Lazy<HashMap<String, Vec<Artifact>>> = Lazy::new(|| {
    serde_json::from_str(include_str!("models.json")).expect("speaker model manifest")
});

pub(super) fn root<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf> {
    Ok(app.path().app_local_data_dir()?.join("speaker-models-v1"))
}

pub(super) fn python(dir: &Path) -> PathBuf {
    dir.join(if cfg!(windows) {
        "env/Scripts/python.exe"
    } else {
        "env/bin/python"
    })
}

fn installed(dir: &Path, files: &[Artifact]) -> bool {
    dir.join("ready").is_file()
        && python(dir).is_file()
        && files.iter().all(|file| {
            dir.join("weights")
                .join(&file.name)
                .metadata()
                .is_ok_and(|m| m.len() == file.bytes)
        })
}

#[derive(Clone, Serialize)]
pub struct Download {
    model: String,
    stage: String,
    percent: Option<u64>,
}
struct Job {
    progress: Download,
    cancel: watch::Sender<bool>,
}
static JOB: Mutex<Option<Job>> = Mutex::new(None);

fn progress(stage: &str, percent: Option<u64>) {
    if let Some(job) = JOB.lock().unwrap().as_mut() {
        job.progress.stage = stage.into();
        job.progress.percent = percent;
    }
}

#[tauri::command]
pub async fn speaker_model_status<R: Runtime>(
    app: AppHandle<R>,
) -> Result<serde_json::Value, String> {
    let root = root(&app).map_err(|e| e.to_string())?;
    let ready: Vec<_> = MODELS
        .iter()
        .filter(|(id, files)| installed(&root.join(id), files))
        .map(|(id, _)| id)
        .collect();
    let active = JOB.lock().unwrap().as_ref().map(|j| j.progress.clone());
    Ok(serde_json::json!({"ready": ready, "active": active}))
}

#[tauri::command]
pub fn cancel_speaker_download(model: String) {
    if let Some(job) = JOB
        .lock()
        .unwrap()
        .as_ref()
        .filter(|j| j.progress.model == model)
    {
        let _ = job.cancel.send(true);
    }
}

#[tauri::command]
pub async fn download_speaker_model<R: Runtime>(
    app: AppHandle<R>,
    model: String,
    token: Option<String>,
) -> Result<(), String> {
    let files = MODELS.get(&model).ok_or("Unknown speaker model")?;
    let root = root(&app).map_err(|e| e.to_string())?;
    let dir = root.join(&model);
    if installed(&dir, files) {
        return Ok(());
    }
    let (cancel, mut receiver) = watch::channel(false);
    {
        let mut current = JOB.lock().unwrap();
        if current.is_some() {
            return Err("A speaker model is already downloading.".into());
        }
        *current = Some(Job {
            progress: Download {
                model: model.clone(),
                stage: "Preparing download".into(),
                percent: None,
            },
            cancel,
        });
    }
    let result = tokio::select! {
        _ = receiver.changed() => Err(anyhow!("Download cancelled")),
        result = install(&root, &dir, &model, files, token.as_deref()) => result,
    };
    *JOB.lock().unwrap() = None;
    result.map_err(|e| format!("{e:#}"))
}

async fn install(
    root: &Path,
    dir: &Path,
    model: &str,
    files: &[Artifact],
    token: Option<&str>,
) -> Result<()> {
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(20))
        .build()?;
    let weights = dir.join("weights");
    fs::create_dir_all(&weights).await?;
    let total: u64 = files.iter().map(|f| f.bytes).sum();
    let mut done = 0;
    for artifact in files {
        let path = weights.join(&artifact.name);
        fs::create_dir_all(path.parent().unwrap()).await?;
        let mut request = client.get(&artifact.url);
        if model == "community-1" {
            let token = token
                .filter(|t| !t.trim().is_empty())
                .context("Enter a Hugging Face read token.")?;
            request = request.bearer_auth(token.trim());
        }
        let response = request.send().await.map_err(|_| {
            anyhow!("Could not connect to Hugging Face. Check your connection and retry.")
        })?;
        if matches!(response.status().as_u16(), 401 | 403) {
            bail!("Hugging Face denied access. Accept the model conditions and use a read token with access to gated models.");
        }
        if !response.status().is_success() {
            bail!(
                "Model download returned HTTP {}.",
                response.status().as_u16()
            );
        }
        let part = weights.join("download.part");
        let mut file = fs::File::create(&part).await?;
        let mut stream = response.bytes_stream();
        let mut hash = Sha256::new();
        let mut size = 0;
        while let Some(chunk) = stream.next().await {
            let chunk =
                chunk.map_err(|_| anyhow!("Model download interrupted. Retry the download."))?;
            size += chunk.len() as u64;
            if size > artifact.bytes {
                bail!("Unexpected model file size.");
            }
            hash.update(&chunk);
            file.write_all(&chunk).await?;
            progress("Downloading weights", Some((done + size) * 100 / total));
        }
        file.flush().await?;
        drop(file);
        if size != artifact.bytes
            || artifact
                .sha256
                .as_ref()
                .is_some_and(|h| h != &format!("{:x}", hash.finalize()))
        {
            bail!("Model verification failed. Retry the download.");
        }
        fs::rename(part, path).await?;
        done += size;
    }
    progress("Preparing local runtime", None);
    let uv = bootstrap_uv(root, &client).await?;
    let env_dir = dir.join("env");
    let managed_command = || {
        let mut command = super::command(&uv);
        command
            .env("UV_PYTHON_INSTALL_DIR", root.join("python"))
            .env("UV_CACHE_DIR", root.join("cache"))
            .env("UV_NO_CONFIG", "1")
            .env("UV_NO_PROGRESS", "1");
        command
    };
    if !python(dir).is_file() {
        let ok = managed_command()
            .args(["venv", "--python", "3.12", "--managed-python"])
            .arg(&env_dir)
            .output()
            .await?;
        if !ok.status.success() {
            bail!("Could not prepare Python 3.12. Check access to GitHub and retry.");
        }
    }
    progress("Installing inference engine", None);
    let mut pip = managed_command();
    pip.args(["pip", "install", "--python"]).arg(python(dir));
    if model == "local" {
        pip.args(["sherpa-onnx==1.12.31", "numpy==2.2.6"]);
    } else {
        pip.args(["--torch-backend", "auto", "pyannote.audio==4.0.4"]);
    }
    if !pip.output().await?.status.success() {
        bail!("Could not install the inference engine. Check disk space and network access, then retry.");
    }
    fs::write(dir.join("ready"), b"1").await?;
    Ok(())
}

async fn bootstrap_uv(root: &Path, client: &reqwest::Client) -> Result<PathBuf> {
    let exe = if cfg!(windows) { "uv.exe" } else { "uv" };
    let path = root.join(exe);
    if path.is_file() {
        return Ok(path);
    }
    let wheels: HashMap<String, Wheel> = serde_json::from_str(include_str!("uv.json"))?;
    let platform = format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH);
    let wheel = wheels
        .get(&platform)
        .context("No speaker runtime available for this platform")?;
    let bytes = client
        .get(&wheel.url)
        .send()
        .await?
        .error_for_status()?
        .bytes()
        .await?;
    if format!("{:x}", Sha256::digest(&bytes)) != wheel.sha256 {
        bail!("Runtime verification failed");
    }
    let output = path.clone();
    tokio::task::spawn_blocking(move || -> Result<()> {
        let mut zip = zip::ZipArchive::new(Cursor::new(bytes))?;
        let name = format!("uv-0.10.4.data/scripts/{exe}");
        let mut entry = zip.by_name(&name)?;
        let mut staging = tempfile::NamedTempFile::new_in(output.parent().unwrap())?;
        std::io::copy(&mut entry, &mut staging)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            staging
                .as_file()
                .set_permissions(std::fs::Permissions::from_mode(0o755))?;
        }
        staging.persist(output)?;
        Ok(())
    })
    .await??;
    Ok(path)
}

pub(super) fn require_ready(dir: &Path, model: &str) -> Result<()> {
    if !MODELS.get(model).is_some_and(|files| installed(dir, files)) {
        bail!("Download the selected speaker model in Transcription settings first.");
    }
    Ok(())
}
