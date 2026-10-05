use aws_sdk_s3::Client;
use tauri::State;

use crate::error::AppResult;
use crate::jobs;
use crate::models::{Job, JobKind, JobPreview, JobRequest};
use crate::state::AppState;

/// Clients for the source and (copy/move) destination buckets, each in its bucket's region.
async fn clients(state: &AppState, request: &JobRequest) -> AppResult<(Client, Option<Client>)> {
    let src = state.client_for_bucket(&request.src_bucket).await?;
    let dest = match (&request.dest_bucket, request.kind) {
        (Some(b), JobKind::Copy | JobKind::Move) => Some(state.client_for_bucket(b).await?),
        _ => None,
    };
    Ok((src, dest))
}

#[tauri::command]
pub async fn preview_job(state: State<'_, AppState>, request: JobRequest) -> AppResult<JobPreview> {
    jobs::validate(&request)?;
    let (src, dest) = clients(&state, &request).await?;
    jobs::preview(&request, &src, dest.as_ref()).await
}

#[tauri::command]
pub async fn start_job(state: State<'_, AppState>, request: JobRequest) -> AppResult<String> {
    jobs::validate(&request)?;
    let (src, dest) = clients(&state, &request).await?;
    state.jobs.start(request, src, dest)
}

#[tauri::command]
pub async fn cancel_job(state: State<'_, AppState>, id: String) -> AppResult<()> {
    state.jobs.cancel(&id)
}

#[tauri::command]
pub async fn remove_job(state: State<'_, AppState>, id: String) -> AppResult<()> {
    state.jobs.remove(&id)
}

#[tauri::command]
pub async fn list_jobs(state: State<'_, AppState>) -> AppResult<Vec<Job>> {
    Ok(state.jobs.list())
}
