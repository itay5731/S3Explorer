use tauri::State;

use crate::buckets::{self, AddedBucketStore};
use crate::error::AppResult;
use crate::models::AddedBucket;
use crate::state::AppState;

#[tauri::command]
pub async fn list_added_buckets(state: State<'_, AppState>, store: State<'_, AddedBucketStore>) -> AppResult<Vec<AddedBucket>> {
    let conn = state.connection().await?;
    Ok(store.list(&conn.identity).await)
}

/// Parses the input, verifies the bucket (HeadBucket, then ListObjectsV2 max-keys=1) and
/// remembers it for the current connection.
#[tauri::command]
pub async fn add_bucket(
    state: State<'_, AppState>,
    store: State<'_, AddedBucketStore>,
    input: String,
) -> AppResult<AddedBucket> {
    let name = buckets::parse_bucket_input(&input)?;
    let conn = state.connection().await?;
    if let Some(existing) = store.find(&conn.identity, &name).await {
        return Ok(existing);
    }
    let (client, region) = conn.resolve_bucket(&name).await;
    buckets::add(&store, &conn.identity, &name, &client, region).await
}

/// Forgets the bucket locally. Never touches the bucket or its contents.
#[tauri::command]
pub async fn remove_added_bucket(
    state: State<'_, AppState>,
    store: State<'_, AddedBucketStore>,
    name: String,
) -> AppResult<()> {
    let conn = state.connection().await?;
    store.remove(&conn.identity, &name).await
}
