use tauri::State;

use crate::error::AppResult;
use crate::lifecycle;
use crate::models::{BucketVersioning, LifecycleConfiguration, LifecycleIssue};
use crate::state::AppState;

#[tauri::command]
pub async fn get_lifecycle(state: State<'_, AppState>, bucket: String) -> AppResult<Option<LifecycleConfiguration>> {
    let client = state.client_for_bucket(&bucket).await?;
    lifecycle::get_lifecycle(&client, &bucket).await
}

/// Pure and local: no connection needed.
#[tauri::command]
pub async fn validate_lifecycle(config: LifecycleConfiguration) -> AppResult<Vec<LifecycleIssue>> {
    Ok(lifecycle::validate_lifecycle(&config))
}

#[tauri::command]
pub async fn put_lifecycle(
    state: State<'_, AppState>,
    bucket: String,
    config: LifecycleConfiguration,
    expected: Option<LifecycleConfiguration>,
) -> AppResult<Option<LifecycleConfiguration>> {
    let client = state.client_for_bucket(&bucket).await?;
    lifecycle::put_lifecycle(&client, &bucket, &config, expected.as_ref()).await
}

#[tauri::command]
pub async fn get_bucket_versioning(state: State<'_, AppState>, bucket: String) -> AppResult<BucketVersioning> {
    let client = state.client_for_bucket(&bucket).await?;
    lifecycle::get_bucket_versioning(&client, &bucket).await
}
