//! Application state: the active S3 connection and the transfer manager.

use std::sync::Arc;
use std::time::Duration;

use aws_config::timeout::TimeoutConfig;
use aws_config::{BehaviorVersion, Region, SdkConfig};
use aws_credential_types::Credentials;
use aws_sdk_s3::config::{RequestChecksumCalculation, ResponseChecksumValidation};
use aws_sdk_s3::Client;
use dashmap::DashMap;
use tokio::sync::RwLock;

use crate::error::{is_access_denied, raw_status_and_region, AppError, AppResult};
use crate::models::{ConnectionConfig, ConnectionInfo, TransferSettings};
use crate::settings::SettingsStore;
use crate::transfers::{ProgressSink, TransferManager};

const FALLBACK_REGION: &str = "us-east-1";

/// A live connection: base client plus a per-bucket cache of region-specific clients.
pub struct Connection {
    pub info: ConnectionInfo,
    base_client: Client,
    sdk_config: SdkConfig,
    region: String,
    endpoint: Option<String>,
    force_path_style: bool,
    bucket_clients: DashMap<String, Client>,
}

fn normalize_endpoint(endpoint: Option<String>) -> Option<String> {
    let e = endpoint?.trim().trim_end_matches('/').to_string();
    if e.is_empty() {
        None
    } else if e.contains("://") {
        Some(e)
    } else {
        Some(format!("https://{e}"))
    }
}

fn non_empty(s: Option<String>) -> Option<String> {
    s.map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

fn build_client(sdk_config: &SdkConfig, region: &str, endpoint: Option<&str>, force_path_style: bool) -> Client {
    let mut b = aws_sdk_s3::config::Builder::from(sdk_config).region(Region::new(region.to_string()));
    if let Some(e) = endpoint {
        // Third-party S3 implementations (MinIO, R2, SeaweedFS, ...) are happiest with
        // path-style addressing and only the checksums the API strictly requires.
        b = b
            .endpoint_url(e)
            .force_path_style(force_path_style)
            .request_checksum_calculation(RequestChecksumCalculation::WhenRequired)
            .response_checksum_validation(ResponseChecksumValidation::WhenRequired);
    }
    Client::from_conf(b.build())
}

impl Connection {
    /// Builds the client from `config` and verifies it with `ListBuckets`.
    /// AccessDenied on ListBuckets still yields a connection (`canListBuckets: false`);
    /// any other error is returned.
    pub async fn open(config: ConnectionConfig) -> AppResult<Connection> {
        // `read_timeout` bounds the wait for a response (time to first byte), so a stalled
        // connection fails (as a retryable Network error) instead of hanging forever. No overall
        // operation timeout: large part transfers legitimately take long. Body stalls during
        // downloads are bounded separately (transfers::download::BODY_IDLE_TIMEOUT).
        let timeouts = TimeoutConfig::builder()
            .connect_timeout(Duration::from_secs(10))
            .read_timeout(Duration::from_secs(30))
            .build();
        let (sdk_config, label, endpoint, force_path_style) = match config {
            ConnectionConfig::Profile { profile, region, endpoint } => {
                let profile = profile.trim().to_string();
                if profile.is_empty() {
                    return Err(AppError::invalid("Profile name is required"));
                }
                let endpoint = normalize_endpoint(endpoint);
                let mut loader =
                    aws_config::defaults(BehaviorVersion::latest()).profile_name(&profile).timeout_config(timeouts);
                if let Some(r) = non_empty(region) {
                    loader = loader.region(Region::new(r));
                }
                if let Some(e) = &endpoint {
                    loader = loader.endpoint_url(e);
                }
                (loader.load().await, profile, endpoint, true)
            }
            ConnectionConfig::Static {
                access_key_id,
                secret_access_key,
                session_token,
                region,
                endpoint,
                force_path_style,
            } => {
                let access_key_id = access_key_id.trim().to_string();
                let secret_access_key = secret_access_key.trim().to_string();
                if access_key_id.is_empty() || secret_access_key.is_empty() {
                    return Err(AppError::invalid("Access key id and secret access key are required"));
                }
                let endpoint = normalize_endpoint(endpoint);
                let region = non_empty(Some(region)).unwrap_or_else(|| FALLBACK_REGION.to_string());
                let prefix: String = access_key_id.chars().take(8).collect();
                let creds = Credentials::new(
                    access_key_id,
                    secret_access_key,
                    non_empty(session_token),
                    None,
                    "s3explorer-static",
                );
                let mut loader = aws_config::defaults(BehaviorVersion::latest())
                    .credentials_provider(creds)
                    .region(Region::new(region))
                    .timeout_config(timeouts);
                if let Some(e) = &endpoint {
                    loader = loader.endpoint_url(e);
                }
                (loader.load().await, format!("static:{prefix}"), endpoint, force_path_style.unwrap_or(true))
            }
        };

        let region = sdk_config.region().map(|r| r.to_string()).unwrap_or_else(|| FALLBACK_REGION.to_string());
        let base_client = build_client(&sdk_config, &region, endpoint.as_deref(), force_path_style);

        let can_list_buckets = match base_client.list_buckets().send().await {
            Ok(_) => true,
            Err(e) => {
                let err = AppError::from(e);
                if !is_access_denied(&err) {
                    return Err(err);
                }
                false
            }
        };

        Ok(Connection {
            info: ConnectionInfo { label, region: region.clone(), endpoint: endpoint.clone(), can_list_buckets },
            base_client,
            sdk_config,
            region,
            endpoint,
            force_path_style,
            bucket_clients: DashMap::new(),
        })
    }

    /// The connection-default client (used for account-level calls like ListBuckets).
    pub fn base_client(&self) -> &Client {
        &self.base_client
    }

    /// Returns a client configured for the bucket's region, resolving it once via
    /// `HeadBucket` (the `x-amz-bucket-region` header) and caching the result.
    /// With a custom endpoint, the base client is always used.
    pub async fn client_for_bucket(&self, bucket: &str) -> Client {
        if self.endpoint.is_some() {
            return self.base_client.clone();
        }
        if let Some(c) = self.bucket_clients.get(bucket) {
            return c.clone();
        }
        let region = match self.base_client.head_bucket().bucket(bucket).send().await {
            Ok(out) => out.bucket_region().map(str::to_string),
            Err(e) => raw_status_and_region(&e).and_then(|(_, r)| r),
        };
        let Some(region) = region.filter(|r| !r.is_empty()) else {
            // Unknown (network glitch, no such bucket, ...): don't cache, use the default.
            return self.base_client.clone();
        };
        let client = if region == self.region {
            self.base_client.clone()
        } else {
            build_client(&self.sdk_config, &region, None, self.force_path_style)
        };
        self.bucket_clients.insert(bucket.to_string(), client.clone());
        client
    }
}

pub struct AppState {
    connection: RwLock<Option<Arc<Connection>>>,
    pub transfers: Arc<TransferManager>,
    pub settings: SettingsStore,
}

impl AppState {
    /// The transfer manager starts with the store's (loaded) settings.
    pub fn new(sink: Arc<dyn ProgressSink>, settings: SettingsStore) -> Self {
        let transfers = TransferManager::with_settings(sink, settings.get());
        Self { connection: RwLock::new(None), transfers, settings }
    }

    pub fn get_settings(&self) -> TransferSettings {
        self.settings.get()
    }

    /// Validates, persists and applies new settings (nothing changes on error).
    pub async fn update_settings(&self, settings: TransferSettings) -> AppResult<TransferSettings> {
        self.settings.update(settings, |s| self.transfers.apply_settings(s)).await
    }

    pub async fn set_connection(&self, conn: Option<Arc<Connection>>) {
        *self.connection.write().await = conn;
    }

    pub async fn connection(&self) -> AppResult<Arc<Connection>> {
        self.connection.read().await.clone().ok_or_else(AppError::not_connected)
    }

    pub async fn connection_info(&self) -> Option<ConnectionInfo> {
        self.connection.read().await.as_ref().map(|c| c.info.clone())
    }

    pub async fn client_for_bucket(&self, bucket: &str) -> AppResult<Client> {
        if bucket.trim().is_empty() {
            return Err(AppError::invalid("Bucket name is required"));
        }
        Ok(self.connection().await?.client_for_bucket(bucket).await)
    }
}
