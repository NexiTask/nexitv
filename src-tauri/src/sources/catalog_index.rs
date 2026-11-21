//! SQLite index over the saved Xtream catalogue lists.
//!
//! Screens that show a handful of titles (the Home rows) ask this index for a
//! small, pre-ordered candidate pool instead of loading and mapping a
//! catalogue of several hundred thousand items in the webview. Rows keep the
//! provider's own JSON object, so the frontend maps them with the same code
//! as the full catalogue and the result is identical. Like the saved copies,
//! the index holds no credentials.
//!
//! The Movies and Series pages are served from it too. Each row also keeps
//! the facets those pages filter and sort by (`f_*` columns). The frontend
//! derives them in a worker with the catalogue's own mapping and filter
//! functions, so they match the full catalogue exactly; ingest carries them
//! over for rows whose provider JSON did not change. Name ranks (`f_rank`)
//! order titles by the webview's collator across every indexed source of a
//! kind, so they compare across sources.

use std::collections::hash_map::DefaultHasher;
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use serde_json::Value;
use tauri::{Emitter, Manager};

use super::catalog_cache;
use super::catalog_query::{
    self, CatalogQuery, CatalogStats, FacetRow, SourceFacets, MAX_SOURCES, ORD_BITS,
};
use super::catalog_search::normalize_text;
use crate::credentials::source::validate_source_id;

const SCHEMA_VERSION: i64 = 5;
/// Rows returned with a page so its first screen needs no second request.
const PAGE_HEAD_ROWS: usize = 120;
const MAX_ROWS_PER_REQUEST: usize = 2_000;
const MAX_FACET_BATCH: u32 = 20_000;
const MAX_POOL: u32 = 8_000;
/// Ratings above this are provider noise; matches the frontend's cap.
const MAX_PLAUSIBLE_PROVIDER_RATING: f64 = 9.5;

static CONNECTION: Mutex<Option<Connection>> = Mutex::new(None);
/// Page reads use their own connection, so they are not queued behind an
/// ingest; WAL shows them the last committed state.
static READER: Mutex<Option<Connection>> = Mutex::new(None);
/// Facets loaded for queries, per (source, kind), valid for one generation.
type FacetCache = HashMap<(String, String), Arc<SourceFacets>>;
static FACETS: Mutex<Option<FacetCache>> = Mutex::new(None);
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
        // Facets are re-derived from the stored provider JSON and the IMDb
        // pipeline keeps its own database, so a rebuild costs no downloads;
        // the version bump replays the facet build once (see
        // metadata::imdb for the match-key column).
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
            generation INTEGER NOT NULL DEFAULT 0,
            skipped INTEGER NOT NULL DEFAULT 0,
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
            raw_hash INTEGER NOT NULL,
            f_id TEXT,
            f_title TEXT,
            f_category TEXT,
            f_added REAL,
            f_has_added INTEGER,
            f_year REAL,
            f_rating REAL,
            f_flags INTEGER,
            f_genres INTEGER,
            f_rank INTEGER,
            f_fold_key TEXT,
            f_fold_rank INTEGER,
            f_match_key TEXT,
            imdb_tconst TEXT,
            imdb_rating REAL,
            imdb_votes INTEGER,
            imdb_adult INTEGER,
            imdb_runtime INTEGER,
            imdb_genres TEXT,
            PRIMARY KEY (source_id, kind, ord)
         );
         CREATE INDEX IF NOT EXISTS items_added ON items (source_id, kind, added DESC, ord);
         CREATE INDEX IF NOT EXISTS items_rating ON items (source_id, kind, rating DESC, ord);
         CREATE INDEX IF NOT EXISTS items_imdb ON items (source_id, kind, imdb_rating DESC, ord)
            WHERE imdb_rating IS NOT NULL;
         CREATE INDEX IF NOT EXISTS items_unranked ON items (source_id, kind, ord)
            WHERE f_rank IS NULL;",
    )?;
    connection.pragma_update(None, "user_version", SCHEMA_VERSION)?;
    Ok(connection)
}

pub(crate) fn with_reader<T>(
    app: &tauri::AppHandle,
    f: impl FnOnce(&Connection) -> rusqlite::Result<T>,
) -> Result<T, String> {
    let mut guard = READER.lock().unwrap_or_else(|e| e.into_inner());
    if guard.is_none() {
        // The writer creates or migrates the schema first.
        with_connection(app, |_| Ok(()))?;
        let path = database_path(app)?;
        let connection = Connection::open(&path)
            .and_then(|connection| {
                connection.pragma_update(None, "query_only", true)?;
                Ok(connection)
            })
            .map_err(|error| format!("Catalog index unavailable: {error}"))?;
        *guard = Some(connection);
    }
    let connection = guard.as_ref().expect("reader was just opened");
    f(connection).map_err(|error| format!("Catalog index error: {error}"))
}

pub(crate) fn with_connection<T>(
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
        ingest_into(
            connection, source_id, kind, scope, saved_at, &list, added_key,
        )
    })?;
    crate::perf::log(
        "rust:index_ingest",
        Some(start.elapsed().as_millis()),
        &format!("kind={kind} items={count}"),
    );
    Ok(count)
}

fn ingest_into(
    connection: &mut Connection,
    source_id: &str,
    kind: &str,
    scope: &str,
    saved_at: u64,
    list: &[&RawValue],
    added_key: &str,
) -> rusqlite::Result<usize> {
    {
        let transaction = connection.transaction()?;
        // Facets depend on the row's JSON alone, so unchanged rows keep theirs.
        let carried = carried_facets(&transaction, source_id, kind)?;
        transaction.execute(
            "DELETE FROM items WHERE source_id = ?1 AND kind = ?2",
            params![source_id, kind],
        )?;
        let mut inserted = 0usize;
        {
            let mut insert = transaction.prepare(
                "INSERT INTO items (source_id, kind, ord, added, rating, category_id, raw,
                    raw_hash, f_id, f_title, f_category, f_added, f_has_added, f_year,
                    f_rating, f_flags, f_genres, f_rank, f_fold_key, f_fold_rank,
                    f_match_key, imdb_tconst)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15,
                    ?16, ?17, ?18, ?19, ?20, ?21, ?22)",
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
                let hash = raw_hash(raw.get());
                let facets = carried.get(&hash);
                insert.execute(params![
                    source_id,
                    kind,
                    ord as i64,
                    leading_integer(item.get(added_key)),
                    provider_rating(item.get("rating"), item.get("rating_5based")),
                    category_of(&item),
                    raw.get(),
                    hash,
                    facets.map(|f| &f.id),
                    facets.map(|f| &f.title),
                    facets.and_then(|f| f.category.as_ref()),
                    facets.map(|f| f.added),
                    facets.map(|f| f.has_added),
                    facets.and_then(|f| f.year),
                    facets.and_then(|f| f.rating),
                    facets.map(|f| f.flags),
                    facets.map(|f| f.genres),
                    facets.and_then(|f| f.rank),
                    facets.and_then(|f| f.fold_key.as_ref()),
                    facets.map(|f| f.fold_rank),
                    // The match key arrives with the facet build; a provider
                    // IMDb id can be filled right away.
                    facets.and_then(|f| f.match_key.as_ref()),
                    crate::metadata::imdb::imdb_id_of(&item),
                ])?;
                inserted += 1;
            }
        }
        let skipped = (list.len() - inserted) as i64;
        transaction.execute(
            "INSERT INTO lists (source_id, kind, scope, saved_at, generation, skipped)
             VALUES (?1, ?2, ?3, ?4, 1, ?5)
             ON CONFLICT (source_id, kind) DO UPDATE SET scope = ?3, saved_at = ?4,
                generation = lists.generation + 1, skipped = ?5",
            params![source_id, kind, scope, saved_at as i64, skipped],
        )?;
        transaction.commit()?;
        Ok(inserted)
    }
}

/// Facets a row keeps across ingests, keyed by its JSON's hash.
struct StoredFacets {
    id: String,
    title: String,
    category: Option<String>,
    added: f64,
    has_added: i64,
    year: Option<f64>,
    rating: Option<f64>,
    flags: i64,
    genres: i64,
    rank: Option<i64>,
    fold_key: Option<String>,
    fold_rank: i64,
    match_key: Option<String>,
}

fn raw_hash(raw: &str) -> i64 {
    let mut hasher = DefaultHasher::new();
    raw.hash(&mut hasher);
    hasher.finish() as i64
}

fn carried_facets(
    connection: &Connection,
    source_id: &str,
    kind: &str,
) -> rusqlite::Result<HashMap<i64, StoredFacets>> {
    let mut statement = connection.prepare(
        "SELECT raw_hash, f_id, f_title, f_category, f_added, f_has_added, f_year, f_rating,
            f_flags, f_genres, f_rank, f_fold_key, f_fold_rank, f_match_key
         FROM items WHERE source_id = ?1 AND kind = ?2 AND f_id IS NOT NULL",
    )?;
    let rows = statement.query_map(params![source_id, kind], |row| {
        Ok((
            row.get::<_, i64>(0)?,
            StoredFacets {
                id: row.get(1)?,
                title: row.get(2)?,
                category: row.get(3)?,
                added: row.get(4)?,
                has_added: row.get(5)?,
                year: row.get(6)?,
                rating: row.get(7)?,
                flags: row.get(8)?,
                genres: row.get(9)?,
                rank: row.get(10)?,
                fold_key: row.get(11)?,
                fold_rank: row.get::<_, Option<i64>>(12)?.unwrap_or(0),
                match_key: row.get(13)?,
            },
        ))
    })?;
    rows.collect()
}

pub(crate) fn delete_source(app: &tauri::AppHandle, source_id: &str) -> Result<(), String> {
    with_connection(app, |connection| {
        connection.execute("DELETE FROM items WHERE source_id = ?1", params![source_id])?;
        connection.execute("DELETE FROM lists WHERE source_id = ?1", params![source_id])?;
        Ok(())
    })
}

/// The keys and provider IMDb ids the catalogue's IMDb pipeline can match
/// against: every facet match key, plus the IMDb ids the ingest picked out of
/// provider JSON. The dumps are pre-filtered to these, which is what keeps
/// `imdb.sqlite` at megabytes instead of gigabytes.
pub(crate) fn match_universe(
    app: &tauri::AppHandle,
) -> Result<
    (
        std::collections::HashSet<String>,
        std::collections::HashSet<String>,
    ),
    String,
> {
    with_reader(app, |connection| {
        let keys: std::collections::HashSet<String> = connection
            .prepare("SELECT DISTINCT f_match_key FROM items WHERE f_match_key IS NOT NULL")?
            .query_map([], |row| row.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        let tt_ids: std::collections::HashSet<String> = connection
            .prepare("SELECT DISTINCT imdb_tconst FROM items WHERE imdb_tconst IS NOT NULL")?
            .query_map([], |row| row.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        Ok((keys, tt_ids))
    })
}

fn indexed_scope(
    app: &tauri::AppHandle,
    source_id: &str,
    kind: &str,
) -> Result<Option<String>, String> {
    with_reader(app, |connection| {
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

// ---------------------------------------------------------------------------
// Movies and Series pages
// ---------------------------------------------------------------------------

fn validate_page_kind(kind: &str) -> Result<(), String> {
    match kind {
        "live" | "vod" | "series" => Ok(()),
        _ => Err("Invalid catalog page kind".to_string()),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageSource {
    source_id: String,
    scope: String,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PageStatus {
    /// `ready`, `building` (facets still being derived) or `unavailable`
    /// (no saved copy, or rows the index cannot represent).
    state: &'static str,
    /// Rows still waiting for facets or a name rank.
    pending: u64,
    total: u64,
}

enum SourceState {
    Ready(Arc<SourceFacets>),
    Building { pending: u64, total: u64 },
    Unavailable,
}

fn facet_cache_get(source_id: &str, kind: &str, generation: i64) -> Option<Arc<SourceFacets>> {
    let guard = FACETS.lock().unwrap_or_else(|e| e.into_inner());
    guard
        .as_ref()?
        .get(&(source_id.to_string(), kind.to_string()))
        .filter(|facets| facets.generation == generation)
        .cloned()
}

fn facet_cache_put(source_id: &str, kind: &str, facets: Arc<SourceFacets>) {
    let mut guard = FACETS.lock().unwrap_or_else(|e| e.into_inner());
    guard
        .get_or_insert_with(HashMap::new)
        .insert((source_id.to_string(), kind.to_string()), facets);
}

/// Drop the cached facets so the next page read reloads them with the IMDb
/// columns the backfill just filled.
pub(crate) fn invalidate_imdb_facets() {
    *FACETS.lock().unwrap_or_else(|e| e.into_inner()) = None;
}

fn list_generation(
    connection: &Connection,
    source_id: &str,
    kind: &str,
) -> rusqlite::Result<Option<(i64, i64)>> {
    connection
        .query_row(
            "SELECT generation, skipped FROM lists WHERE source_id = ?1 AND kind = ?2",
            params![source_id, kind],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
}

/// Reads one source's facets in a single read transaction, so the rows and
/// the generation they are cached under belong together.
fn read_source_facets(
    connection: &Connection,
    source_id: &str,
    kind: &str,
) -> rusqlite::Result<SourceState> {
    let transaction = connection.unchecked_transaction()?;
    let Some((generation, skipped)) = list_generation(&transaction, source_id, kind)? else {
        return Ok(SourceState::Unavailable);
    };
    if skipped > 0 {
        return Ok(SourceState::Unavailable);
    }
    if let Some(facets) = facet_cache_get(source_id, kind, generation) {
        return Ok(SourceState::Ready(facets));
    }
    let (pending, total): (u64, u64) = transaction.query_row(
        "SELECT (SELECT COUNT(*) FROM items WHERE source_id = ?1 AND kind = ?2
                    AND f_rank IS NULL),
                (SELECT COUNT(*) FROM items WHERE source_id = ?1 AND kind = ?2)",
        params![source_id, kind],
        |row| Ok((row.get::<_, i64>(0)? as u64, row.get::<_, i64>(1)? as u64)),
    )?;
    if pending > 0 {
        return Ok(SourceState::Building { pending, total });
    }
    let mut statement = transaction.prepare(
        "SELECT ord, f_id, f_category, f_added, f_has_added, f_year, f_rating, f_flags,
            f_genres, f_rank, f_fold_key, f_fold_rank, f_title, imdb_rating, imdb_votes,
            imdb_tconst
         FROM items WHERE source_id = ?1 AND kind = ?2 ORDER BY ord",
    )?;
    let mut categories: Vec<Box<str>> = Vec::new();
    let mut category_index: HashMap<String, u32> = HashMap::new();
    let mut rows = Vec::with_capacity(total as usize);
    let mut query = statement.query(params![source_id, kind])?;
    while let Some(row) = query.next()? {
        let ord: i64 = row.get(0)?;
        let id: Option<String> = row.get(1)?;
        let Some(id) = id.filter(|_| (0..(1 << ORD_BITS)).contains(&ord)) else {
            return Ok(SourceState::Unavailable);
        };
        let category = row.get::<_, Option<String>>(2)?.map(|name| {
            *category_index.entry(name).or_insert_with_key(|name| {
                categories.push(name.as_str().into());
                (categories.len() - 1) as u32
            })
        });
        rows.push(FacetRow {
            ord: ord as u32,
            id: id.into(),
            category,
            added: row.get(3)?,
            has_added: row.get::<_, i64>(4)? != 0,
            year: row.get(5)?,
            rating: row.get(6)?,
            flags: row.get::<_, i64>(7)? as u8,
            genres: row.get::<_, i64>(8)? as u16,
            rank: row.get::<_, i64>(9)? as u32,
            fold_key: row
                .get::<_, Option<String>>(10)?
                .map(String::into_boxed_str),
            fold_rank: row.get::<_, Option<i64>>(11)?.unwrap_or(0) as u8,
            search_title: normalize_text(&row.get::<_, Option<String>>(12)?.unwrap_or_default())
                .into(),
            imdb_rating: row.get(13)?,
            imdb_votes: row.get::<_, Option<i64>>(14)?.map(|votes| votes as f64),
            imdb_tconst: row
                .get::<_, Option<String>>(15)?
                .map(String::into_boxed_str),
        });
    }
    drop(query);
    drop(statement);
    transaction.finish()?;
    let facets = Arc::new(SourceFacets {
        generation,
        rows,
        categories,
    });
    facet_cache_put(source_id, kind, facets.clone());
    Ok(SourceState::Ready(facets))
}

/// Every source's facets, or the reason the pages cannot use the index yet.
fn page_sources(
    app: &tauri::AppHandle,
    kind: &str,
    sources: &[PageSource],
) -> Result<Result<Vec<Arc<SourceFacets>>, PageStatus>, String> {
    validate_page_kind(kind)?;
    if sources.is_empty() || sources.len() > MAX_SOURCES {
        return Ok(Err(PageStatus {
            state: "unavailable",
            pending: 0,
            total: 0,
        }));
    }
    let mut ready = Vec::with_capacity(sources.len());
    let (mut pending, mut total) = (0u64, 0u64);
    let mut unavailable = false;
    for source in sources {
        validate_source_id(&source.source_id)?;
        if !ensure_indexed(app, &source.source_id, kind, &source.scope)? {
            unavailable = true;
            continue;
        }
        match with_reader(app, |c| read_source_facets(c, &source.source_id, kind))? {
            SourceState::Ready(facets) => {
                total += facets.rows.len() as u64;
                ready.push(facets);
            }
            SourceState::Building {
                pending: waiting,
                total: rows,
            } => {
                pending += waiting;
                total += rows;
            }
            SourceState::Unavailable => unavailable = true,
        }
    }
    if unavailable {
        return Ok(Err(PageStatus {
            state: "unavailable",
            pending,
            total,
        }));
    }
    if pending > 0 {
        return Ok(Err(PageStatus {
            state: "building",
            pending,
            total,
        }));
    }
    Ok(Ok(ready))
}

fn generation_token(facets: &[Arc<SourceFacets>]) -> String {
    facets
        .iter()
        .map(|f| f.generation.to_string())
        .collect::<Vec<_>>()
        .join(".")
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyRow {
    key: u32,
    raw: Box<RawValue>,
    /// A folded channel's variants (itself included), in provider order.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    group: Vec<KeyRow>,
}

/// The raw rows for `keys`, or `None` when any source changed since `token`.
fn rows_for_keys(
    app: &tauri::AppHandle,
    kind: &str,
    sources: &[PageSource],
    token: &str,
    keys: &[u32],
    groups: &HashMap<u32, Vec<u32>>,
) -> Result<Option<Vec<KeyRow>>, String> {
    with_reader(app, |connection| {
        let transaction = connection.unchecked_transaction()?;
        let mut current = Vec::with_capacity(sources.len());
        for source in sources {
            match list_generation(&transaction, &source.source_id, kind)? {
                Some((generation, _)) => current.push(generation.to_string()),
                None => return Ok(None),
            }
        }
        if current.join(".") != token {
            return Ok(None);
        }
        let mut statement = transaction.prepare_cached(
            "SELECT raw FROM items WHERE source_id = ?1 AND kind = ?2 AND ord = ?3",
        )?;
        let mut fetch = |key: u32| -> rusqlite::Result<Option<Box<RawValue>>> {
            let position = (key >> ORD_BITS) as usize;
            let ord = key & ((1 << ORD_BITS) - 1);
            let Some(source) = sources.get(position) else {
                return Ok(None);
            };
            let raw: Option<String> = statement
                .query_row(params![source.source_id, kind, ord], |row| row.get(0))
                .optional()?;
            Ok(raw.and_then(|raw| RawValue::from_string(raw).ok()))
        };
        let mut rows = Vec::with_capacity(keys.len());
        for &key in keys {
            let Some(raw) = fetch(key)? else {
                return Ok(None);
            };
            let mut group = Vec::new();
            for &member in groups.get(&key).map(Vec::as_slice).unwrap_or_default() {
                let Some(raw) = fetch(member)? else {
                    return Ok(None);
                };
                group.push(KeyRow {
                    key: member,
                    raw,
                    group: Vec::new(),
                });
            }
            rows.push(KeyRow { key, raw, group });
        }
        drop(statement);
        transaction.finish()?;
        Ok(Some(rows))
    })
}

/// `[u32 header length][header JSON][padding to 4][u32 keys]`, little endian,
/// so 200k keys reach the webview without a JSON parse.
fn encode_with_keys(header: &impl Serialize, keys: &[u32]) -> Result<Vec<u8>, String> {
    let header =
        serde_json::to_vec(header).map_err(|_| "Could not encode the catalog page".to_string())?;
    let mut out = Vec::with_capacity(8 + header.len() + keys.len() * 4);
    out.extend_from_slice(&(header.len() as u32).to_le_bytes());
    out.extend_from_slice(&header);
    while out.len() % 4 != 0 {
        out.push(b' ');
    }
    for key in keys {
        out.extend_from_slice(&key.to_le_bytes());
    }
    Ok(out)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PageHeader<'a> {
    ready: bool,
    status: Option<PageStatus>,
    generation: &'a str,
    total: usize,
    category_total: u32,
    genre_counts: &'a [u32],
    head: Vec<KeyRow>,
}

/// Whether the pages can be served from the index; loads the facets so the
/// first page query is quick.
#[tauri::command(async)]
pub fn catalog_index_page_status(
    app: tauri::AppHandle,
    kind: String,
    sources: Vec<PageSource>,
) -> Result<PageStatus, String> {
    let start = Instant::now();
    let status = match page_sources(&app, &kind, &sources)? {
        Ok(facets) => PageStatus {
            state: "ready",
            pending: 0,
            total: facets.iter().map(|f| f.rows.len() as u64).sum(),
        },
        Err(status) => status,
    };
    crate::perf::log(
        "rust:index_page_status",
        Some(start.elapsed().as_millis()),
        &format!(
            "kind={kind} state={} pending={}",
            status.state, status.pending
        ),
    );
    Ok(status)
}

/// One page's ordered keys (binary, see `encode_with_keys`) with its genre
/// counts and the raw rows of its first screen.
#[tauri::command(async)]
pub fn catalog_index_page(
    app: tauri::AppHandle,
    kind: String,
    sources: Vec<PageSource>,
    query: CatalogQuery,
) -> Result<tauri::ipc::Response, String> {
    let start = Instant::now();
    let facets = match page_sources(&app, &kind, &sources)? {
        Ok(facets) => facets,
        Err(status) => {
            let header = PageHeader {
                ready: false,
                status: Some(status),
                generation: "",
                total: 0,
                category_total: 0,
                genre_counts: &[],
                head: Vec::new(),
            };
            return Ok(tauri::ipc::Response::new(encode_with_keys(&header, &[])?));
        }
    };
    let refs: Vec<&SourceFacets> = facets.iter().map(|f| f.as_ref()).collect();
    let result = catalog_query::page(&refs, &query);
    let token = generation_token(&facets);
    let head_keys = &result.keys[..result.keys.len().min(PAGE_HEAD_ROWS)];
    let groups = catalog_query::fold_groups(&refs, &query, head_keys);
    let head = rows_for_keys(&app, &kind, &sources, &token, head_keys, &groups)?;
    let ready = head.is_some();
    let header = PageHeader {
        ready,
        status: (!ready).then_some(PageStatus {
            state: "building",
            pending: 0,
            total: 0,
        }),
        generation: &token,
        total: result.keys.len(),
        category_total: result.category_total,
        genre_counts: &result.genre_counts,
        head: head.unwrap_or_default(),
    };
    let keys: &[u32] = if ready { &result.keys } else { &[] };
    let bytes = encode_with_keys(&header, keys)?;
    crate::perf::log(
        "rust:index_page",
        Some(start.elapsed().as_millis()),
        &format!("kind={kind} keys={}", result.keys.len()),
    );
    Ok(tauri::ipc::Response::new(bytes))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PageRows {
    /// True when the index changed since the page's keys were made.
    stale: bool,
    rows: Vec<KeyRow>,
}

/// The raw provider rows behind page keys, for the grid's visible window.
#[tauri::command(async)]
pub fn catalog_index_page_rows(
    app: tauri::AppHandle,
    kind: String,
    sources: Vec<PageSource>,
    generation: String,
    keys: Vec<u32>,
    fold: bool,
) -> Result<PageRows, String> {
    validate_page_kind(&kind)?;
    if keys.len() > MAX_ROWS_PER_REQUEST {
        return Err("Too many catalog rows requested".to_string());
    }
    for source in &sources {
        validate_source_id(&source.source_id)?;
    }
    let stale = PageRows {
        stale: true,
        rows: Vec::new(),
    };
    let groups = if fold {
        let Ok(facets) = page_sources(&app, &kind, &sources)? else {
            return Ok(stale);
        };
        if generation_token(&facets) != generation {
            return Ok(stale);
        }
        let refs: Vec<&SourceFacets> = facets.iter().map(|f| f.as_ref()).collect();
        let query = CatalogQuery {
            fold: true,
            ..CatalogQuery::default()
        };
        catalog_query::fold_groups(&refs, &query, &keys)
    } else {
        HashMap::new()
    };
    Ok(
        match rows_for_keys(&app, &kind, &sources, &generation, &keys, &groups)? {
            Some(rows) => PageRows { stale: false, rows },
            None => PageRows {
                stale: true,
                rows: Vec::new(),
            },
        },
    )
}

/// The provider variants behind one grouped card: the rows sharing the title's
/// IMDb identity, as (source id, raw JSON) pairs, without the row itself.
/// Empty when the title has no IMDb identity.
#[tauri::command(async)]
pub fn catalog_index_variants(
    app: tauri::AppHandle,
    kind: String,
    item_id: String,
) -> Result<Vec<(String, String)>, String> {
    validate_page_kind(&kind)?;
    with_reader(&app, |connection| {
        let identity: Option<String> = connection
            .query_row(
                "SELECT imdb_tconst FROM items WHERE kind = ?1 AND f_id = ?2",
                params![kind, item_id],
                |row| row.get(0),
            )
            .optional()?;
        let Some(identity) = identity else {
            return Ok(Vec::new());
        };
        let mut statement = connection.prepare(
            "SELECT source_id, raw FROM items
             WHERE kind = ?1 AND imdb_tconst = ?2 AND f_id IS NOT NULL AND f_id != ?3
             ORDER BY source_id, ord",
        )?;
        let rows = statement
            .query_map(params![kind, identity, item_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    })
}

/// The category sidebar's counts; `None` until the index can serve the page.
#[tauri::command(async)]
pub fn catalog_index_page_stats(
    app: tauri::AppHandle,
    kind: String,
    sources: Vec<PageSource>,
    query: CatalogQuery,
) -> Result<Option<CatalogStats>, String> {
    let Ok(facets) = page_sources(&app, &kind, &sources)? else {
        return Ok(None);
    };
    let refs: Vec<&SourceFacets> = facets.iter().map(|f| f.as_ref()).collect();
    Ok(Some(catalog_query::stats(&refs, &query)))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RatingHead {
    ready: bool,
    rows: Vec<KeyRow>,
}

/// The titles the TMDB rating checks look at next (see `rating_head`).
#[tauri::command(async)]
pub fn catalog_index_rating_head(
    app: tauri::AppHandle,
    kind: String,
    sources: Vec<PageSource>,
    query: CatalogQuery,
    checked_ids: Vec<String>,
    limit: u32,
) -> Result<RatingHead, String> {
    let not_ready = RatingHead {
        ready: false,
        rows: Vec::new(),
    };
    let Ok(facets) = page_sources(&app, &kind, &sources)? else {
        return Ok(not_ready);
    };
    let refs: Vec<&SourceFacets> = facets.iter().map(|f| f.as_ref()).collect();
    let keys = catalog_query::rating_head(&refs, &query, &checked_ids, limit.min(500) as usize);
    let token = generation_token(&facets);
    Ok(
        match rows_for_keys(&app, &kind, &sources, &token, &keys, &HashMap::new())? {
            Some(rows) => RatingHead { ready: true, rows },
            None => not_ready,
        },
    )
}

#[derive(Serialize)]
struct FacetBatch {
    ready: bool,
    generation: i64,
    rows: Vec<(u32, Box<RawValue>)>,
}

/// Rows still waiting for facets, as JSON bytes for the facet worker.
#[tauri::command(async)]
pub fn catalog_index_facet_batch(
    app: tauri::AppHandle,
    source_id: String,
    kind: String,
    scope: String,
    limit: u32,
) -> Result<tauri::ipc::Response, String> {
    validate_page_kind(&kind)?;
    validate_source_id(&source_id)?;
    let empty = |ready| FacetBatch {
        ready,
        generation: 0,
        rows: Vec::new(),
    };
    let batch = if ensure_indexed(&app, &source_id, &kind, &scope)? {
        with_reader(&app, |connection| {
            let transaction = connection.unchecked_transaction()?;
            let Some((generation, skipped)) = list_generation(&transaction, &source_id, &kind)?
            else {
                return Ok(empty(false));
            };
            if skipped > 0 {
                return Ok(empty(false));
            }
            let mut statement = transaction.prepare(
                "SELECT ord, raw FROM items
                 WHERE source_id = ?1 AND kind = ?2 AND f_rank IS NULL AND f_id IS NULL
                 ORDER BY ord LIMIT ?3",
            )?;
            let rows = statement
                .query_map(
                    params![source_id, kind, limit.min(MAX_FACET_BATCH)],
                    |row| Ok((row.get::<_, i64>(0)? as u32, row.get::<_, String>(1)?)),
                )?
                .filter_map(|row| match row {
                    Ok((ord, raw)) => RawValue::from_string(raw).ok().map(|raw| Ok((ord, raw))),
                    Err(error) => Some(Err(error)),
                })
                .collect::<rusqlite::Result<Vec<_>>>()?;
            drop(statement);
            transaction.finish()?;
            Ok(FacetBatch {
                ready: true,
                generation,
                rows,
            })
        })?
    } else {
        empty(false)
    };
    let bytes =
        serde_json::to_vec(&batch).map_err(|_| "Could not encode the facet batch".to_string())?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// `[ord, id, title, categoryId, added, hasAdded, year, rating, flags, genres,
/// foldKey, foldRank, matchKey]`
type FacetIn = (
    u32,
    String,
    String,
    Option<String>,
    f64,
    u8,
    Option<f64>,
    Option<f64>,
    u8,
    u16,
    Option<String>,
    u8,
    Option<String>,
);

/// Store facets the worker derived; `false` when the list changed meanwhile.
#[tauri::command(async)]
pub fn catalog_index_store_facets(
    app: tauri::AppHandle,
    source_id: String,
    kind: String,
    generation: i64,
    facets: Vec<FacetIn>,
) -> Result<bool, String> {
    validate_page_kind(&kind)?;
    validate_source_id(&source_id)?;
    with_connection(&app, |connection| {
        let transaction = connection.transaction()?;
        if list_generation(&transaction, &source_id, &kind)?.map(|(g, _)| g) != Some(generation) {
            return Ok(false);
        }
        {
            let mut update = transaction.prepare(
                "UPDATE items SET f_id = ?4, f_title = ?5, f_category = ?6, f_added = ?7,
                    f_has_added = ?8, f_year = ?9, f_rating = ?10, f_flags = ?11,
                    f_genres = ?12, f_fold_key = ?13, f_fold_rank = ?14, f_match_key = ?15,
                    f_rank = NULL
                 WHERE source_id = ?1 AND kind = ?2 AND ord = ?3",
            )?;
            for (
                ord,
                id,
                title,
                category,
                added,
                has_added,
                year,
                rating,
                flags,
                genres,
                fold_key,
                fold_rank,
                match_key,
            ) in &facets
            {
                update.execute(params![
                    source_id, kind, ord, id, title, category, added, has_added, year, rating,
                    flags, genres, fold_key, fold_rank, match_key
                ])?;
            }
        }
        transaction.execute(
            "UPDATE lists SET generation = generation + 1 WHERE source_id = ?1 AND kind = ?2",
            params![source_id, kind],
        )?;
        transaction.commit()?;
        Ok(true)
    })
}

/// The lists of one kind, in the order titles are ranked, with a token for
/// their current generations.
fn kind_lists(connection: &Connection, kind: &str) -> rusqlite::Result<(Vec<String>, String)> {
    let mut statement = connection
        .prepare("SELECT source_id, generation FROM lists WHERE kind = ?1 ORDER BY source_id")?;
    let lists = statement
        .query_map(params![kind], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let token = lists
        .iter()
        .map(|(source, generation)| format!("{source}:{generation}"))
        .collect::<Vec<_>>()
        .join("|");
    Ok((lists.into_iter().map(|(source, _)| source).collect(), token))
}

#[derive(Serialize)]
struct TitleBatch {
    needed: bool,
    token: String,
    titles: Vec<String>,
}

/// Every faceted title of one kind, across all indexed sources, when some
/// lack a name rank; as JSON bytes for the facet worker.
#[tauri::command(async)]
pub fn catalog_index_titles(
    app: tauri::AppHandle,
    kind: String,
) -> Result<tauri::ipc::Response, String> {
    validate_page_kind(&kind)?;
    let batch = with_reader(&app, |connection| {
        let transaction = connection.unchecked_transaction()?;
        let (sources, token) = kind_lists(&transaction, &kind)?;
        let needed: bool = transaction.query_row(
            "SELECT EXISTS (SELECT 1 FROM items WHERE kind = ?1 AND f_rank IS NULL
                AND f_id IS NOT NULL)",
            params![kind],
            |row| row.get(0),
        )?;
        let mut titles = Vec::new();
        if needed {
            let mut statement = transaction.prepare(
                "SELECT f_title FROM items
                 WHERE source_id = ?1 AND kind = ?2 AND f_id IS NOT NULL ORDER BY ord",
            )?;
            for source in &sources {
                let mut rows = statement.query(params![source, kind])?;
                while let Some(row) = rows.next()? {
                    titles.push(row.get::<_, String>(0)?);
                }
            }
        }
        transaction.finish()?;
        Ok(TitleBatch {
            needed,
            token,
            titles,
        })
    })?;
    let bytes =
        serde_json::to_vec(&batch).map_err(|_| "Could not encode the title batch".to_string())?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// Store name ranks for every faceted title of one kind, in the order
/// `catalog_index_titles` gave them; `false` when anything changed meanwhile.
#[tauri::command(async)]
pub fn catalog_index_store_ranks(
    app: tauri::AppHandle,
    kind: String,
    token: String,
    ranks: Vec<u32>,
) -> Result<bool, String> {
    validate_page_kind(&kind)?;
    let start = Instant::now();
    let stored = with_connection(&app, |connection| {
        let transaction = connection.transaction()?;
        let (sources, current) = kind_lists(&transaction, &kind)?;
        if current != token {
            return Ok(false);
        }
        let mut row_ids = Vec::with_capacity(ranks.len());
        {
            let mut statement = transaction.prepare(
                "SELECT rowid FROM items
                 WHERE source_id = ?1 AND kind = ?2 AND f_id IS NOT NULL ORDER BY ord",
            )?;
            for source in &sources {
                let ids = statement
                    .query_map(params![source, kind], |row| row.get::<_, i64>(0))?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                row_ids.extend(ids);
            }
        }
        if row_ids.len() != ranks.len() {
            return Ok(false);
        }
        {
            let mut update =
                transaction.prepare("UPDATE items SET f_rank = ?1 WHERE rowid = ?2")?;
            for (row_id, rank) in row_ids.iter().zip(&ranks) {
                update.execute(params![rank, row_id])?;
            }
        }
        transaction.execute(
            "UPDATE lists SET generation = generation + 1 WHERE kind = ?1",
            params![kind],
        )?;
        transaction.commit()?;
        Ok(true)
    })?;
    crate::perf::log(
        "rust:index_store_ranks",
        Some(start.elapsed().as_millis()),
        &format!("kind={kind} ranks={} stored={stored}", ranks.len()),
    );
    Ok(stored)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SearchHeader<'a> {
    ready: bool,
    generation: &'a str,
    total: usize,
    head: Vec<KeyRow>,
}

/// `smartSearch` over one catalogue (hidden categories left out): the keys
/// of every match, best first, then their scores, both as u32 arrays after
/// the header (see `encode_with_keys`), with the rows of the first `head`.
#[tauri::command(async)]
pub fn catalog_index_search(
    app: tauri::AppHandle,
    kind: String,
    sources: Vec<PageSource>,
    query: CatalogQuery,
    text: String,
    head: u32,
) -> Result<tauri::ipc::Response, String> {
    let start = Instant::now();
    let facets = match page_sources(&app, &kind, &sources)? {
        Ok(facets) => facets,
        Err(_) => {
            let header = SearchHeader {
                ready: false,
                generation: "",
                total: 0,
                head: Vec::new(),
            };
            return Ok(tauri::ipc::Response::new(encode_with_keys(&header, &[])?));
        }
    };
    let refs: Vec<&SourceFacets> = facets.iter().map(|f| f.as_ref()).collect();
    let found = catalog_query::search(&refs, &query, &text, &kind);
    let keys: Vec<u32> = found.iter().map(|(key, _)| *key).collect();
    let token = generation_token(&facets);
    let head_keys = &keys[..keys.len().min(head.min(PAGE_HEAD_ROWS as u32) as usize)];
    let groups = catalog_query::fold_groups(&refs, &query, head_keys);
    let rows = rows_for_keys(&app, &kind, &sources, &token, head_keys, &groups)?;
    let ready = rows.is_some();
    let header = SearchHeader {
        ready,
        generation: &token,
        total: if ready { keys.len() } else { 0 },
        head: rows.unwrap_or_default(),
    };
    let mut values = Vec::with_capacity(found.len() * 2);
    if ready {
        values.extend(found.iter().map(|(key, _)| *key));
        values.extend(found.iter().map(|(_, score)| *score));
    }
    let bytes = encode_with_keys(&header, &values)?;
    crate::perf::log(
        "rust:index_search",
        Some(start.elapsed().as_millis()),
        &format!("kind={kind} found={}", found.len()),
    );
    Ok(tauri::ipc::Response::new(bytes))
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

    fn test_database(name: &str) -> (PathBuf, Connection) {
        let path = std::env::temp_dir().join(format!(
            "movena-catalog-index-{name}-{}.sqlite",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&path);
        let connection = open(&path).unwrap();
        (path, connection)
    }

    fn ingest_json(connection: &mut Connection, source: &str, json: &str) -> usize {
        let list: Vec<&RawValue> = serde_json::from_str(json).unwrap();
        ingest_into(connection, source, "vod", "scope-1", 1, &list, "added").unwrap()
    }

    fn give_facets(connection: &Connection, source: &str) {
        connection
            .execute(
                "UPDATE items SET f_id = 'id-' || ord, f_title = 't' || ord, f_added = 0,
                    f_has_added = 0, f_flags = 0, f_genres = 0, f_rank = ord
                 WHERE source_id = ?1",
                params![source],
            )
            .unwrap();
    }

    #[test]
    fn ingest_keeps_facets_of_unchanged_rows_and_counts_skipped_ones() {
        let (path, mut connection) = test_database("carry");
        let source = "xtream-carry";
        let first = r#"[{"stream_id":1,"name":"A"},{"stream_id":2,"name":"B"}]"#;
        assert_eq!(ingest_json(&mut connection, source, first), 2);
        give_facets(&connection, source);
        assert!(matches!(
            read_source_facets(&connection, source, "vod").unwrap(),
            SourceState::Ready(facets) if facets.rows.len() == 2
        ));

        // "B" moved and changed; "A" moved but is the same JSON; one row has no id.
        let second = r#"[{"name":"no id"},{"stream_id":2,"name":"B2"},{"stream_id":1,"name":"A"}]"#;
        assert_eq!(ingest_json(&mut connection, source, second), 2);
        let (generation, skipped) = list_generation(&connection, source, "vod")
            .unwrap()
            .unwrap();
        assert_eq!((generation, skipped), (2, 1));
        let carried: Vec<(i64, Option<String>, Option<i64>)> = connection
            .prepare("SELECT ord, f_id, f_rank FROM items WHERE source_id = ?1 ORDER BY ord")
            .unwrap()
            .query_map(params![source], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            })
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        assert_eq!(
            carried,
            vec![(1, None, None), (2, Some("id-0".to_string()), Some(0))]
        );
        // A list with rows the index cannot hold is left to the full catalogue.
        assert!(matches!(
            read_source_facets(&connection, source, "vod").unwrap(),
            SourceState::Unavailable
        ));
        drop(connection);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn a_list_waiting_for_facets_is_building() {
        let (path, mut connection) = test_database("building");
        let source = "xtream-building";
        ingest_json(
            &mut connection,
            source,
            r#"[{"stream_id":1},{"stream_id":2}]"#,
        );
        assert!(matches!(
            read_source_facets(&connection, source, "vod").unwrap(),
            SourceState::Building {
                pending: 2,
                total: 2
            }
        ));
        give_facets(&connection, source);
        match read_source_facets(&connection, source, "vod").unwrap() {
            SourceState::Ready(facets) => {
                assert_eq!(facets.rows[1].id.as_ref(), "id-1");
                assert_eq!(facets.rows[1].rank, 1);
            }
            _ => panic!("facets should be ready"),
        }
        assert!(matches!(
            read_source_facets(&connection, "xtream-missing", "vod").unwrap(),
            SourceState::Unavailable
        ));
        drop(connection);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn encodes_keys_after_a_padded_header() {
        let bytes = encode_with_keys(&serde_json::json!({ "a": 1 }), &[7, 1 << 23]).unwrap();
        let header_length = u32::from_le_bytes(bytes[0..4].try_into().unwrap()) as usize;
        assert_eq!(&bytes[4..4 + header_length], br#"{"a":1}"#);
        let offset = (4 + header_length).div_ceil(4) * 4;
        assert_eq!(bytes.len(), offset + 8);
        assert_eq!(
            u32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap()),
            7
        );
        assert_eq!(
            u32::from_le_bytes(bytes[offset + 4..offset + 8].try_into().unwrap()),
            1 << 23
        );
        assert_eq!(
            encode_with_keys(&serde_json::json!({}), &[]).unwrap().len(),
            8
        );
    }

    #[test]
    fn page_kinds_are_the_three_catalogues() {
        assert!(validate_page_kind("vod").is_ok());
        assert!(validate_page_kind("series").is_ok());
        assert!(validate_page_kind("live").is_ok());
        assert!(validate_page_kind("movies").is_err());
        assert!(validate_page_kind("").is_err());
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
