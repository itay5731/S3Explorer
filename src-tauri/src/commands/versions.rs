use std::path::PathBuf;

use tauri::State;

use crate::error::{AppError, AppResult};
use crate::models::{ObjectEntry, RestoreRequest, VersionListing};
use crate::state::AppState;
use crate::{archive, versions};

#[tauri::command]
pub async fn list_object_versions(state: State<'_, AppState>, bucket: String, key: String) -> AppResult<VersionListing> {
    let client = state.client_for_bucket(&bucket).await?;
    versions::list_object_versions(&client, &bucket, &key).await
}

/// The normal parallel download pinned to `versionId`. The version is looked up first, so a
/// missing version or a delete marker is refused before a transfer exists.
#[tauri::command]
pub async fn download_object_version(
    state: State<'_, AppState>,
    bucket: String,
    key: String,
    version_id: String,
    dest_path: String,
) -> AppResult<String> {
    if key.is_empty() || key.ends_with('/') {
        return Err(AppError::invalid("A file key is required"));
    }
    if dest_path.trim().is_empty() {
        return Err(AppError::invalid("Destination path is required"));
    }
    let client = state.client_for_bucket(&bucket).await?;
    let v = versions::find_version(&client, &bucket, &key, &version_id).await?;
    if v.is_delete_marker {
        return Err(AppError::invalid(versions::DELETE_MARKER_DOWNLOAD));
    }
    state.transfers.start_version_download(client, &bucket, &key, &version_id, PathBuf::from(dest_path))
}

#[tauri::command]
pub async fn restore_object_version(
    state: State<'_, AppState>,
    bucket: String,
    key: String,
    version_id: String,
) -> AppResult<ObjectEntry> {
    let client = state.client_for_bucket(&bucket).await?;
    versions::restore_object_version(&client, &bucket, &key, &version_id).await
}

#[tauri::command]
pub async fn delete_object_version(state: State<'_, AppState>, bucket: String, key: String, version_id: String) -> AppResult<()> {
    let client = state.client_for_bucket(&bucket).await?;
    versions::delete_object_version(&client, &bucket, &key, &version_id).await
}

#[tauri::command]
pub async fn restore_object(state: State<'_, AppState>, bucket: String, key: String, request: RestoreRequest) -> AppResult<()> {
    let client = state.client_for_bucket(&bucket).await?;
    archive::restore_object(&client, &bucket, &key, &request).await
}
