use tauri::State;

use crate::error::AppResult;
use crate::metadata;
use crate::models::{MetadataEdit, ObjectMeta};
use crate::state::AppState;

#[tauri::command]
pub async fn update_object_metadata(state: State<'_, AppState>, edit: MetadataEdit) -> AppResult<ObjectMeta> {
    let client = state.client_for_bucket(&edit.bucket).await?;
    metadata::update_object_metadata(&client, &edit).await
}
