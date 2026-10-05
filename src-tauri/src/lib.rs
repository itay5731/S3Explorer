//! S3 Explorer backend.
//!
//! S3 logic lives in plain modules (`ops`, `state`, `transfers`) that only need an
//! `aws_sdk_s3::Client` and a [`transfers::ProgressSink`]; the Tauri glue is in `commands`.

pub mod commands;
pub mod error;
pub mod models;
pub mod ops;
pub mod profiles;
pub mod state;
pub mod transfers;

use std::sync::Arc;

use tauri::{Emitter, Manager};

use crate::models::{Transfer, TRANSFER_PROGRESS_EVENT};
use crate::state::AppState;
use crate::transfers::ProgressSink;

/// Forwards transfer snapshots to the webview as `transfer:progress` events.
struct TauriSink(tauri::AppHandle);

impl ProgressSink for TauriSink {
    fn emit(&self, transfer: &Transfer) {
        let _ = self.0.emit(TRANSFER_PROGRESS_EVENT, transfer);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let sink: Arc<dyn ProgressSink> = Arc::new(TauriSink(app.handle().clone()));
            app.manage(AppState::new(sink));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::connection::list_profiles,
            commands::connection::connect,
            commands::connection::disconnect,
            commands::connection::connection_status,
            commands::browse::list_buckets,
            commands::browse::list_objects,
            commands::browse::head_object,
            commands::folders::create_folder,
            commands::folders::delete_folder,
            commands::transfers::start_download,
            commands::transfers::start_upload,
            commands::transfers::cancel_transfer,
            commands::transfers::remove_transfer,
            commands::transfers::list_transfers,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
