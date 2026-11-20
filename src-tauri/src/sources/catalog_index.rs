//! SQLite index over the saved Xtream catalogue lists.
//!
//! Screens that show a handful of titles (the Home rows) ask this index for a
//! small, pre-ordered candidate pool instead of loading and mapping a
//! catalogue of several hundred thousand items in the webview. Rows keep the
//! provider's own JSON object, so the frontend maps them with the same code
//! as the full catalogue and the result is identical. Like the saved copies,
//! the index holds no credentials.

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Instant;

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use serde_json::Value;
use tauri::{Emitter, Manager};

use super::catalog_cache;
use crate::credentials::source::validate_source_id;

const SCHEMA_VERSION: i64 = 2;
const MAX_POOL: u32 = 8_000;
/// Ratings above this are provider noise; matches the frontend's cap.
const MAX_PLAUSIBLE_PROVIDER_RATING: f64 = 9.5;

static CONNECTION: Mutex<Option<Connection>> = Mutex::new(None);
/// One index build at a time, so concurrent requests do not build it twice.
static BUILD: Mutex<()> = Mutex::new(());

fn database_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|_| "Application data is unavailable".to_string())?;
    std::fs::create_dir_all(&directory)
        .map_err(|_| "Could not create the catalog index".to_string())?;
    Ok(directory.join("catalog-index.sqlite"))
}

fn open(path: &PathBuf) -> rusqlite::Result<Connection> {
    let connection = Connection::open(path)?;
    connection.pragma_update(None, "journal_mode", "WAL")?;
    connection.pragma_update(None, "synchronous", "NORMAL")?;
    let version: i64 = connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if version != SCHEMA_VERSION {
        connection.execute_batch(
            "DROP TABLE IF EXISTS items;
             DROP TABLE IF EXISTS lists;",
        )?;
    }
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS lists (
            source_id TEXT NOT NULL,
            kind TEXT NOT NULL,
            scope TEXT NOT NULL,
            saved_at INTEGER NOT NULL,
            PRIMARY KEY (source_id, kind)
         );
         CREATE TABLE IF NOT EXISTS items (
            source_id TEXT NOT NULL,
            kind TEXT NOT NULL,
            ord INTEGER NOT NULL,
            added INTEGER NOT NULL,
            rating REAL,
            category_id TEXT,
            raw TEXT NOT NULL,
            PRIMARY KEY (source_id, kind, ord)
         );
         CREATE INDEX IF NOT EXISTS items_added ON items (source_id, kind, added DESC, ord);
         CREATE INDEX IF NOT EXISTS items_rating ON items (source_id, kind, rating DESC, ord);",
    )?;
    connection.pragma_update(None, "user_version", SCHEMA_VERSION)?;
    Ok(connection)
}

fn with_connection<T>(
    app: &tauri::AppHandle,
    f: impl FnOnce(&mut Connection) -> rusqlite::Result<T>,
) -> Result<T, String> {
    let mut guard = CONNECTION.lock().unwrap_or_else(|e| e.into_inner());
    if guard.is_none() {
        let path = database_path(app)?;
        *guard = Some(open(&path).map_err(|error| format!("Catalog index unavailable: {error}"))?);
    }
    let connection = guard.as_mut().expect("connection was just opened");
    f(connection).map_err(|error| format!("Catalog index error: {error}"))
}

/// JavaScript's `Number.parseInt(value, 10) || 0` for the provider's `added`
/// and `last_modified` fields.
fn leading_integer(value: Option<&Value>) -> i64 {
    match value {
        Some(Value::Number(number)) => number
            .as_i64()
            .or_else(|| number.as_f64().map(|f| f.trunc() as i64))
            .unwrap_or(0),
        Some(Value::String(text)) => {
            let text = text.trim_start();
            let (sign, digits) = match text.strip_prefix('-') {
                Some(rest) => (-1, rest),
                None => (1, text.strip_prefix('+').unwrap_or(text)),
            };
            let digits: String = digits.chars().take_while(char::is_ascii_digit).collect();
            digits.parse::<i64>().map(|n| sign * n).unwrap_or(0)
        }
        _ => 0,
    }
}

/// The frontend's `ratingNumber`: "7.4", "7,4" and "7.4/10" are ratings.
fn rating_number(value: Option<&Value>) -> Option<f64> {
    match value {
        Some(Value::Number(number)) => number.as_f64().filter(|f| f.is_finite()),
        Some(Value::String(text)) => {
            let text = text.trim();
            let text = match text.split_once('/') {
                Some((head, tail)) if tail.trim() == "10" => head.trim_end(),
                Some(_) => return None,
                None => text,
            };
            let (whole, fraction) = match text.find(['.', ',']) {
                Some(at) => (&text[..at], Some(&text[at + 1..])),
                None => (text, None),
            };
            let digits = |part: &str| !part.is_empty() && part.chars().all(|c| c.is_ascii_digit());
            if whole.len() > 3 || !digits(whole) || fraction.is_some_and(|f| !digits(f)) {
                return None;
            }
            text.replace(',', ".").parse::<f64>().ok()
        }
        _ => None,
    }
}

/// The frontend's `parseProviderRating`, so the index ranks by the same value.
fn provider_rating(rating: Option<&Value>, five_point: Option<&Value>) -> Option<f64> {
    let ten = rating_number(rating);
    let five = rating_number(five_point);
    let value = match (ten, five) {
        (Some(t), f) if t > 0.0 && t <= 10.0 => {
            let five_point_scale = t <= 5.0 && f.is_some_and(|f| (t - f).abs() < 0.05);
            if five_point_scale {
                t * 2.0
            } else {
                t
            }
        }
        (_, Some(f)) if f > 0.0 && f <= 5.0 => f * 2.0,
        _ => return None,
    };
    let rounded = (value * 10.0).round() / 10.0;
    (rounded <= MAX_PLAUSIBLE_PROVIDER_RATING).then_some(rounded)
}

fn has_provider_id(kind: &str, item: &Value) -> bool {
    let key = if kind == "series" {
        "series_id"
    } else {
        "stream_id"
    };
    match item.get(key) {
        Some(Value::Number(_)) => true,
        Some(Value::String(text)) => !text.trim().is_empty(),
        _ => false,
    }
}

fn category_of(item: &Value) -> Option<String> {
    match item.get("category_id") {
        Some(Value::Number(number)) => Some(number.to_string()),
        Some(Value::String(text)) if !text.is_empty() => Some(text.clone()),
        _ => None,
    }
}

/// Replace one source's list in the index. Runs in a single transaction, so
/// readers keep seeing the previous list until the new one is complete.
pub(crate) fn ingest(
    app: &tauri::AppHandle,
    source_id: &str,
    kind: &str,
    scope: &str,
    saved_at: u64,
    content: &str,
) -> Result<usize, String> {
    let start = Instant::now();
    let list: Vec<&RawValue> =
        serde_json::from_str(content).map_err(|_| "The catalog is not a JSON list".to_string())?;
    let added_key = if kind == "series" {
        "last_modified"
    } else {
        "added"
    };
    let count = with_connection(app, |connection| {
        let transaction = connection.transaction()?;
        transaction.execute(
            "DELETE FROM items WHERE source_id = ?1 AND kind = ?2",
            params![source_id, kind],
        )?;
        let mut inserted = 0usize;
        {
            let mut insert = transaction.prepare(
                "INSERT INTO items (source_id, kind, ord, added, rating, category_id, raw)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            )?;
            for (ord, raw) in list.iter().enumerate() {
                let Ok(item) = serde_json::from_str::<Value>(raw.get()) else {
                    continue;
                };
                // Items without a provider id get positional ids in the
                // catalogue mapping; those would not match here, so they are
                // left to the full catalogue.
                if !item.is_object() || !has_provider_id(kind, &item) {
                    continue;
                }
                insert.execute(params![
                    source_id,
                    kind,
                    ord as i64,
                    leading_integer(item.get(added_key)),
                    provider_rating(item.get("rating"), item.get("rating_5based")),
                    category_of(&item),
                    raw.get(),
                ])?;
                inserted += 1;
            }
        }
        transaction.execute(
            "INSERT INTO lists (source_id, kind, scope, saved_at) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT (source_id, kind) DO UPDATE SET scope = ?3, saved_at = ?4",
            params![source_id, kind, scope, saved_at as i64],
        )?;
        transaction.commit()?;
        Ok(inserted)
    })?;
    crate::perf::log(
        "rust:index_ingest",
        Some(start.elapsed().as_millis()),
        &format!("kind={kind} items={count}"),
    );
    Ok(count)
}

pub(crate) fn delete_source(app: &tauri::AppHandle, source_id: &str) -> Result<(), String> {
    with_connection(app, |connection| {
        connection.execute("DELETE FROM items WHERE source_id = ?1", params![source_id])?;
        connection.execute("DELETE FROM lists WHERE source_id = ?1", params![source_id])?;
        Ok(())
    })
}

fn indexed_scope(
    app: &tauri::AppHandle,
    source_id: &str,
    kind: &str,
) -> Result<Option<String>, String> {
    with_connection(app, |connection| {
        connection
            .query_row(
                "SELECT scope FROM lists WHERE source_id = ?1 AND kind = ?2",
                params![source_id, kind],
                |row| row.get(0),
            )
            .optional()
    })
}

/// Make sure the index holds this account's list, building it from the saved
/// copy when needed. `false` when there is no saved copy to build from.
fn ensure_indexed(
    app: &tauri::AppHandle,
    source_id: &str,
    kind: &str,
    scope: &str,
) -> Result<bool, String> {
    if indexed_scope(app, source_id, kind)?.as_deref() == Some(scope) {
        return Ok(true);
    }
    let _build = BUILD.lock().unwrap_or_else(|e| e.into_inner());
    if indexed_scope(app, source_id, kind)?.as_deref() == Some(scope) {
        return Ok(true);
    }
    match catalog_cache::load_saved(app, source_id, kind, scope)? {
        Some((content, saved_at)) => {
            ingest(app, source_id, kind, scope, saved_at, &content)?;
            Ok(true)
        }
        None => Ok(false),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexSource {
    source_id: String,
    scope: String,
    /// The provider's own category ids (not Movena's prefixed ones).
    #[serde(default)]
    hidden_category_ids: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexRow {
    source_id: String,
    raw: Box<RawValue>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexRows {
    /// False when some source has neither an index nor a saved copy yet.
    ready: bool,
    rows: Vec<IndexRow>,
}

fn order_clause(order: &str) -> Result<&'static str, String> {
    match order {
        "added" => Ok("added DESC, ord ASC"),
        "rating" => Ok("rating DESC, ord ASC"),
        "provider" => Ok("ord ASC"),
        _ => Err("Invalid catalog index order".to_string()),
    }
}

/// A pre-ordered candidate pool of at most `limit` items per source, with the
/// user's hidden categories left out.
#[tauri::command(async)]
pub fn catalog_index_rows(
    app: tauri::AppHandle,
    kind: String,
    sources: Vec<IndexSource>,
    order: String,
    limit: u32,
) -> Result<IndexRows, String> {
    let start = Instant::now();
    catalog_cache::validate_kind_public(&kind)?;
    let by_rating = order == "rating";
    let order = order_clause(&order)?;
    let limit = limit.min(MAX_POOL);
    let mut rows = Vec::new();
    for source in &sources {
        validate_source_id(&source.source_id)?;
        if !ensure_indexed(&app, &source.source_id, &kind, &source.scope)? {
            return Ok(IndexRows {
                ready: false,
                rows: Vec::new(),
            });
        }
        let hidden = serde_json::to_string(&source.hidden_category_ids)
            .map_err(|_| "Invalid hidden categories".to_string())?;
        let mut source_rows = with_connection(&app, |connection| {
            const VISIBLE: &str = "source_id = ?1 AND kind = ?2
                   AND (category_id IS NULL
                        OR category_id NOT IN (SELECT value FROM json_each(?3)))";
            if by_rating {
                // The frontend breaks rating ties by year and title, which the
                // index does not know, so the pool takes every item tied with
                // the last one it needs.
                let threshold: Option<f64> = connection
                    .query_row(
                        &format!(
                            "SELECT rating FROM items WHERE {VISIBLE} AND rating IS NOT NULL
                             ORDER BY rating DESC, ord ASC LIMIT 1 OFFSET ?4"
                        ),
                        params![source.source_id, kind, hidden, limit.saturating_sub(1)],
                        |row| row.get(0),
                    )
                    .optional()?;
                let mut statement = connection.prepare_cached(&format!(
                    "SELECT raw FROM items WHERE {VISIBLE} AND rating IS NOT NULL AND rating >= ?4
                     ORDER BY rating DESC, ord ASC LIMIT ?5"
                ))?;
                let raws = statement
                    .query_map(
                        params![
                            source.source_id,
                            kind,
                            hidden,
                            threshold.unwrap_or(0.0),
                            MAX_POOL
                        ],
                        |row| row.get::<_, String>(0),
                    )?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                return Ok(raws);
            }
            let mut statement = connection.prepare_cached(&format!(
                "SELECT raw FROM items WHERE {VISIBLE} ORDER BY {order} LIMIT ?4"
            ))?;
            let raws = statement
                .query_map(params![source.source_id, kind, hidden, limit], |row| {
                    row.get::<_, String>(0)
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(raws)
        })?
        .into_iter()
        .filter_map(|raw| {
            RawValue::from_string(raw).ok().map(|raw| IndexRow {
                source_id: source.source_id.clone(),
                raw,
            })
        })
        .collect::<Vec<_>>();
        rows.append(&mut source_rows);
    }
    crate::perf::log(
        "rust:index_rows",
        Some(start.elapsed().as_millis()),
        &format!("kind={kind} rows={}", rows.len()),
    );
    Ok(IndexRows { ready: true, rows })
}

/// Tell the frontend a list in the index changed, so views built on it reload.
pub(crate) fn notify_updated(app: &tauri::AppHandle, kind: &str) {
    let _ = app.emit("catalog-index-updated", kind);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_added_like_javascript_parse_int() {
        assert_eq!(
            leading_integer(Some(&Value::from("1700000000"))),
            1_700_000_000
        );
        assert_eq!(leading_integer(Some(&Value::from("2023-01-02"))), 2023);
        assert_eq!(leading_integer(Some(&Value::from(""))), 0);
        assert_eq!(leading_integer(Some(&Value::from(42))), 42);
        assert_eq!(leading_integer(None), 0);
    }

    #[test]
    fn reads_provider_ratings_like_the_frontend() {
        let r = |rating: Value, five: Value| provider_rating(Some(&rating), Some(&five));
        assert_eq!(r(Value::from("7.5"), Value::Null), Some(7.5));
        assert_eq!(r(Value::from("7,5"), Value::Null), Some(7.5));
        assert_eq!(r(Value::from("7.4/10"), Value::Null), Some(7.4));
        assert_eq!(r(Value::from(""), Value::Null), None);
        assert_eq!(r(Value::from("0"), Value::Null), None);
        assert_eq!(r(Value::from(8), Value::Null), Some(8.0));
        // Written on the five-point scale: the companion carries the same value.
        assert_eq!(r(Value::from("4.5"), Value::from("4.5")), Some(9.0));
        assert_eq!(r(Value::from("4.5"), Value::from("2.3")), Some(4.5));
        // Only the five-point value is usable.
        assert_eq!(r(Value::from(""), Value::from("4")), Some(8.0));
        // Above the plausibility cap, or not a rating.
        assert_eq!(r(Value::from("9.8"), Value::Null), None);
        assert_eq!(r(Value::from("abc"), Value::Null), None);
        assert_eq!(r(Value::from("1234"), Value::Null), None);
    }

    #[test]
    fn requires_a_provider_id() {
        let movie: Value = serde_json::json!({ "stream_id": 7 });
        let series: Value = serde_json::json!({ "series_id": "9" });
        let missing: Value = serde_json::json!({ "name": "x" });
        assert!(has_provider_id("vod", &movie));
        assert!(has_provider_id("series", &series));
        assert!(!has_provider_id("vod", &missing));
    }
}
