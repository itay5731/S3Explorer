use tauri::State;

use crate::error::AppResult;
use crate::models::DeleteResult;
use crate::ops;
use crate::state::AppState;

#[tauri::command]
pub async fn create_folder(state: State<'_, AppState>, bucket: String, prefix: String) -> AppResult<()> {
    let client = state.client_for_bucket(&bucket).await?;
    ops::create_folder(&client, &bucket, &prefix).await
}

#[tauri::command]
pub async fn delete_folder(state: State<'_, AppState>, bucket: String, prefix: String) -> AppResult<DeleteResult> {
    let client = state.client_for_bucket(&bucket).await?;
    ops::delete_folder(&client, &bucket, &prefix).await
}
