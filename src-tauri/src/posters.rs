//! Poster thumbnails for the card grid.
//!
//! Providers serve posters at 600-1000+ px, and WebKitGTK decodes and uploads
//! every one at full size while a grid scrolls, which dropped about a third of
//! the frames. The `poster://` scheme fetches a poster, shrinks it to what a
//! card can show, and keeps the result on disk, so the webview only ever
//! decodes a small JPEG. The frontend falls back to the original URL if a
//! poster cannot be fetched or decoded here.

use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::{Duration, SystemTime};

use tauri::http::{header, Request, Response, StatusCode};
use tauri::{Manager, Runtime, UriSchemeContext, UriSchemeResponder};
use tokio::sync::Semaphore;

pub const SCHEME: &str = "poster";

const DEFAULT_WIDTH: u32 = 400;
const MIN_WIDTH: u32 = 64;
const MAX_WIDTH: u32 = 1200;
const MAX_SOURCE_BYTES: usize = 20 * 1024 * 1024;
// Under the webview's 8 s poster deadline, so a hung host fails here first.
const FETCH_TIMEOUT: Duration = Duration::from_secs(7);
const MAX_AGE: Duration = Duration::from_secs(60 * 60 * 24 * 30);
const JPEG_QUALITY: u8 = 85;
const USER_AGENT: &str =
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";

fn fetch_slots() -> &'static Semaphore {
    static SLOTS: OnceLock<Semaphore> = OnceLock::new();
    SLOTS.get_or_init(|| Semaphore::new(8))
}

fn resize_slots() -> &'static Semaphore {
    static SLOTS: OnceLock<Semaphore> = OnceLock::new();
    SLOTS.get_or_init(|| Semaphore::new(3))
}

fn client() -> Result<&'static reqwest::Client, StatusCode> {
    static CLIENT: OnceLock<Option<reqwest::Client>> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            reqwest::Client::builder()
                .user_agent(USER_AGENT)
                .timeout(FETCH_TIMEOUT)
                .build()
                .ok()
        })
        .as_ref()
        .ok_or(StatusCode::INTERNAL_SERVER_ERROR)
}

/// FNV-1a: a stable file name for a URL (the std hasher is not stable).
fn fnv1a(text: &str) -> u64 {
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in text.bytes() {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

fn hex_decode(text: &str) -> Option<String> {
    if text.len() % 2 != 0 || text.is_empty() {
        return None;
    }
    let mut bytes = Vec::with_capacity(text.len() / 2);
    for pair in text.as_bytes().chunks(2) {
        let high = (pair[0] as char).to_digit(16)?;
        let low = (pair[1] as char).to_digit(16)?;
        bytes.push((high * 16 + low) as u8);
    }
    String::from_utf8(bytes).ok()
}

fn width_from_query(query: Option<&str>) -> u32 {
    query
        .and_then(|query| {
            query
                .split('&')
                .find_map(|pair| pair.strip_prefix("w=")?.parse::<u32>().ok())
        })
        .unwrap_or(DEFAULT_WIDTH)
        .clamp(MIN_WIDTH, MAX_WIDTH)
}

fn cache_path(cache_dir: &std::path::Path, url: &str, width: u32) -> PathBuf {
    cache_dir.join(format!("{:016x}_{width}.jpg", fnv1a(url)))
}

/// Drop thumbnails older than `MAX_AGE`, once per run.
fn prune(cache_dir: PathBuf) {
    static DONE: OnceLock<()> = OnceLock::new();
    if DONE.set(()).is_err() {
        return;
    }
    std::thread::spawn(move || {
        // Keep the cache walk off the startup disk I/O path.
        std::thread::sleep(Duration::from_secs(30));
        let Ok(entries) = std::fs::read_dir(&cache_dir) else {
            return;
        };
        for entry in entries.flatten() {
            let old = entry
                .metadata()
                .and_then(|meta| meta.modified())
                .ok()
                .and_then(|modified| SystemTime::now().duration_since(modified).ok())
                .is_some_and(|age| age > MAX_AGE);
            if old {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    });
}

fn shrink(source: &[u8], width: u32) -> Result<Vec<u8>, StatusCode> {
    let image = image::load_from_memory(source).map_err(|_| StatusCode::UNSUPPORTED_MEDIA_TYPE)?;
    // Never enlarge: a small cover stays as it is, so weak-poster detection
    // still sees its real size.
    let image = if image.width() > width {
        image.thumbnail(width, width.saturating_mul(3))
    } else {
        image
    };
    let rgb = image.to_rgb8();
    let mut out = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, JPEG_QUALITY)
        .encode_image(&rgb)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(out)
}

async fn thumbnail(cache_dir: PathBuf, url: String, width: u32) -> Result<Vec<u8>, StatusCode> {
    let path = cache_path(&cache_dir, &url, width);
    if let Ok(bytes) = tokio::fs::read(&path).await {
        return Ok(bytes);
    }

    let source = {
        let _slot = fetch_slots()
            .acquire()
            .await
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        let response = client()?
            .get(&url)
            .send()
            .await
            .map_err(|_| StatusCode::BAD_GATEWAY)?;
        if !response.status().is_success() {
            return Err(StatusCode::BAD_GATEWAY);
        }
        if response
            .content_length()
            .is_some_and(|length| length as usize > MAX_SOURCE_BYTES)
        {
            return Err(StatusCode::PAYLOAD_TOO_LARGE);
        }
        let bytes = response
            .bytes()
            .await
            .map_err(|_| StatusCode::BAD_GATEWAY)?;
        if bytes.len() > MAX_SOURCE_BYTES {
            return Err(StatusCode::PAYLOAD_TOO_LARGE);
        }
        bytes
    };

    let _slot = resize_slots()
        .acquire()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let out = tauri::async_runtime::spawn_blocking(move || shrink(&source, width))
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)??;

    let _ = tokio::fs::create_dir_all(&cache_dir).await;
    let temporary = path.with_extension("tmp");
    if tokio::fs::write(&temporary, &out).await.is_ok() {
        let _ = tokio::fs::rename(&temporary, &path).await;
    }
    Ok(out)
}

fn respond(status: StatusCode, body: Vec<u8>) -> Response<Vec<u8>> {
    let mut builder = Response::builder()
        .status(status)
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*");
    if status == StatusCode::OK {
        builder = builder
            .header(header::CONTENT_TYPE, "image/jpeg")
            .header(header::CACHE_CONTROL, "public, max-age=2592000");
    }
    builder
        .body(body)
        .unwrap_or_else(|_| Response::new(Vec::new()))
}

/// Handler for `poster://localhost/<hex of the poster URL>?w=<width>`.
pub fn handle<R: Runtime>(
    context: UriSchemeContext<'_, R>,
    request: Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    let uri = request.uri();
    let url = hex_decode(uri.path().trim_start_matches('/'));
    let width = width_from_query(uri.query());
    let cache_dir = context
        .app_handle()
        .path()
        .app_cache_dir()
        .ok()
        .map(|dir| dir.join("posters"));

    tauri::async_runtime::spawn(async move {
        let result = match (url, cache_dir) {
            (Some(url), Some(cache_dir))
                if url.starts_with("http://") || url.starts_with("https://") =>
            {
                prune(cache_dir.clone());
                thumbnail(cache_dir, url, width).await
            }
            _ => Err(StatusCode::BAD_REQUEST),
        };
        responder.respond(match result {
            Ok(bytes) => respond(StatusCode::OK, bytes),
            Err(status) => respond(status, Vec::new()),
        });
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_hex_urls_and_rejects_bad_input() {
        assert_eq!(
            hex_decode("68747470733a2f2f612e62").as_deref(),
            Some("https://a.b")
        );
        assert_eq!(hex_decode(""), None);
        assert_eq!(hex_decode("abc"), None);
        assert_eq!(hex_decode("zz"), None);
    }

    #[test]
    fn width_is_clamped_and_defaults() {
        assert_eq!(width_from_query(None), DEFAULT_WIDTH);
        assert_eq!(width_from_query(Some("w=300")), 300);
        assert_eq!(width_from_query(Some("w=1")), MIN_WIDTH);
        assert_eq!(width_from_query(Some("w=99999")), MAX_WIDTH);
        assert_eq!(width_from_query(Some("x=1&w=250")), 250);
    }

    #[test]
    fn shrinks_large_images_and_keeps_small_ones() {
        let mut big = Vec::new();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut big, 90)
            .encode_image(&image::RgbImage::new(800, 1200))
            .unwrap();
        let small = shrink(&big, 400).unwrap();
        let decoded = image::load_from_memory(&small).unwrap();
        assert_eq!((decoded.width(), decoded.height()), (400, 600));

        let kept = shrink(&small, 400).unwrap();
        let again = image::load_from_memory(&kept).unwrap();
        assert_eq!(again.width(), 400);
        assert_eq!(
            shrink(b"not an image", 400),
            Err(StatusCode::UNSUPPORTED_MEDIA_TYPE)
        );
    }
}
