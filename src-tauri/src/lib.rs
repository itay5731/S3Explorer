//! S3 Explorer backend.
//!
//! S3 logic lives in plain modules (`ops`, `state`, `transfers`, `jobs`) that only need an
//! `aws_sdk_s3::Client` and a progress sink ([`transfers::ProgressSink`], [`jobs::JobSink`]);
//! the Tauri glue is in `commands`.

pub mod commands;
pub mod error;
pub mod jobs;
pub mod models;
pub mod ops;
pub mod profiles;
pub mod settings;
pub mod state;
pub mod transfers;

use std::sync::Arc;

use tauri::{Emitter, Manager};

use crate::jobs::JobSink;
use crate::models::{Job, Transfer, JOB_PROGRESS_EVENT, TRANSFER_PROGRESS_EVENT};
use crate::settings::SettingsStore;
use crate::state::AppState;
use crate::transfers::ProgressSink;

/// Forwards transfer snapshots to the webview as `transfer:progress` events.
struct TauriSink(tauri::AppHandle);

impl ProgressSink for TauriSink {
    fn emit(&self, transfer: &Transfer) {
        let _ = self.0.emit(TRANSFER_PROGRESS_EVENT, transfer);
    }
}

/// Forwards job snapshots to the webview as `job:progress` events.
struct TauriJobSink(tauri::AppHandle);

impl JobSink for TauriJobSink {
    fn emit(&self, job: &Job) {
        let _ = self.0.emit(JOB_PROGRESS_EVENT, job);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let sink: Arc<dyn ProgressSink> = Arc::new(TauriSink(app.handle().clone()));
            let job_sink: Arc<dyn JobSink> = Arc::new(TauriJobSink(app.handle().clone()));
            // Never fail startup over settings: no config dir means in-memory defaults.
            let store = match app.path().app_config_dir() {
                Ok(dir) => SettingsStore::load(dir.join(settings::SETTINGS_FILE)),
                Err(_) => SettingsStore::in_memory(Default::default()),
            };
            app.manage(AppState::new(sink, job_sink, store));
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
            commands::transfers::start_download,
            commands::transfers::start_upload,
            commands::transfers::cancel_transfer,
            commands::transfers::remove_transfer,
            commands::transfers::list_transfers,
            commands::jobs::preview_job,
            commands::jobs::start_job,
            commands::jobs::cancel_job,
            commands::jobs::remove_job,
            commands::jobs::list_jobs,
            commands::settings::get_settings,
            commands::settings::update_settings,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
