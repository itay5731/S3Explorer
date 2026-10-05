//! Error type shared by every command. Serializes as `{ code, message }`.

use aws_sdk_s3::config::http::HttpResponse;
use aws_sdk_s3::error::{DisplayErrorContext, ProvideErrorMetadata, SdkError};
use serde::{Deserialize, Serialize};

/// Error codes, serialized verbatim (PascalCase) to match `ErrorCode` in `src/lib/types.ts`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub enum ErrorCode {
    NotConnected,
    Auth,
    NoSuchBucket,
    NoSuchKey,
    AccessDenied,
    Network,
    Io,
    Cancelled,
    InvalidInput,
    /// The OS keychain is unavailable or refused access (saved-connection secrets).
    Keychain,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize, thiserror::Error)]
#[serde(rename_all = "camelCase")]
#[error("{code:?}: {message}")]
pub struct AppError {
    pub code: ErrorCode,
    pub message: String,
}

pub type AppResult<T> = Result<T, AppError>;

impl AppError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self { code, message: message.into() }
    }
    pub fn not_connected() -> Self {
        Self::new(ErrorCode::NotConnected, "Not connected to S3")
    }
    pub fn cancelled() -> Self {
        Self::new(ErrorCode::Cancelled, "Cancelled")
    }
    pub fn invalid(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::InvalidInput, message)
    }
    pub fn is_cancelled(&self) -> bool {
        self.code == ErrorCode::Cancelled
    }
    /// A panic caught at the top of a background task (transfer or job), so it ends as a failure
    /// instead of staying "running". Only reachable in builds that unwind: release builds use
    /// `panic = "abort"`, where a panic ends the process.
    pub fn from_panic(payload: &(dyn std::any::Any + Send)) -> Self {
        let detail = payload
            .downcast_ref::<&str>()
            .map(|s| s.to_string())
            .or_else(|| payload.downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "unknown cause".to_string());
        AppError::new(ErrorCode::Unknown, format!("Internal error: the operation stopped unexpectedly ({detail})."))
    }
}

impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        AppError::new(ErrorCode::Io, e.to_string())
    }
}

impl From<tokio::task::JoinError> for AppError {
    fn from(e: tokio::task::JoinError) -> Self {
        AppError::new(ErrorCode::Unknown, format!("Background task failed: {e}"))
    }
}

impl From<aws_sdk_s3::primitives::ByteStreamError> for AppError {
    fn from(e: aws_sdk_s3::primitives::ByteStreamError) -> Self {
        AppError::new(ErrorCode::Network, format!("Error while streaming data: {}", DisplayErrorContext(&e)))
    }
}

fn looks_like_credentials_problem(text: &str) -> bool {
    let t = text.to_ascii_lowercase();
    t.contains("credential")
        || t.contains("sso")
        || t.contains("token has expired")
        || t.contains("no identity")
        || t.contains("identity resolver")
}

fn code_from_service(code: Option<&str>, status: u16) -> ErrorCode {
    match code {
        Some("NoSuchBucket") => ErrorCode::NoSuchBucket,
        Some("NoSuchKey") | Some("NotFound") | Some("NoSuchVersion") => ErrorCode::NoSuchKey,
        Some("AccessDenied") | Some("AllAccessDisabled") | Some("AccountProblem") => ErrorCode::AccessDenied,
        Some("InvalidAccessKeyId")
        | Some("SignatureDoesNotMatch")
        | Some("ExpiredToken")
        | Some("InvalidToken")
        | Some("TokenRefreshRequired")
        | Some("InvalidSecurity")
        | Some("MissingSecurityHeader")
        | Some("AuthorizationHeaderMalformed") => ErrorCode::Auth,
        Some("RequestTimeout") | Some("SlowDown") | Some("ServiceUnavailable") | Some("InternalError") => {
            ErrorCode::Network
        }
        Some("InvalidArgument") | Some("InvalidBucketName") | Some("KeyTooLongError") | Some("InvalidRange") => {
            ErrorCode::InvalidInput
        }
        _ => match status {
            401 => ErrorCode::Auth,
            403 => ErrorCode::AccessDenied,
            404 => ErrorCode::NoSuchKey,
            500..=599 => ErrorCode::Network,
            _ => ErrorCode::Unknown,
        },
    }
}

impl<E> From<SdkError<E, HttpResponse>> for AppError
where
    E: ProvideErrorMetadata + std::error::Error + Send + Sync + 'static,
{
    fn from(err: SdkError<E, HttpResponse>) -> Self {
        match &err {
            SdkError::ServiceError(se) => {
                let status = se.raw().status().as_u16();
                let inner = se.err();
                let code = code_from_service(inner.code(), status);
                let message = match (inner.code(), inner.message()) {
                    (Some(c), Some(m)) => format!("{c}: {m}"),
                    (Some("NotFound"), None) => "Not found: the object does not exist".to_string(),
                    (Some(c), None) => match status {
                        403 => format!("{c}: access denied (HTTP 403)"),
                        _ => c.to_string(),
                    },
                    (None, Some(m)) => m.to_string(),
                    (None, None) => match status {
                        301 => "The bucket is in a different region (301 Moved Permanently)".to_string(),
                        403 => "Access denied (HTTP 403)".to_string(),
                        404 => "Not found (HTTP 404)".to_string(),
                        s => format!("S3 returned HTTP {s}"),
                    },
                };
                AppError::new(code, message)
            }
            SdkError::TimeoutError(_) => AppError::new(ErrorCode::Network, "The request timed out"),
            SdkError::DispatchFailure(df) => {
                let text = DisplayErrorContext(&err).to_string();
                if df.is_io() || df.is_timeout() {
                    AppError::new(ErrorCode::Network, format!("Network error: {text}"))
                } else if looks_like_credentials_problem(&text) {
                    AppError::new(ErrorCode::Auth, format!("Could not load credentials: {text}"))
                } else {
                    AppError::new(ErrorCode::Network, format!("Request failed: {text}"))
                }
            }
            SdkError::ResponseError(_) => {
                AppError::new(ErrorCode::Network, format!("Invalid response: {}", DisplayErrorContext(&err)))
            }
            SdkError::ConstructionFailure(_) => {
                let text = DisplayErrorContext(&err).to_string();
                if looks_like_credentials_problem(&text) {
                    AppError::new(ErrorCode::Auth, format!("Could not load credentials: {text}"))
                } else {
                    AppError::new(ErrorCode::InvalidInput, format!("Invalid request: {text}"))
                }
            }
            _ => {
                let text = DisplayErrorContext(&err).to_string();
                let code = if looks_like_credentials_problem(&text) { ErrorCode::Auth } else { ErrorCode::Unknown };
                AppError::new(code, text)
            }
        }
    }
}

/// Status code + `x-amz-bucket-region` header of a failed request, if it reached the server.
pub fn raw_status_and_region<E>(err: &SdkError<E, HttpResponse>) -> Option<(u16, Option<String>)> {
    err.raw_response().map(|r| {
        (r.status().as_u16(), r.headers().get("x-amz-bucket-region").map(|s| s.to_string()))
    })
}

/// True when the error is S3's AccessDenied (used by `connect` to tolerate a denied ListBuckets).
pub fn is_access_denied(e: &AppError) -> bool {
    e.code == ErrorCode::AccessDenied
}
