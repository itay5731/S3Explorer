use tauri::{AppHandle, Emitter, State};

use crate::error::AppResult;
use crate::state::AppState;
use crate::updates::{self, Sources, UpdateInfo, UpdaterState, UPDATE_PROGRESS_EVENT};

#[tauri::command]
pub async fn check_for_update(app: AppHandle, updater: State<'_, UpdaterState>) -> AppResult<UpdateInfo> {
    updates::check(&app, &updater, &Sources::default()).await
}

/// Never called automatically: only when the user clicks "Install and restart".
#[tauri::command]
pub async fn install_update(
    app: AppHandle,
    state: State<'_, AppState>,
    updater: State<'_, UpdaterState>,
) -> AppResult<()> {
    let restart_handle = app.clone();
    updates::install(
        &updater,
        || (state.transfers.has_active(), state.jobs.has_active()),
        |p| {
            let _ = app.emit(UPDATE_PROGRESS_EVENT, p);
        },
        move || restart_handle.restart(),
    )
    .await
}
