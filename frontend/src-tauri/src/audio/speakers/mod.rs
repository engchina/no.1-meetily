mod download;
pub use download::*;

use crate::state::AppState;
use anyhow::{anyhow, bail, Context, Result};
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};
use tauri::{AppHandle, Manager, Runtime, State};
use tokio::{io::AsyncWriteExt, process::Command};

static ANALYSIS: Lazy<tokio::sync::Mutex<()>> = Lazy::new(|| tokio::sync::Mutex::new(()));

pub(super) fn command(exe: &Path) -> Command {
    let mut cmd = Command::new(exe);
    cmd.kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(0x08000000);
    cmd
}

#[derive(Serialize, Deserialize)]
pub struct SpeakerTimeline {
    model: String,
    turns: Vec<(f64, f64, u32)>,
    names: BTreeMap<u32, String>,
}

async fn audio_path(state: &AppState, meeting: &str) -> Result<PathBuf> {
    let folder: Option<String> =
        sqlx::query_scalar("SELECT folder_path FROM meetings WHERE id = ?")
            .bind(meeting)
            .fetch_one(state.db_manager.pool())
            .await?;
    let folder = PathBuf::from(folder.context("This meeting has no saved recording.")?);
    super::retranscription::find_audio_file(&folder)
        .map_err(|_| anyhow!("The saved recording could not be found."))
}

#[tauri::command]
pub async fn meeting_playback_path<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    meeting_id: String,
) -> Result<String, String> {
    let path = audio_path(&state, &meeting_id)
        .await
        .map_err(|e| e.to_string())?;
    app.asset_protocol_scope()
        .allow_file(&path)
        .map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

async fn timeline(state: &AppState, meeting: &str) -> Result<Option<SpeakerTimeline>> {
    let row: Option<(String, String, String)> = sqlx::query_as(
        "SELECT model, turns, names FROM meeting_speaker_timelines WHERE meeting_id=?",
    )
    .bind(meeting)
    .fetch_optional(state.db_manager.pool())
    .await?;
    row.map(|(model, turns, names)| {
        Ok(SpeakerTimeline {
            model,
            turns: serde_json::from_str(&turns)?,
            names: serde_json::from_str(&names)?,
        })
    })
    .transpose()
}

#[tauri::command]
pub async fn get_meeting_speakers(
    state: State<'_, AppState>,
    meeting_id: String,
) -> Result<Option<SpeakerTimeline>, String> {
    timeline(&state, &meeting_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn rename_meeting_speaker(
    state: State<'_, AppState>,
    meeting_id: String,
    speaker: u32,
    name: String,
) -> Result<(), String> {
    let name = name.trim();
    if name.chars().count() > 80 || name.chars().any(char::is_control) {
        return Err("Use a name of up to 80 characters.".into());
    }
    let path = format!("$.\x22{speaker}\x22");
    let result = sqlx::query("UPDATE meeting_speaker_timelines SET names=CASE WHEN ?='' THEN json_remove(names, ?) ELSE json_set(names, ?, ?) END WHERE meeting_id=? AND EXISTS(SELECT 1 FROM json_each(turns) WHERE json_extract(value,'$[2]')=?)")
        .bind(name).bind(&path).bind(&path).bind(name).bind(meeting_id).bind(speaker).execute(state.db_manager.pool()).await.map_err(|e|e.to_string())?;
    if result.rows_affected() == 0 {
        return Err("Speaker no longer exists.".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn identify_meeting_speakers<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    meeting_id: String,
    model: String,
) -> Result<SpeakerTimeline, String> {
    let _guard = ANALYSIS
        .try_lock()
        .map_err(|_| "Another meeting is already being analyzed.".to_string())?;
    analyze(&app, &state, &meeting_id, &model)
        .await
        .map_err(|e| format!("{e:#}"))
}

async fn analyze<R: Runtime>(
    app: &AppHandle<R>,
    state: &AppState,
    meeting: &str,
    model: &str,
) -> Result<SpeakerTimeline> {
    if let Some(saved) = timeline(state, meeting).await? {
        return Ok(saved);
    }
    if !matches!(model, "local" | "community-1") {
        bail!("Unknown speaker model");
    }
    let dir = download::root(app)?.join(model);
    download::require_ready(&dir, model)?;
    let input = audio_path(state, meeting).await?;
    let temp = tempfile::tempdir()?;
    let wav = temp.path().join("recording.wav");
    let ffmpeg = super::ffmpeg::find_ffmpeg_path().context("FFmpeg unavailable")?;
    let status = command(&ffmpeg)
        .args(["-nostdin", "-loglevel", "error", "-i"])
        .arg(input)
        .args(["-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le"])
        .arg(&wav)
        .output()
        .await?;
    if !status.status.success() {
        bail!("Could not decode this recording.");
    }
    let mut child = command(&download::python(&dir))
        .args(["-I", "-"])
        .arg(model)
        .arg(dir.join("weights"))
        .arg(wav)
        .env("HF_HUB_OFFLINE", "1")
        .env("PYANNOTE_METRICS_ENABLED", "0")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()?;
    let mut stdin = child
        .stdin
        .take()
        .context("Could not start speaker engine")?;
    stdin.write_all(include_bytes!("worker.py")).await?;
    drop(stdin);
    let output = child.wait_with_output().await?;
    if !output.status.success() {
        bail!("The local speaker engine could not process this recording.");
    }
    let turns: Vec<(f64, f64, u32)> =
        serde_json::from_slice(&output.stdout).context("Invalid speaker timeline")?;
    if turns.is_empty() {
        bail!("No speakers detected in the saved recording.");
    }
    let data = SpeakerTimeline {
        model: model.into(),
        turns,
        names: BTreeMap::new(),
    };
    sqlx::query("INSERT INTO meeting_speaker_timelines(meeting_id,model,turns) VALUES(?,?,?)")
        .bind(meeting)
        .bind(model)
        .bind(serde_json::to_string(&data.turns)?)
        .execute(state.db_manager.pool())
        .await?;
    Ok(data)
}
