use std::sync::Arc;

use tauri::State;

use crate::error::AppResult;
use crate::models::{ConnectionConfig, ConnectionInfo, ProfileInfo};
use crate::profiles;
use crate::state::{AppState, Connection, DISCONNECT_WAIT};

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

/// `cancelActive: true` cancels every transfer, batch and job and waits (bounded) for their
/// final events first; `false` (or absent) lets them finish in the background.
#[tauri::command]
pub async fn disconnect(state: State<'_, AppState>, cancel_active: Option<bool>) -> AppResult<()> {
    state.disconnect(cancel_active.unwrap_or(false), DISCONNECT_WAIT).await;
    Ok(())
}

#[tauri::command]
pub async fn connection_status(state: State<'_, AppState>) -> AppResult<Option<ConnectionInfo>> {
    Ok(state.connection_info().await)
}
