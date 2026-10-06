use tauri::State;

use crate::error::AppResult;
use crate::models::Tag;
use crate::state::AppState;
use crate::tags;

#[tauri::command]
pub async fn get_bucket_tags(state: State<'_, AppState>, bucket: String) -> AppResult<Vec<Tag>> {
    let client = state.client_for_bucket(&bucket).await?;
    tags::get_bucket_tags(&client, &bucket).await
}

#[tauri::command]
pub async fn put_bucket_tags(
    state: State<'_, AppState>,
    bucket: String,
    tags: Vec<Tag>,
    expected: Vec<Tag>,
) -> AppResult<Vec<Tag>> {
    let client = state.client_for_bucket(&bucket).await?;
    tags::put_bucket_tags(&client, &bucket, &tags, &expected).await
}

#[tauri::command]
pub async fn get_object_tags(state: State<'_, AppState>, bucket: String, key: String) -> AppResult<Vec<Tag>> {
    let client = state.client_for_bucket(&bucket).await?;
    tags::get_object_tags(&client, &bucket, &key).await
}

#[tauri::command]
pub async fn put_object_tags(
    state: State<'_, AppState>,
    bucket: String,
    key: String,
    tags: Vec<Tag>,
    expected: Vec<Tag>,
) -> AppResult<Vec<Tag>> {
    let client = state.client_for_bucket(&bucket).await?;
    tags::put_object_tags(&client, &bucket, &key, &tags, &expected).await
}
