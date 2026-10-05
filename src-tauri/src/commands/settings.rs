use tauri::State;

use crate::error::AppResult;
use crate::models::AppSettings;
use crate::state::AppState;

#[tauri::command]
pub async fn get_settings(state: State<'_, AppState>) -> AppResult<AppSettings> {
    Ok(state.get_settings())
}

/// Takes raw JSON so a non-integer or missing field comes back as `InvalidInput` naming the field
/// (typed deserialization would fail before the command runs, with a generic Tauri error).
#[tauri::command]
pub async fn update_settings(state: State<'_, AppState>, settings: serde_json::Value) -> AppResult<AppSettings> {
    let settings = AppSettings::from_json_strict(&settings)?;
    state.update_settings(settings).await
}
