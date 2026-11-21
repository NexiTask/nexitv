//! IMDb bulk-dataset ratings for the catalogue index.
//!
//! IMDb's daily dumps (`title.basics.tsv.gz`, `title.ratings.tsv.gz`,
//! datasets.imdbws.com) are the only practical way to rate a catalogue of
//! several hundred thousand provider titles: provider ratings are imported
//! once by panels and never refreshed, and per-title lookups cannot cover the
//! catalogue. The dumps are free for personal, non-commercial use.
//!
//! The pipeline keeps its own database (`imdb.sqlite`, beside the catalog
//! index) so a catalog schema change never costs a re-download:
//!
//! 1. Download both dumps into a cache dir; the previous pair stays until the
//!    new one has parsed.
//! 2. Stream-parse `basics`, keeping only movie/series-kind titles whose
//!    normalized title key matches a catalogue key (step 0 measured the
//!    pre-filter at ~154k rows, ~17 MB) or whose IMDb id a provider attached
//!    (some panels put a `tt…` id in their `tmdb` field).
//! 3. Backfill: join catalogue rows to candidates on the facet worker's match
//!    key and year, and store `imdb_tconst`, `imdb_rating`, `imdb_votes`,
//!    `imdb_adult`, `imdb_runtime`, `imdb_genres` on the index's items.
//!
//! Matching is exact key + year only (step 0 measured the similarity tier at
//! 0.2%): kind must match, exact year beats ±1, more votes wins, and
//! candidates tied within 2× votes across different years stay unmatched —
//! the same policy as the TMDB match. The refresh runs in the background on a
//! schedule (weekly dumps, daily backfill for newly ingested lists) and from
//! Settings, never on the startup path.

use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use flate2::read::MultiGzDecoder;
use icu_normalizer::DecomposingNormalizerBorrowed;
use rusqlite::params;
use serde::Serialize;
use tauri::{Emitter, Manager};

use crate::sources::catalog_index;

const BASICS_URL: &str = "https://datasets.imdbws.com/title.basics.tsv.gz";
const RATINGS_URL: &str = "https://datasets.imdbws.com/title.ratings.tsv.gz";
/// The dumps refresh daily; a week old is fresh enough for a catalogue.
const REFRESH_AFTER: Duration = Duration::from_secs(7 * 24 * 3600);
/// Newly ingested lists wait at most a day for their first match.
const BACKFILL_AFTER: Duration = Duration::from_secs(24 * 3600);
const SCHEDULE_TICK: Duration = Duration::from_secs(6 * 3600);
/// The first pass waits out the startup budget (the NTV-1 lesson).
const STARTUP_DELAY: Duration = Duration::from_secs(120);
/// Rows per backfill transaction: bounded commits keep readers unblocked.
const BACKFILL_BATCH: i64 = 5_000;

static RUNNING: AtomicBool = AtomicBool::new(false);

fn database_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|_| "Application data is unavailable".to_string())?;
    std::fs::create_dir_all(&directory)
        .map_err(|_| "Could not create the IMDb database".to_string())?;
    Ok(directory.join("imdb.sqlite"))
}

fn cache_directory(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|_| "Application data is unavailable".to_string())?;
    let cache = directory.join("imdb-dumps");
    std::fs::create_dir_all(&cache)
        .map_err(|_| "Could not create the IMDb dump cache".to_string())?;
    Ok(cache)
}

fn with_connection<T>(
    app: &tauri::AppHandle,
    f: impl FnOnce(&mut rusqlite::Connection) -> Result<T, String>,
) -> Result<T, String> {
    static CONNECTION: Mutex<Option<rusqlite::Connection>> = Mutex::new(None);
    let mut guard = CONNECTION.lock().unwrap_or_else(|error| error.into_inner());
    if guard.is_none() {
        let connection = open_database(&database_path(app)?)?;
        *guard = Some(connection);
    }
    let connection = guard.as_mut().expect("connection was just opened");
    f(connection)
}

/// One connection per process; the schema it creates is the pipeline's whole
/// storage contract, so a test can open the same database from its path.
fn open_database(path: &std::path::Path) -> Result<rusqlite::Connection, String> {
    let connection = rusqlite::Connection::open(path)
        .map_err(|error| format!("IMDb database unavailable: {error}"))?;
    connection
        .pragma_update(None, "journal_mode", "WAL")
        .map_err(|error| format!("IMDb database unavailable: {error}"))?;
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS titles (
                tconst  TEXT PRIMARY KEY,
                kind    TEXT NOT NULL,
                key1    TEXT NOT NULL,
                key2    TEXT,
                year    INTEGER,
                adult   INTEGER NOT NULL DEFAULT 0,
                runtime INTEGER,
                genres  TEXT,
                rating  REAL,
                votes   INTEGER NOT NULL DEFAULT 0
            );
            CREATE INDEX IF NOT EXISTS titles_key1 ON titles (key1, year);
            CREATE INDEX IF NOT EXISTS titles_key2 ON titles (key2, year)
                WHERE key2 IS NOT NULL;
            CREATE TABLE IF NOT EXISTS titles_staging (
                tconst  TEXT PRIMARY KEY,
                kind    TEXT NOT NULL,
                key1    TEXT NOT NULL,
                key2    TEXT,
                year    INTEGER,
                adult   INTEGER NOT NULL DEFAULT 0,
                runtime INTEGER,
                genres  TEXT,
                rating  REAL,
                votes   INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS meta (
                name  TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );",
        )
        .map_err(|error| format!("IMDb database error: {error}"))?;
    Ok(connection)
}

fn database_error(error: rusqlite::Error) -> String {
    format!("IMDb database error: {error}")
}

fn meta_get(connection: &rusqlite::Connection, name: &str) -> Option<u64> {
    connection
        .query_row(
            "SELECT value FROM meta WHERE name = ?1",
            params![name],
            |row| row.get::<_, String>(0),
        )
        .ok()?
        .parse()
        .ok()
}

fn meta_set(connection: &rusqlite::Connection, name: &str, value: u64) {
    connection
        .execute(
            "INSERT INTO meta (name, value) VALUES (?1, ?2)
             ON CONFLICT (name) DO UPDATE SET value = ?2",
            params![name, value.to_string()],
        )
        .ok();
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

fn age_secs(connection: &rusqlite::Connection, name: &str) -> Option<u64> {
    meta_get(connection, name).map(|at| now_secs().saturating_sub(at))
}

/// The normalized title key, mirroring the frontend's `tmdbTitleKey`
/// (tmdbMatch.ts): case, accents and punctuation do not decide a match.
/// NFKD, like the frontend and like catalog_search's normalizer.
/// Step 0 checked the mirror against the production functions: 0/2000 drift.
pub(crate) fn title_key(value: &str) -> String {
    static NFKD: std::sync::OnceLock<DecomposingNormalizerBorrowed<'static>> =
        std::sync::OnceLock::new();
    let nfkd = NFKD.get_or_init(DecomposingNormalizerBorrowed::new_nfkd);
    nfkd.normalize(value)
        .chars()
        .filter(|character| !('\u{300}'..='\u{36f}').contains(character))
        .flat_map(|character| character.to_lowercase())
        .collect::<String>()
        .replace('&', "and")
        .chars()
        .filter(|character| character.is_alphanumeric())
        .collect()
}

/// Movie/series kinds the catalogue cares about; `short`/`tvShort` are left
/// out so a same-name short never steals a feature film's match, and
/// episodes/games are not titles the catalogue lists.
fn basics_kind(title_type: &str) -> Option<&'static str> {
    match title_type {
        "movie" | "tvMovie" | "tvSpecial" | "video" => Some("movie"),
        "tvSeries" | "tvMiniSeries" => Some("series"),
        _ => None,
    }
}

/// A provider `tmdb` field that actually holds an IMDb id ("tt0056937" shows
/// up in real lists) matches by id directly.
pub(crate) fn imdb_id_of(item: &serde_json::Value) -> Option<String> {
    let raw = item.get("tmdb")?.as_str()?.trim();
    let valid = raw.len() >= 7
        && raw.len() <= 10
        && raw.starts_with("tt")
        && raw[2..].bytes().all(|byte| byte.is_ascii_digit());
    valid.then(|| raw.to_string())
}

#[derive(Clone)]
struct Candidate {
    tconst: String,
    kind: &'static str,
    year: Option<i64>,
    adult: bool,
    runtime: Option<i64>,
    genres: Option<String>,
    rating: Option<f64>,
    votes: i64,
}

/// A parsed basics row with the keys it can be found by.
struct StagingRow {
    key1: String,
    key2: Option<String>,
    candidate: Candidate,
}

/// The resolution policy: kind must match, exact year beats ±1, more votes
/// wins, near-ties across different years are ambiguous.
fn pick_candidate<'a>(
    candidates: &'a [Candidate],
    kind: &str,
    query_year: Option<i64>,
) -> (Option<&'a Candidate>, &'static str) {
    let same_kind: Vec<&Candidate> = candidates.iter().filter(|c| c.kind == kind).collect();
    if same_kind.is_empty() {
        return (
            None,
            if candidates.is_empty() {
                "key-absent"
            } else {
                "no-kind"
            },
        );
    }
    let mut pool: Vec<&Candidate> = match query_year {
        Some(year) => {
            let exact: Vec<&Candidate> = same_kind
                .iter()
                .filter(|c| c.year == Some(year))
                .copied()
                .collect();
            if exact.is_empty() {
                same_kind
                    .into_iter()
                    .filter(|c| matches!(c.year, Some(candidate) if (candidate - year).abs() == 1))
                    .collect()
            } else {
                exact
            }
        }
        None => same_kind,
    };
    if pool.is_empty() {
        return (None, "year-miss");
    }
    pool.sort_by(|a, b| b.votes.cmp(&a.votes));
    let top = pool[0];
    if let Some(second) = pool.get(1) {
        if second.year != top.year && second.votes * 2 > top.votes {
            return (None, "ambiguous");
        }
    }
    (Some(top), "matched")
}

/// One full refresh: download, parse into the staging table, swap, backfill.
async fn run_refresh(app: tauri::AppHandle, manual: bool) -> Result<usize, String> {
    if RUNNING.swap(true, Ordering::SeqCst) {
        return Err("An IMDb refresh is already running".to_string());
    }
    let outcome = refresh_locked(app, manual).await;
    RUNNING.store(false, Ordering::SeqCst);
    outcome
}

async fn refresh_locked(app: tauri::AppHandle, manual: bool) -> Result<usize, String> {
    let start = Instant::now();
    emit(&app, "checking", None);
    if !manual {
        let fresh = with_connection(&app, |connection| Ok(age_secs(connection, "last_refresh")))?
            .map(|age| age < REFRESH_AFTER.as_secs())
            .unwrap_or(false);
        if fresh {
            return Ok(0);
        }
    }
    let (keys, tt_ids) = catalog_index::match_universe(&app)?;
    if keys.is_empty() && tt_ids.is_empty() {
        return Err("The catalogue index has no match keys yet".to_string());
    }

    let cache = cache_directory(&app)?;
    download_dump(&app, RATINGS_URL, &cache.join("title.ratings.tsv.gz.new")).await?;
    download_dump(&app, BASICS_URL, &cache.join("title.basics.tsv.gz.new")).await?;
    emit(&app, "parsing", None);
    let parse_cache = cache.clone();
    let parse_database = database_path(&app)?;
    let titles = tauri::async_runtime::spawn_blocking(move || {
        parse_and_swap(&parse_database, &parse_cache, &keys, &tt_ids)
    })
    .await
    .map_err(|error| format!("IMDb parse failed: {error}"))??;

    let matched = backfill(&app)?;
    with_connection(&app, |connection| {
        meta_set(connection, "last_refresh", now_secs());
        meta_set(connection, "titles", titles as u64);
        Ok(())
    })?;
    // The parsed dumps are the new cache; only now does the previous pair go.
    let _ = std::fs::rename(
        cache.join("title.basics.tsv.gz.new"),
        cache.join("title.basics.tsv.gz"),
    );
    let _ = std::fs::rename(
        cache.join("title.ratings.tsv.gz.new"),
        cache.join("title.ratings.tsv.gz"),
    );
    crate::perf::log(
        "imdb:refresh",
        Some(start.elapsed().as_millis()),
        &format!("titles={titles} matched={matched}"),
    );
    emit(&app, "done", Some(titles as u64));
    Ok(matched)
}

async fn download_dump(
    app: &tauri::AppHandle,
    url: &str,
    dest: &std::path::Path,
) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(1800))
        .build()
        .map_err(|error| format!("IMDb download failed: {error}"))?;
    let mut response = client
        .get(url)
        .send()
        .await
        .and_then(|response| response.error_for_status())
        .map_err(|error| format!("IMDb download failed: {error}"))?;
    let mut file = std::fs::File::create(dest)
        .map_err(|error| format!("Could not write the IMDb dump: {error}"))?;
    let mut received = 0u64;
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| format!("IMDb download failed: {error}"))?
    {
        std::io::Write::write_all(&mut file, &chunk)
            .map_err(|error| format!("Could not write the IMDb dump: {error}"))?;
        received += chunk.len() as u64;
        emit(app, "downloading", Some(received));
    }
    Ok(())
}

/// IMDb's TSV escaping: a literal `\N` is a null field; nothing is quoted.
fn tsv_fields(line: &str) -> impl Iterator<Item = &str> {
    line.split('\t').map(|field| match field {
        "\\N" => "",
        other => other,
    })
}

fn parse_i64(field: &str) -> Option<i64> {
    field.parse().ok()
}

/// Stream both dumps into the staging table and swap it in. Runs on a
/// blocking thread; the previous table stays readable until the swap commits.
fn parse_and_swap(
    database: &std::path::Path,
    cache: &std::path::Path,
    keys: &HashSet<String>,
    tt_ids: &HashSet<String>,
) -> Result<usize, String> {
    let start = Instant::now();
    let mut ratings: HashMap<String, (f64, i64)> = HashMap::new();
    let ratings_file = std::fs::File::open(cache.join("title.ratings.tsv.gz.new"))
        .map_err(|error| format!("Could not read the IMDb ratings dump: {error}"))?;
    for line in BufReader::new(MultiGzDecoder::new(ratings_file)).lines() {
        let line = line.map_err(|error| format!("IMDb ratings dump is unreadable: {error}"))?;
        let mut fields = tsv_fields(&line);
        let tconst = fields.next().unwrap_or_default();
        let average = fields.next().and_then(|field| field.parse().ok());
        let votes = fields.next().and_then(|field| field.parse().ok());
        if let (true, Some(average), Some(votes)) = (!tconst.is_empty(), average, votes) {
            ratings.insert(tconst.to_string(), (average, votes));
        }
    }

    let basics_file = std::fs::File::open(cache.join("title.basics.tsv.gz.new"))
        .map_err(|error| format!("Could not read the IMDb basics dump: {error}"))?;
    let mut staging: Vec<StagingRow> = Vec::new();
    for line in BufReader::new(MultiGzDecoder::new(basics_file)).lines() {
        let line = line.map_err(|error| format!("IMDb basics dump is unreadable: {error}"))?;
        let mut fields = tsv_fields(&line);
        let tconst = fields.next().unwrap_or_default();
        let kind = fields.next().and_then(basics_kind);
        let primary = fields.next().unwrap_or_default();
        let original = fields.next().unwrap_or_default();
        let (Some(kind), true) = (kind, !tconst.is_empty()) else {
            continue;
        };
        let adult = fields.next().map(|field| field == "1").unwrap_or(false);
        let year = fields.next().and_then(parse_i64);
        let _end_year = fields.next();
        let runtime = fields
            .next()
            .and_then(parse_i64)
            .filter(|minutes| *minutes < 10_000);
        let genres = fields
            .next()
            .map(str::to_string)
            .filter(|genres| !genres.is_empty());
        let key1 = title_key(primary);
        let key2 = title_key(original);
        let (rating, votes) = ratings.get(tconst).copied().unwrap_or((0.0, 0));
        let has_votes = votes > 0;
        let wanted_key = keys.contains(&key1) || (!key2.is_empty() && keys.contains(&key2));
        if !wanted_key && !tt_ids.contains(tconst) {
            continue;
        }
        staging.push(StagingRow {
            key1: key1.clone(),
            key2: (!key2.is_empty() && key2 != key1).then_some(key2),
            candidate: Candidate {
                tconst: tconst.to_string(),
                kind,
                year,
                adult,
                runtime,
                genres,
                rating: has_votes.then_some(rating),
                votes,
            },
        });
    }

    let count = staging.len();
    let mut connection = open_database(database)?;
    {
        let transaction = connection.transaction().map_err(database_error)?;
        transaction
            .execute("DELETE FROM titles_staging", [])
            .map_err(database_error)?;
        {
            let mut insert = transaction
                .prepare(
                    "INSERT INTO titles_staging
                        (tconst, kind, key1, key2, year, adult, runtime, genres, rating, votes)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                )
                .map_err(database_error)?;
            for row in &staging {
                insert
                    .execute(params![
                        row.candidate.tconst,
                        row.candidate.kind,
                        row.key1,
                        row.key2,
                        row.candidate.year,
                        row.candidate.adult as i64,
                        row.candidate.runtime,
                        row.candidate.genres,
                        row.candidate.rating,
                        row.candidate.votes,
                    ])
                    .map_err(database_error)?;
            }
        }
        transaction
            .execute("DROP TABLE titles", [])
            .map_err(database_error)?;
        transaction
            .execute("ALTER TABLE titles_staging RENAME TO titles", [])
            .map_err(database_error)?;
        transaction
            .execute_batch(
                "CREATE INDEX titles_key1 ON titles (key1, year);
                 CREATE INDEX titles_key2 ON titles (key2, year) WHERE key2 IS NOT NULL;
                 CREATE TABLE titles_staging (
                     tconst  TEXT PRIMARY KEY,
                     kind    TEXT NOT NULL,
                     key1    TEXT NOT NULL,
                     key2    TEXT,
                     year    INTEGER,
                     adult   INTEGER NOT NULL DEFAULT 0,
                     runtime INTEGER,
                     genres  TEXT,
                     rating  REAL,
                     votes   INTEGER NOT NULL DEFAULT 0
                 );",
            )
            .map_err(database_error)?;
        transaction.commit().map_err(database_error)?;
    }
    crate::perf::log(
        "imdb:parse",
        Some(start.elapsed().as_millis()),
        &format!("titles={count}"),
    );
    Ok(count)
}

/// One matched index row: the values to store, and the row to store them on.
type MatchUpdate = (
    String,
    i64,
    i64,
    Option<i64>,
    Option<String>,
    Option<f64>,
    i64,
);

/// Fill the `imdb_*` columns for index rows without a match. Exact key + year
/// only; candidates were pre-filtered to the catalogue's keys at parse time.
fn backfill(app: &tauri::AppHandle) -> Result<usize, String> {
    let start = Instant::now();
    let mut matched = 0usize;
    let mut cursor: i64 = 0;
    loop {
        let batch: Vec<(i64, &'static str, String, Option<i64>)> =
            catalog_index::with_reader(app, |connection| {
                let mapped = connection
                    .prepare(
                        "SELECT rowid, kind, f_match_key, CAST(f_year AS INTEGER) FROM items
                         WHERE rowid > ?1 AND kind IN ('vod', 'series')
                           AND imdb_tconst IS NULL AND f_match_key IS NOT NULL
                         ORDER BY rowid LIMIT ?2",
                    )?
                    .query_map(params![cursor, BACKFILL_BATCH], |row| {
                        let kind: String = row.get(1)?;
                        Ok((
                            row.get(0)?,
                            if kind == "series" { "series" } else { "movie" },
                            row.get(2)?,
                            row.get(3)?,
                        ))
                    })?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                Ok(mapped)
            })?;
        if batch.is_empty() {
            break;
        }
        cursor = batch.last().expect("batch is not empty").0;

        // One indexed lookup per distinct key per batch.
        let mut keys: Vec<String> = batch.iter().map(|(_, _, key, _)| key.clone()).collect();
        keys.sort_unstable();
        keys.dedup();
        let mut candidates_by_key: HashMap<String, Vec<Candidate>> = HashMap::new();
        with_connection(app, |connection| {
            for key in &keys {
                let found = connection
                    .prepare(
                        "SELECT tconst, kind, year, adult, runtime, genres, rating, votes
                         FROM titles WHERE key1 = ?1 OR key2 = ?1",
                    )
                    .and_then(|mut statement| {
                        statement
                            .query_map(params![key], |row| {
                                let kind: String = row.get(1)?;
                                Ok(Candidate {
                                    tconst: row.get(0)?,
                                    kind: if kind == "series" { "series" } else { "movie" },
                                    year: row.get(2)?,
                                    adult: row.get::<_, i64>(3)? != 0,
                                    runtime: row.get(4)?,
                                    genres: row.get(5)?,
                                    rating: row.get(6)?,
                                    votes: row.get(7)?,
                                })
                            })?
                            .collect::<rusqlite::Result<Vec<_>>>()
                    })
                    .map_err(database_error)?;
                candidates_by_key.insert(key.clone(), found);
            }
            Ok(())
        })?;

        let updates: Vec<MatchUpdate> = batch
            .iter()
            .filter_map(|(rowid, kind, key, year)| {
                let found = candidates_by_key.get(key)?;
                let (candidate, _) = pick_candidate(found, kind, *year);
                candidate.map(|candidate| {
                    (
                        candidate.tconst.clone(),
                        *rowid,
                        candidate.adult as i64,
                        candidate.runtime,
                        candidate.genres.clone(),
                        candidate.rating,
                        candidate.votes,
                    )
                })
            })
            .collect();
        matched += updates.len();
        catalog_index::with_connection(app, |connection| {
            let transaction = connection.transaction()?;
            {
                let mut update = transaction.prepare(
                    "UPDATE items SET imdb_tconst = ?1, imdb_adult = ?2, imdb_runtime = ?3,
                        imdb_genres = ?4, imdb_rating = ?5, imdb_votes = ?6
                     WHERE rowid = ?7",
                )?;
                for (tconst, rowid, adult, runtime, genres, rating, votes) in &updates {
                    update.execute(params![
                        tconst, adult, runtime, genres, rating, votes, rowid,
                    ])?;
                }
            }
            transaction.commit()?;
            Ok(())
        })?;
    }
    with_connection(app, |connection| {
        meta_set(connection, "last_backfill", now_secs());
        Ok(())
    })?;
    catalog_index::invalidate_imdb_facets();
    // Index-backed pages reload with the new matches (a full refresh emits
    // its own 'done' after this one; an extra invalidation is harmless).
    emit(app, "done", None);
    crate::perf::log(
        "imdb:backfill",
        Some(start.elapsed().as_millis()),
        &format!("matched={matched}"),
    );
    Ok(matched)
}

fn emit(app: &tauri::AppHandle, stage: &str, progress: Option<u64>) {
    let _ = app.emit(
        "imdb://refresh",
        serde_json::json!({ "stage": stage, "progress": progress }),
    );
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RefreshStatus {
    pub running: bool,
    pub enabled: bool,
    pub last_refresh: Option<u64>,
    pub titles: Option<u64>,
    pub matched: u64,
    pub total: u64,
}

fn status(app: &tauri::AppHandle) -> Result<RefreshStatus, String> {
    let (last_refresh, titles, enabled) = with_connection(app, |connection| {
        Ok((
            meta_get(connection, "last_refresh"),
            meta_get(connection, "titles"),
            meta_get(connection, "enabled").map(|value| value != 0).unwrap_or(true),
        ))
    })?;
    let (matched, total) = catalog_index::with_reader(app, |connection| {
        Ok((
            connection.query_row(
                "SELECT COUNT(*) FROM items
                 WHERE kind IN ('vod', 'series') AND imdb_tconst IS NOT NULL",
                [],
                |row| row.get::<_, i64>(0),
            )?,
            connection.query_row(
                "SELECT COUNT(*) FROM items WHERE kind IN ('vod', 'series')",
                [],
                |row| row.get::<_, i64>(0),
            )?,
        ))
    })?;
    let (matched, total) = (matched as u64, total as u64);
    Ok(RefreshStatus {
        running: RUNNING.load(Ordering::SeqCst),
        enabled,
        last_refresh,
        titles,
        matched,
        total,
    })
}

#[tauri::command(async)]
pub fn imdb_refresh_status(app: tauri::AppHandle) -> Result<RefreshStatus, String> {
    status(&app)
}

/// Settings' automatic-refresh toggle; a manual update always runs.
#[tauri::command(async)]
pub fn imdb_refresh_set_enabled(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    with_connection(&app, |connection| {
        meta_set(connection, "enabled", u64::from(enabled));
        Ok(())
    })
}

/// Settings' manual update; runs regardless of the weekly gate.
#[tauri::command(async)]
pub async fn imdb_refresh_start(app: tauri::AppHandle) -> Result<RefreshStatus, String> {
    run_refresh(app.clone(), true).await?;
    status(&app)
}

/// The recurring process: shortly after startup and then on a slow tick,
/// refresh stale dumps and match lists that arrived since the last pass.
/// The Settings toggle turns the automatic half off; a manual update always
/// runs.
pub(crate) fn schedule(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        std::thread::sleep(STARTUP_DELAY);
        loop {
            let automatic = with_connection(&app, |connection| {
                Ok(meta_get(connection, "enabled").map(|value| value != 0).unwrap_or(true))
            })
            .unwrap_or(true);
            let outcome = if !automatic {
                Ok(0)
            } else {
                let due = with_connection(&app, |connection| {
                    let refresh = age_secs(connection, "last_refresh")
                        .map(|age| age >= REFRESH_AFTER.as_secs())
                        .unwrap_or(true);
                    let backfill = age_secs(connection, "last_backfill")
                        .map(|age| age >= BACKFILL_AFTER.as_secs())
                        .unwrap_or(true);
                    Ok((refresh, backfill))
                })
                .unwrap_or((false, false));
                if due.0 {
                    tauri::async_runtime::block_on(run_refresh(app.clone(), false))
                } else if due.1 {
                    backfill(&app)
                } else {
                    Ok(0)
                }
            };
            if let Err(error) = outcome {
                // A failed download keeps the old data and retries next tick.
                crate::perf::log("imdb:refresh_error", None, &error);
            }
            std::thread::sleep(SCHEDULE_TICK);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn title_key_mirrors_the_frontend() {
        assert_eq!(title_key("The Handmaid's Tale"), "thehandmaidstale");
        assert_eq!(title_key("Qui sommes-nous ?"), "quisommesnous");
        assert_eq!(title_key("Fish & Chips"), "fishandchips");
        assert_eq!(title_key("  Götz  Otto "), "gotzotto");
        assert_eq!(title_key("Ким и Джим"), "кимиджим");
    }

    #[test]
    fn basics_kind_maps_the_catalogue_kinds() {
        assert_eq!(basics_kind("movie"), Some("movie"));
        assert_eq!(basics_kind("tvMovie"), Some("movie"));
        assert_eq!(basics_kind("tvSpecial"), Some("movie"));
        assert_eq!(basics_kind("video"), Some("movie"));
        assert_eq!(basics_kind("tvSeries"), Some("series"));
        assert_eq!(basics_kind("tvMiniSeries"), Some("series"));
        assert_eq!(basics_kind("short"), None);
        assert_eq!(basics_kind("tvEpisode"), None);
        assert_eq!(basics_kind("videoGame"), None);
    }

    #[test]
    fn imdb_id_of_accepts_only_imdb_shapes() {
        assert_eq!(
            imdb_id_of(&serde_json::json!({ "tmdb": "tt0056937" })),
            Some("tt0056937".to_string())
        );
        assert_eq!(imdb_id_of(&serde_json::json!({ "tmdb": "55787" })), None);
        assert_eq!(imdb_id_of(&serde_json::json!({ "tmdb": "ttx5" })), None);
        assert_eq!(imdb_id_of(&serde_json::json!({ "tmdb": 42 })), None);
        assert_eq!(imdb_id_of(&serde_json::json!({})), None);
    }

    fn candidate(kind: &str, year: Option<i64>, votes: i64) -> Candidate {
        Candidate {
            tconst: format!("tt{kind}-{year:?}-{votes}"),
            kind: if kind == "series" { "series" } else { "movie" },
            year,
            adult: false,
            runtime: None,
            genres: None,
            rating: Some(7.0),
            votes,
        }
    }

    #[test]
    fn pick_candidate_prefers_exact_year_then_votes() {
        let near = candidate("movie", Some(2009), 5_000);
        let exact = candidate("movie", Some(2010), 100);
        let pool = vec![near, exact];
        let (picked, tier) = pick_candidate(&pool, "movie", Some(2010));
        assert_eq!(tier, "matched");
        assert_eq!(
            picked.expect("exact year wins").tconst,
            "ttmovie-Some(2010)-100"
        );
    }

    #[test]
    fn pick_candidate_never_guesses_between_years() {
        let a = candidate("movie", Some(2005), 1_000);
        let b = candidate("movie", Some(2007), 800);
        let pool = vec![a, b];
        let (picked, tier) = pick_candidate(&pool, "movie", Some(2006));
        assert_eq!(tier, "ambiguous");
        assert!(picked.is_none());
    }

    #[test]
    fn pick_candidate_takes_the_most_voted_same_year_match() {
        let a = candidate("movie", Some(2005), 1_000);
        let b = candidate("movie", Some(2005), 3_000);
        let pool = vec![a, b];
        let (picked, tier) = pick_candidate(&pool, "movie", Some(2005));
        assert_eq!(tier, "matched");
        assert_eq!(picked.expect("votes win").tconst, "ttmovie-Some(2005)-3000");
    }

    #[test]
    fn pick_candidate_refuses_the_wrong_kind() {
        let series = candidate("series", Some(2010), 10_000);
        let pool = vec![series];
        let (picked, tier) = pick_candidate(&pool, "movie", Some(2010));
        assert_eq!(tier, "no-kind");
        assert!(picked.is_none());
    }

    #[test]
    fn pick_candidate_reports_an_absent_key() {
        let (picked, tier) = pick_candidate(&[], "movie", Some(2010));
        assert_eq!(tier, "key-absent");
        assert!(picked.is_none());
    }

    #[test]
    fn tsv_fields_unescape_nulls() {
        let fields: Vec<&str> = tsv_fields("tt123\t\\N\t7.5\t42").collect();
        assert_eq!(fields, vec!["tt123", "", "7.5", "42"]);
    }

    /// Writes a gzipped TSV like the IMDb dumps do (no quoting, `\N` nulls).
    fn write_dump(path: &std::path::Path, header: &str, rows: &[String]) {
        use flate2::write::GzEncoder;
        use std::io::Write as _;
        let file = std::fs::File::create(path).expect("dump file");
        let mut encoder = GzEncoder::new(file, flate2::Compression::fast());
        encoder
            .write_all(header.as_bytes())
            .and_then(|_| {
                for row in rows {
                    encoder.write_all(row.as_bytes())?;
                    encoder.write_all(b"\n")?;
                }
                Ok(())
            })
            .and_then(|_| encoder.finish())
            .expect("write dump");
    }

    #[test]
    fn parse_and_swap_keeps_only_catalogue_kinds_and_keys() {
        let directory = tempfile::tempdir().expect("temp dir");
        let cache = directory.path().to_path_buf();
        let database = directory.path().join("imdb.sqlite");

        write_dump(
            &cache.join("title.ratings.tsv.gz.new"),
            "tconst\trating\tnumVotes\n",
            &[
                "tt0000001\t8.1\t1200".to_string(),
                "tt0000002\t5.0\t10".to_string(),
            ],
        );
        write_dump(
            &cache.join("title.basics.tsv.gz.new"),
            "tconst\ttitleType\tprimaryTitle\toriginalTitle\tisAdult\tstartYear\tendYear\truntimeMinutes\tgenres\n",
            &[
                "tt0000001\tmovie\tGötz Otto\tGötz Otto\t0\t2010\t\\N\t96\tAction".to_string(),
                "tt0000002\ttvSeries\tUnrated Show\tUnrated Show\t0\t2001\t2011\t\\N\tDrama"
                    .to_string(),
                "tt0000003\tshort\tGötz Otto\tGötz Otto\t0\t2010\t\\N\\t3\t\\N".to_string(),
                "tt0000004\tmovie\tUnlisted Movie\tUnlisted Movie\t0\t1999\t\\N\t90\t\\N"
                    .to_string(),
            ],
        );

        let keys = HashSet::from([title_key("Götz Otto"), title_key("Unrated Show")]);
        let count =
            parse_and_swap(&database, &cache, &keys, &HashSet::new()).expect("parse and swap");
        assert_eq!(
            count, 2,
            "the short and the unlisted movie are filtered out"
        );

        let connection = open_database(&database).expect("open");
        type StoredRow = (String, String, Option<i64>, Option<f64>, i64);
        let rows: Vec<StoredRow> = connection
            .prepare("SELECT kind, key1, year, rating, votes FROM titles ORDER BY tconst")
            .expect("query")
            .query_map([], |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            })
            .expect("map")
            .collect::<rusqlite::Result<_>>()
            .expect("rows");
        assert_eq!(
            rows,
            vec![
                (
                    "movie".into(),
                    title_key("Götz Otto"),
                    Some(2010),
                    Some(8.1),
                    1200
                ),
                (
                    "series".into(),
                    title_key("Unrated Show"),
                    Some(2001),
                    Some(5.0),
                    10
                ),
            ]
        );
        // A second parse replaces the table: no leftovers from the first run.
        write_dump(
            &cache.join("title.basics.tsv.gz.new"),
            "tconst\ttitleType\tprimaryTitle\toriginalTitle\tisAdult\tstartYear\tendYear\truntimeMinutes\tgenres\n",
            &["tt0000009\tmovie\tFresh Title\tFresh Title\t0\t2020\t\\N\t90\t\\N".to_string()],
        );
        write_dump(
            &cache.join("title.ratings.tsv.gz.new"),
            "tconst\trating\tnumVotes\n",
            &["tt0000009\t7.0\t5000".to_string()],
        );
        let replaced = parse_and_swap(
            &database,
            &cache,
            &HashSet::from([title_key("Fresh Title")]),
            &HashSet::new(),
        )
        .expect("second parse");
        assert_eq!(replaced, 1);
        let leftovers: i64 = connection
            .query_row("SELECT COUNT(*) FROM titles", [], |row| row.get(0))
            .expect("count");
        assert_eq!(leftovers, 1, "the swap drops the previous parse");
    }
}
