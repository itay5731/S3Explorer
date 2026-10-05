use tauri::State;

use crate::error::AppResult;
use crate::models::{Bucket, ListPage, ObjectMeta};
use crate::ops;
use crate::state::AppState;

#[tauri::command]
pub async fn list_buckets(state: State<'_, AppState>) -> AppResult<Vec<Bucket>> {
    let conn = state.connection().await?;
    ops::list_buckets(conn.base_client()).await
}

#[tauri::command]
pub async fn list_objects(
    state: State<'_, AppState>,
    bucket: String,
    prefix: Option<String>,
    continuation_token: Option<String>,
    page_size: Option<i32>,
) -> AppResult<ListPage> {
    let client = state.client_for_bucket(&bucket).await?;
    ops::list_objects(&client, &bucket, prefix.as_deref().unwrap_or(""), continuation_token, page_size).await
}

#[tauri::command]
pub async fn head_object(state: State<'_, AppState>, bucket: String, key: String) -> AppResult<ObjectMeta> {
    let client = state.client_for_bucket(&bucket).await?;
    ops::head_object(&client, &bucket, &key).await
}
