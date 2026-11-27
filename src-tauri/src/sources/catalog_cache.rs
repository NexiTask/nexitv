//! On-disk copies of Xtream catalogue lists (`get_live_streams`,
//! `get_vod_streams`, `get_series`), so a start shows the catalogue from disk
//! while the provider is asked for a fresh one.
//!
//! The content is the provider's own JSON list, untouched. It holds no account
//! password: the frontend builds stream URLs from the vault's credentials when
//! it maps the list, not before. Each copy records the account scope it was
//! fetched under and is ignored for any other.

use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use tauri::Manager;
use tokio::io::AsyncWriteExt;

use super::remote::{same_origin_redirect_policy, validate_remote_url};
use crate::credentials::source::validate_source_id;

const CATALOG_KINDS: [&str; 3] = ["live", "vod", "series"];
const MAX_CATALOG_BYTES: usize = 512 * 1024 * 1024;
const MAX_REFRESH_SERVERS: usize = 16;
const CATALOG_SERVER_TIMEOUT: Duration = Duration::from_secs(30);
const CATALOG_FAILOVER_BUDGET: Duration = Duration::from_secs(45);
const METADATA_LIMIT: u64 = 4 * 1024;
const METADATA_VERSION: u8 = 1;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogRefreshRequest {
    pub source_id: String,
    pub kind: String,
    pub scope: String,
    pub server_urls: Vec<String>,
    pub username: String,
    pub password: String,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogRefreshResult {
    pub active_url: String,
    pub item_count: usize,
    pub saved_at: u64,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct CatalogCacheMetadata {
    version: u8,
    scope: String,
    saved_at: u64,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogCacheEntry {
    content: String,
    /// Milliseconds since the Unix epoch.
    saved_at: u64,
}

#[derive(Clone)]
struct CatalogCachePaths {
    content: PathBuf,
    metadata: PathBuf,
    pending_content: PathBuf,
    pending_metadata: PathBuf,
}

fn validate_kind(kind: &str) -> Result<(), String> {
    if CATALOG_KINDS.contains(&kind) {
        Ok(())
    } else {
        Err("Invalid catalog kind".to_string())
    }
}

/// Scopes are the frontend's opaque, non-secret account fingerprints.
fn validate_scope(scope: &str) -> Result<(), String> {
    if scope.is_empty()
        || scope.len() > 96
        || !scope.chars().all(|character| {
            character.is_ascii_lowercase() || character.is_ascii_digit() || character == '-'
        })
    {
        return Err("Invalid catalog cache scope".to_string());
    }
    Ok(())
}

fn paths_in(directory: &Path, source_id: &str, kind: &str) -> CatalogCachePaths {
    let stem = format!("{source_id}.{kind}");
    CatalogCachePaths {
        content: directory.join(format!("{stem}.json")),
        metadata: directory.join(format!("{stem}.meta.json")),
        pending_content: directory.join(format!("{stem}.json.pending")),
        pending_metadata: directory.join(format!("{stem}.meta.pending.json")),
    }
}

fn cache_directory(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|_| "Application data is unavailable".to_string())?
        .join("catalog-cache");
    std::fs::create_dir_all(&directory)
        .map_err(|_| "Could not create the catalog cache".to_string())?;
    Ok(directory)
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0)
}

fn remove_if_exists(path: &Path) -> Result<(), String> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err("Could not update the catalog cache".to_string()),
    }
}

fn write_synced(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut file = OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(path)
        .map_err(|_| "Could not store the catalog cache".to_string())?;
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|_| "Could not store the catalog cache".to_string())
}

fn remove_entry(paths: &CatalogCachePaths) -> Result<(), String> {
    for path in [
        &paths.content,
        &paths.metadata,
        &paths.pending_content,
        &paths.pending_metadata,
    ] {
        remove_if_exists(path)?;
    }
    Ok(())
}

fn check_size(bytes: usize) -> Result<(), String> {
    if bytes > MAX_CATALOG_BYTES {
        return Err("The catalog is larger than 512 MiB".to_string());
    }
    Ok(())
}

fn store_at(
    paths: &CatalogCachePaths,
    scope: &str,
    content: &str,
    saved_at: u64,
) -> Result<(), String> {
    validate_scope(scope)?;
    check_size(content.len())?;
    // Only a provider list is worth keeping; anything else would just fail
    // to load next time.
    serde_json::from_str::<Vec<serde::de::IgnoredAny>>(content)
        .map_err(|_| "The catalog is not a JSON list".to_string())?;
    let metadata = serde_json::to_vec(&CatalogCacheMetadata {
        version: METADATA_VERSION,
        scope: scope.to_string(),
        saved_at,
    })
    .map_err(|_| "Could not encode the catalog cache".to_string())?;

    remove_if_exists(&paths.pending_content)?;
    remove_if_exists(&paths.pending_metadata)?;
    if let Err(error) = write_synced(&paths.pending_content, content.as_bytes())
        .and_then(|_| write_synced(&paths.pending_metadata, &metadata))
    {
        let _ = remove_if_exists(&paths.pending_content);
        let _ = remove_if_exists(&paths.pending_metadata);
        return Err(error);
    }
    remove_if_exists(&paths.content)?;
    remove_if_exists(&paths.metadata)?;
    std::fs::rename(&paths.pending_content, &paths.content)
        .map_err(|_| "Could not store the catalog cache".to_string())?;
    std::fs::rename(&paths.pending_metadata, &paths.metadata)
        .map_err(|_| "Could not store the catalog cache".to_string())
}

/// `Ok(None)` when there is no copy for this account, or it is too old to
/// show; `Err` when the files on disk are damaged.
fn load_at(
    paths: &CatalogCachePaths,
    scope: &str,
    now: u64,
) -> Result<Option<CatalogCacheEntry>, String> {
    validate_scope(scope)?;
    let content_exists = paths.content.exists();
    let metadata_exists = paths.metadata.exists();
    if !content_exists && !metadata_exists {
        return Ok(None);
    }
    let invalid = || "The catalog cache is invalid".to_string();
    if !content_exists || !metadata_exists {
        return Err(invalid());
    }
    let metadata_len = std::fs::metadata(&paths.metadata)
        .map(|metadata| metadata.len())
        .map_err(|_| invalid())?;
    let content_len = std::fs::metadata(&paths.content)
        .map(|metadata| metadata.len())
        .map_err(|_| invalid())?;
    if metadata_len > METADATA_LIMIT || content_len > MAX_CATALOG_BYTES as u64 {
        return Err(invalid());
    }
    let metadata: CatalogCacheMetadata =
        serde_json::from_slice(&std::fs::read(&paths.metadata).map_err(|_| invalid())?)
            .map_err(|_| invalid())?;
    if metadata.version != METADATA_VERSION {
        return Err(invalid());
    }
    if metadata.scope != scope {
        return Ok(None);
    }
    // Old copies are kept: offline, an outdated catalogue beats an empty one,
    // and the frontend decides freshness. Only a copy from the future (a
    // clock that moved back) is dropped.
    if metadata.saved_at > now {
        remove_entry(paths)?;
        return Ok(None);
    }
    let read_start = std::time::Instant::now();
    let content = std::fs::read_to_string(&paths.content).map_err(|_| invalid())?;
    crate::perf::log(
        "rust:cache_read",
        Some(read_start.elapsed().as_millis()),
        &format!("bytes={}", content.len()),
    );
    Ok(Some(CatalogCacheEntry {
        content,
        saved_at: metadata.saved_at,
    }))
}

fn entry_paths(
    app: &tauri::AppHandle,
    source_id: &str,
    kind: &str,
) -> Result<CatalogCachePaths, String> {
    validate_source_id(source_id)?;
    validate_kind(kind)?;
    Ok(paths_in(&cache_directory(app)?, source_id, kind))
}

#[tauri::command(async)]
pub fn catalog_cache_store(
    app: tauri::AppHandle,
    source_id: String,
    kind: String,
    scope: String,
    content: String,
) -> Result<(), String> {
    let saved_at = now_millis();
    store_at(
        &entry_paths(&app, &source_id, &kind)?,
        &scope,
        &content,
        saved_at,
    )?;
    // The index is a convenience: a failure here only costs the fast path.
    match super::catalog_index::ingest(&app, &source_id, &kind, &scope, saved_at, &content) {
        Ok(_) => super::catalog_index::notify_updated(&app, &kind),
        Err(error) => log::warn!("catalog index not updated: {error}"),
    }
    Ok(())
}

/// The saved copy's content and save time, for building the index.
pub(crate) fn load_saved(
    app: &tauri::AppHandle,
    source_id: &str,
    kind: &str,
    scope: &str,
) -> Result<Option<(String, u64)>, String> {
    Ok(
        load_at(&entry_paths(app, source_id, kind)?, scope, now_millis())?
            .map(|entry| (entry.content, entry.saved_at)),
    )
}

pub(crate) fn validate_kind_public(kind: &str) -> Result<(), String> {
    validate_kind(kind)
}

#[tauri::command(async)]
pub fn catalog_cache_load(
    app: tauri::AppHandle,
    source_id: String,
    kind: String,
    scope: String,
) -> Result<Option<CatalogCacheEntry>, String> {
    load_at(&entry_paths(&app, &source_id, &kind)?, &scope, now_millis())
}

fn xtream_action_for_kind(kind: &str) -> Result<&'static str, String> {
    match kind {
        "live" => Ok("get_live_streams"),
        "vod" => Ok("get_vod_streams"),
        "series" => Ok("get_series"),
        _ => Err("Invalid catalog kind".to_string()),
    }
}

fn build_xtream_catalog_url(
    base_url: &str,
    kind: &str,
    username: &str,
    password: &str,
) -> Result<url::Url, String> {
    let action = xtream_action_for_kind(kind)?;
    let trimmed = base_url.trim().trim_end_matches('/');
    let mut url = validate_remote_url(&format!("{trimmed}/player_api.php"))
        .map_err(|_| "The provider server URL is invalid".to_string())?;
    url.query_pairs_mut()
        .append_pair("username", username)
        .append_pair("password", password)
        .append_pair("action", action);
    Ok(url)
}

async fn download_xtream_list_to_file(
    url: url::Url,
    destination: &Path,
    timeout: Duration,
) -> Result<usize, String> {
    let client = reqwest::Client::builder()
        .timeout(timeout)
        .redirect(same_origin_redirect_policy())
        .build()
        .map_err(|_| "Could not initialize the catalog downloader".to_string())?;
    let mut response = client
        .get(url)
        .header(reqwest::header::USER_AGENT, "NexiTV/0.1")
        .send()
        .await
        .map_err(|error| {
            if error.is_timeout() {
                "Provider request timed out".to_string()
            } else {
                "Network connection to provider failed".to_string()
            }
        })?;
    if !response.status().is_success() {
        return Err(format!("XC API Error: {}", response.status().as_u16()));
    }
    if response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.to_ascii_lowercase().contains("text/html"))
    {
        return Err("XC API Returned HTML error page instead of JSON".to_string());
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_CATALOG_BYTES as u64)
    {
        return Err("The catalog is larger than 512 MiB".to_string());
    }

    let file = tokio::fs::File::create(destination)
        .await
        .map_err(|_| "Could not store the catalog cache".to_string())?;
    let mut writer = tokio::io::BufWriter::with_capacity(64 * 1024, file);
    let mut written = 0usize;
    let stream_result: Result<(), String> = async {
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| "The catalog download was interrupted".to_string())?
        {
            written = written.saturating_add(chunk.len());
            if written > MAX_CATALOG_BYTES {
                return Err("The catalog is larger than 512 MiB".to_string());
            }
            writer
                .write_all(&chunk)
                .await
                .map_err(|_| "Could not store the catalog cache".to_string())?;
        }
        writer
            .flush()
            .await
            .map_err(|_| "Could not store the catalog cache".to_string())?;
        writer
            .get_ref()
            .sync_all()
            .await
            .map_err(|_| "Could not store the catalog cache".to_string())?;
        Ok(())
    }
    .await;
    if let Err(error) = stream_result {
        let _ = tokio::fs::remove_file(destination).await;
        return Err(error);
    }
    Ok(written)
}

fn existing_has_items(paths: &CatalogCachePaths, scope: &str, now: u64) -> bool {
    load_at(paths, scope, now)
        .ok()
        .flatten()
        .is_some_and(|entry| {
            serde_json::from_str::<Vec<&RawValue>>(&entry.content)
                .is_ok_and(|list| !list.is_empty())
        })
}

fn commit_downloaded_catalog(
    paths: &CatalogCachePaths,
    scope: &str,
    saved_at: u64,
) -> Result<(usize, String), String> {
    let content = std::fs::read_to_string(&paths.pending_content)
        .map_err(|_| "XC API returned an invalid JSON response".to_string())?;
    check_size(content.len())?;
    let item_count = serde_json::from_str::<Vec<&RawValue>>(&content)
        .map(|list| list.len())
        .map_err(|_| "XC API returned an invalid JSON response".to_string())?;
    if item_count == 0 {
        let _ = remove_if_exists(&paths.pending_content);
        if existing_has_items(paths, scope, saved_at) {
            return Err("The provider returned an empty catalogue".to_string());
        }
        return Ok((0, String::new()));
    }
    let metadata = serde_json::to_vec(&CatalogCacheMetadata {
        version: METADATA_VERSION,
        scope: scope.to_string(),
        saved_at,
    })
    .map_err(|_| "Could not encode the catalog cache".to_string())?;
    remove_if_exists(&paths.pending_metadata)?;
    if let Err(error) = write_synced(&paths.pending_metadata, &metadata) {
        let _ = remove_if_exists(&paths.pending_content);
        let _ = remove_if_exists(&paths.pending_metadata);
        return Err(error);
    }
    remove_if_exists(&paths.content)?;
    remove_if_exists(&paths.metadata)?;
    std::fs::rename(&paths.pending_content, &paths.content)
        .map_err(|_| "Could not store the catalog cache".to_string())?;
    std::fs::rename(&paths.pending_metadata, &paths.metadata)
        .map_err(|_| "Could not store the catalog cache".to_string())?;
    Ok((item_count, content))
}

async fn refresh_to_paths(
    paths: &CatalogCachePaths,
    request: &CatalogRefreshRequest,
    saved_at: u64,
) -> Result<(CatalogRefreshResult, String), String> {
    validate_source_id(&request.source_id)?;
    validate_kind(&request.kind)?;
    validate_scope(&request.scope)?;
    let urls: Vec<&str> = request
        .server_urls
        .iter()
        .map(String::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .take(MAX_REFRESH_SERVERS)
        .collect();
    if urls.is_empty() {
        return Err("No provider server URL is configured".to_string());
    }

    let started = Instant::now();
    let mut failures = Vec::new();
    for (index, base_url) in urls.iter().enumerate() {
        let remaining = CATALOG_FAILOVER_BUDGET.saturating_sub(started.elapsed());
        if remaining.is_zero() {
            break;
        }
        let timeout = remaining.min(CATALOG_SERVER_TIMEOUT);
        let label = url::Url::parse(base_url)
            .ok()
            .and_then(|parsed| parsed.host_str().map(str::to_owned))
            .unwrap_or_else(|| format!("Configured server {}", index + 1));
        let url = match build_xtream_catalog_url(
            base_url,
            &request.kind,
            &request.username,
            &request.password,
        ) {
            Ok(url) => url,
            Err(error) => {
                failures.push(format!("{label}: {error}"));
                continue;
            }
        };
        let _ = remove_if_exists(&paths.pending_content);
        let _ = remove_if_exists(&paths.pending_metadata);
        if let Err(error) = download_xtream_list_to_file(url, &paths.pending_content, timeout).await
        {
            failures.push(format!("{label}: {error}"));
            continue;
        }
        let paths_for_commit = paths.clone();
        let scope = request.scope.clone();
        let committed = tauri::async_runtime::spawn_blocking(move || {
            commit_downloaded_catalog(&paths_for_commit, &scope, saved_at)
        })
        .await
        .map_err(|_| "Could not store the catalog cache".to_string())?;
        match committed {
            Ok((item_count, content)) => {
                return Ok((
                    CatalogRefreshResult {
                        active_url: (*base_url).to_string(),
                        item_count,
                        saved_at,
                    },
                    content,
                ));
            }
            Err(error) => {
                let _ = remove_if_exists(&paths.pending_content);
                let _ = remove_if_exists(&paths.pending_metadata);
                failures.push(format!("{label}: {error}"));
            }
        }
    }
    Err(if failures.is_empty() {
        "Failed to connect to any configured XC server".to_string()
    } else {
        failures.join("\n")
    })
}

/// Stream an Xtream catalogue straight from the provider into the on-disk cache
/// and SQLite index in Rust, avoiding parsing or round-tripping 100 MiB JSON
/// blobs through the webview when no full-catalogue JS cache is active.
#[tauri::command(async)]
pub async fn catalog_cache_refresh(
    app: tauri::AppHandle,
    request: CatalogRefreshRequest,
) -> Result<CatalogRefreshResult, String> {
    let start = Instant::now();
    let paths = entry_paths(&app, &request.source_id, &request.kind)?;
    let (result, content) = refresh_to_paths(&paths, &request, now_millis()).await?;
    if result.item_count > 0 {
        let ingest_app = app.clone();
        let source_id = request.source_id.clone();
        let kind = request.kind.clone();
        let scope = request.scope.clone();
        let saved_at = result.saved_at;
        let ingested = tauri::async_runtime::spawn_blocking(move || {
            super::catalog_index::ingest(&ingest_app, &source_id, &kind, &scope, saved_at, &content)
        })
        .await;
        match ingested {
            Ok(Ok(_)) => super::catalog_index::notify_updated(&app, &request.kind),
            Ok(Err(error)) => log::warn!("catalog index not updated: {error}"),
            Err(error) => log::warn!("catalog index task failed: {error}"),
        }
    }
    crate::perf::log(
        "rust:catalog_refresh",
        Some(start.elapsed().as_millis()),
        &format!("kind={} items={}", request.kind, result.item_count),
    );
    Ok(result)
}

#[tauri::command(async)]
pub fn catalog_cache_delete(app: tauri::AppHandle, source_id: String) -> Result<(), String> {
    validate_source_id(&source_id)?;
    let directory = cache_directory(&app)?;
    for kind in CATALOG_KINDS {
        remove_entry(&paths_in(&directory, &source_id, kind))
            .map_err(|_| "Could not remove the catalog cache".to_string())?;
    }
    if let Err(error) = super::catalog_index::delete_source(&app, &source_id) {
        log::warn!("catalog index not cleared: {error}");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const SCOPE: &str = "sources-1a2b3c";
    const NOW: u64 = 1_790_000_000_000;

    fn test_directory(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "movena-catalog-cache-{name}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn round_trips_a_provider_list_for_the_same_account() {
        let directory = test_directory("roundtrip");
        let paths = paths_in(&directory, "xtream-one", "vod");
        let content = r#"[{"stream_id":1,"name":"Quoted \"Title\"","rating":"7.4"}]"#;

        store_at(&paths, SCOPE, content, NOW - 1_000).unwrap();

        assert_eq!(
            load_at(&paths, SCOPE, NOW).unwrap(),
            Some(CatalogCacheEntry {
                content: content.to_string(),
                saved_at: NOW - 1_000,
            })
        );
        assert!(!paths.pending_content.exists());
        assert!(!paths.pending_metadata.exists());
        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn ignores_another_accounts_copy_and_keeps_old_ones() {
        let directory = test_directory("scope");
        let paths = paths_in(&directory, "xtream-one", "live");
        store_at(&paths, SCOPE, "[]", NOW - 1_000).unwrap();

        assert_eq!(load_at(&paths, "sources-other", NOW).unwrap(), None);
        assert!(paths.content.exists());

        let a_month_later = NOW + 30 * 24 * 60 * 60 * 1000;
        assert!(load_at(&paths, SCOPE, a_month_later).unwrap().is_some());
        assert!(paths.content.exists());

        assert_eq!(load_at(&paths, SCOPE, NOW - 2_000).unwrap(), None);
        assert!(!paths.content.exists());
        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn reports_missing_copies_as_none_and_damaged_ones_as_errors() {
        let directory = test_directory("damaged");
        let paths = paths_in(&directory, "xtream-one", "series");
        assert_eq!(load_at(&paths, SCOPE, NOW).unwrap(), None);

        std::fs::write(&paths.content, "[]").unwrap();
        assert!(load_at(&paths, SCOPE, NOW).is_err());
        std::fs::write(&paths.metadata, "not-json").unwrap();
        assert!(load_at(&paths, SCOPE, NOW).is_err());
        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn rejects_content_that_is_not_a_list_and_invalid_scopes_or_kinds() {
        let directory = test_directory("invalid");
        let paths = paths_in(&directory, "xtream-one", "vod");

        assert!(store_at(&paths, SCOPE, r#"{"user_info":{}}"#, NOW).is_err());
        assert!(store_at(&paths, SCOPE, "[1,", NOW).is_err());
        assert!(store_at(&paths, "Sources/../x", "[]", NOW).is_err());
        assert!(store_at(&paths, "", "[]", NOW).is_err());
        assert!(!paths.content.exists());
        assert!(validate_kind("vod").is_ok());
        assert!(validate_kind("movies").is_err());
        assert!(validate_kind("../vod").is_err());
        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn accepts_the_size_limit_and_rejects_one_byte_more() {
        assert!(check_size(MAX_CATALOG_BYTES).is_ok());
        assert!(check_size(MAX_CATALOG_BYTES + 1).is_err());
        assert!(check_size(0).is_ok());
    }

    #[test]
    fn deleting_one_kind_leaves_nothing_behind() {
        let directory = test_directory("delete");
        let paths = paths_in(&directory, "xtream-one", "vod");
        store_at(&paths, SCOPE, "[]", NOW).unwrap();
        std::fs::write(&paths.pending_content, "[").unwrap();

        remove_entry(&paths).unwrap();

        for path in [
            &paths.content,
            &paths.metadata,
            &paths.pending_content,
            &paths.pending_metadata,
        ] {
            assert!(!path.exists());
        }
        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn builds_xtream_catalog_urls_and_rejects_invalid_schemes_or_kinds() {
        let url =
            build_xtream_catalog_url("https://panel.test/", "vod", "alice", "p@ss&w").unwrap();
        assert_eq!(url.path(), "/player_api.php");
        let pairs: std::collections::HashMap<_, _> = url.query_pairs().collect();
        assert_eq!(
            pairs.get("action").map(AsRef::as_ref),
            Some("get_vod_streams")
        );
        assert_eq!(pairs.get("username").map(AsRef::as_ref), Some("alice"));
        assert_eq!(pairs.get("password").map(AsRef::as_ref), Some("p@ss&w"));

        assert!(build_xtream_catalog_url("file:///etc/passwd", "vod", "a", "b").is_err());
        assert!(build_xtream_catalog_url("https://panel.test", "movies", "a", "b").is_err());
    }

    #[tokio::test]
    async fn streams_and_commits_catalog_with_backup_server_failover_and_empty_guard() {
        use std::io::{BufRead, BufReader, Write};
        use std::net::TcpListener;

        let failing_listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let failing_addr = failing_listener.local_addr().unwrap();
        let failing_server = std::thread::spawn(move || {
            let (mut socket, _) = failing_listener.accept().unwrap();
            let mut line = String::new();
            let _ = BufReader::new(&socket).read_line(&mut line);
            let _ = write!(
                socket,
                "HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            );
        });

        let backup_listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let backup_addr = backup_listener.local_addr().unwrap();
        let payload = r#"[{"series_id":7,"name":"Streamed Show"}]"#;
        let backup_server = std::thread::spawn(move || {
            // Request 1: valid list. Request 2: empty list (must be rejected once a saved copy exists).
            for body in [payload, "[]"] {
                let (mut socket, _) = backup_listener.accept().unwrap();
                let mut line = String::new();
                BufReader::new(&socket).read_line(&mut line).unwrap();
                assert!(line.contains("action=get_series"));
                write!(
                    socket,
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                )
                .unwrap();
            }
        });

        let directory = test_directory("refresh");
        let paths = paths_in(&directory, "xtream-one", "series");
        let request = CatalogRefreshRequest {
            source_id: "xtream-one".to_string(),
            kind: "series".to_string(),
            scope: SCOPE.to_string(),
            server_urls: vec![
                format!("http://{failing_addr}"),
                format!("http://{backup_addr}"),
            ],
            username: "viewer".to_string(),
            password: "secret".to_string(),
        };

        let (result, content) = refresh_to_paths(&paths, &request, NOW).await.unwrap();
        assert_eq!(result.active_url, format!("http://{backup_addr}"));
        assert_eq!(result.item_count, 1);
        assert_eq!(content, payload);
        assert_eq!(
            load_at(&paths, SCOPE, NOW).unwrap().unwrap().content,
            payload
        );

        // A subsequent empty provider response must fail and preserve the saved copy.
        let empty_request = CatalogRefreshRequest {
            server_urls: vec![format!("http://{backup_addr}")],
            ..request
        };
        assert!(refresh_to_paths(&paths, &empty_request, NOW + 1_000)
            .await
            .is_err());
        assert_eq!(
            load_at(&paths, SCOPE, NOW + 1_000)
                .unwrap()
                .unwrap()
                .content,
            payload
        );

        failing_server.join().unwrap();
        backup_server.join().unwrap();
        let _ = std::fs::remove_dir_all(directory);
    }
}
