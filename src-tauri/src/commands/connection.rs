use std::sync::Arc;

use tauri::State;

use crate::error::AppResult;
use crate::models::{ConnectionConfig, ConnectionInfo, ProfileInfo};
use crate::profiles;
use crate::state::{AppState, Connection};

#[tauri::command]
pub async fn list_profiles() -> AppResult<Vec<ProfileInfo>> {
    Ok(profiles::load_profiles().await)
}

#[tauri::command]
pub async fn connect(state: State<'_, AppState>, config: ConnectionConfig) -> AppResult<ConnectionInfo> {
    let conn = Connection::open(config).await?;
    let info = conn.info.clone();
    state.set_connection(Some(Arc::new(conn))).await;
    Ok(info)
}

#[tauri::command]
pub async fn disconnect(state: State<'_, AppState>) -> AppResult<()> {
    state.set_connection(None).await;
    Ok(())
}

#[tauri::command]
pub async fn connection_status(state: State<'_, AppState>) -> AppResult<Option<ConnectionInfo>> {
    Ok(state.connection_info().await)
}
