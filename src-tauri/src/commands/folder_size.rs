use tauri::State;

use crate::error::AppResult;
use crate::models::FolderSize;
use crate::state::AppState;

/// Objects and bytes under `prefix` (verbatim). A newer call with the same `id` cancels the older
/// one, as do `cancel_folder_size` and disconnecting; at most four scans run at once.
#[tauri::command]
pub async fn folder_size(state: State<'_, AppState>, id: String, bucket: String, prefix: String) -> AppResult<FolderSize> {
    let st = state.inner();
    st.folder_sizes.run(&id, &bucket, &prefix, || st.client_for_bucket(&bucket)).await
}

/// Stops the scan with this id (it rejects with `Cancelled`); a no-op for an unknown id.
#[tauri::command]
pub async fn cancel_folder_size(state: State<'_, AppState>, id: String) -> AppResult<()> {
    state.folder_sizes.cancel(&id);
    Ok(())
}
