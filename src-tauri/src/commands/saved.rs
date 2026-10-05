use tauri::State;

use crate::error::AppResult;
use crate::models::{ConnectionInfo, SaveConnectionInput, SavedConnection};
use crate::saved::{self, ConnectionStore};
use crate::state::AppState;

#[tauri::command]
pub async fn list_saved_connections(store: State<'_, ConnectionStore>) -> AppResult<Vec<SavedConnection>> {
    store.list().await
}

#[tauri::command]
pub async fn save_connection(store: State<'_, ConnectionStore>, input: SaveConnectionInput) -> AppResult<SavedConnection> {
    store.save(input).await
}

#[tauri::command]
pub async fn delete_saved_connection(store: State<'_, ConnectionStore>, id: String) -> AppResult<()> {
    store.delete(&id).await
}

#[tauri::command]
pub async fn connect_saved(
    state: State<'_, AppState>,
    store: State<'_, ConnectionStore>,
    id: String,
) -> AppResult<ConnectionInfo> {
    saved::connect_saved(&store, &state, &id).await
}
