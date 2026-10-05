use std::path::PathBuf;

use tauri::State;

use crate::error::{AppError, AppResult};
use crate::models::Transfer;
use crate::state::AppState;

#[tauri::command]
pub async fn start_download(
    state: State<'_, AppState>,
    bucket: String,
    key: String,
    dest_path: String,
) -> AppResult<String> {
    if key.is_empty() || key.ends_with('/') {
        return Err(AppError::invalid("A file key is required"));
    }
    if dest_path.trim().is_empty() {
        return Err(AppError::invalid("Destination path is required"));
    }
    let client = state.client_for_bucket(&bucket).await?;
    state.transfers.start_download(client, &bucket, &key, PathBuf::from(dest_path))
}

#[tauri::command]
pub async fn start_upload(
    state: State<'_, AppState>,
    bucket: String,
    key: String,
    src_path: String,
) -> AppResult<String> {
    if key.is_empty() || key.ends_with('/') {
        return Err(AppError::invalid("A file key is required"));
    }
    if src_path.trim().is_empty() {
        return Err(AppError::invalid("Source path is required"));
    }
    let client = state.client_for_bucket(&bucket).await?;
    Ok(state.transfers.start_upload(client, &bucket, &key, PathBuf::from(src_path)))
}

#[tauri::command]
pub async fn cancel_transfer(state: State<'_, AppState>, id: String) -> AppResult<()> {
    state.transfers.cancel(&id)
}

#[tauri::command]
pub async fn remove_transfer(state: State<'_, AppState>, id: String) -> AppResult<()> {
    state.transfers.remove(&id)
}

#[tauri::command]
pub async fn list_transfers(state: State<'_, AppState>) -> AppResult<Vec<Transfer>> {
    Ok(state.transfers.list())
}
