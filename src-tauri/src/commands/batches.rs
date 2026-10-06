use tauri::State;

use crate::batches;
use crate::error::AppResult;
use crate::models::{Batch, BatchPlanRequest, BatchPreview};
use crate::state::AppState;

#[tauri::command]
pub async fn preview_batch(state: State<'_, AppState>, request: BatchPlanRequest) -> AppResult<BatchPreview> {
    batches::plan::validate(&request)?;
    let client = state.client_for_bucket(&request.bucket).await?;
    batches::preview(&request, &client).await
}

#[tauri::command]
pub async fn start_batch(state: State<'_, AppState>, request: BatchPlanRequest) -> AppResult<String> {
    batches::plan::validate(&request)?;
    let client = state.client_for_bucket(&request.bucket).await?;
    state.batches.start(request, client)
}

#[tauri::command]
pub async fn cancel_batch(state: State<'_, AppState>, id: String) -> AppResult<()> {
    state.batches.cancel(&id)
}

#[tauri::command]
pub async fn remove_batch(state: State<'_, AppState>, id: String) -> AppResult<()> {
    state.batches.remove(&id)
}

#[tauri::command]
pub async fn list_batches(state: State<'_, AppState>) -> AppResult<Vec<Batch>> {
    Ok(state.batches.list())
}
