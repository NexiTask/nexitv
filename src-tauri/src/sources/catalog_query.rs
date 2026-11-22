//! The Movies and Series pages' list rules over the catalogue index.
//!
//! A port of `filterItemsBySmartCategory`, `filterItemsByGenre`,
//! `getAvailableGenres`, `sortCatalogItems` and the category sidebar's counts
//! (`smartCatalogFilter.ts`, `CategorySidebar.tsx`). The per-title values they
//! read (genre mask, declared 4K, sports/news/kids, year, added, provider
//! rating, name rank) are derived by the frontend's own functions and stored
//! with each row, so only the list logic lives here. Everything the user or
//! TMDB contributes (hidden categories, favourites, verified resolutions,
//! TMDB ratings and genres, category-name genres) arrives with the query.

use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};

use super::catalog_search::{normalize_text, prepare, prepare_query, score, ItemMeta};

/// Declared 4K or 8K in the title, quality or tags.
pub(crate) const FLAG_ULTRA_HD: u8 = 1;
pub(crate) const FLAG_SPORTS: u8 = 2;
pub(crate) const FLAG_NEWS: u8 = 4;
pub(crate) const FLAG_KIDS: u8 = 8;
/// A channel's own title declares 4K/8K.
pub(crate) const FLAG_TITLE_UHD: u8 = 16;
/// A channel variant's quality badges declare 4K/8K.
pub(crate) const FLAG_BADGE_UHD: u8 = 32;
/// The provider flags the title as adult (its own `is_adult`).
pub(crate) const FLAG_ADULT: u8 = 64;
/// The variant's provider copy carries an https poster (the facet build's
/// finding; plain-http cover hosts proved dead or hanging).
pub(crate) const FLAG_HAS_POSTER: u8 = 128;
/// `TOP_RATED_MIN_RATING` in rating.ts.
const TOP_RATED_MIN_RATING: f64 = 7.0;
/// The votes a title needs behind its IMDb rating to rank in Top Rated (the
/// lightest quality preset's floor), so a handful of 10s cannot top the hub.
const TOP_RATED_MIN_VOTES: f64 = 1_000.0;
/// `CATALOG_GENRES.length` in smartCatalogFilter.ts.
pub(crate) const GENRE_COUNT: usize = 14;
/// Keys are `source position << ORD_BITS | ord`.
pub(crate) const ORD_BITS: u32 = 23;
pub(crate) const MAX_SOURCES: usize = 256;

/// One title's stored facets. Numbers that JavaScript compares as doubles
/// (`added`, `year`) stay doubles here, so differences behave identically.
#[derive(Clone, Debug)]
pub(crate) struct FacetRow {
    pub ord: u32,
    pub id: Box<str>,
    /// Index into the source's category table.
    pub category: Option<u32>,
    pub added: f64,
    pub has_added: bool,
    pub year: Option<f64>,
    pub rating: Option<f64>,
    pub flags: u8,
    pub genres: u16,
    pub rank: u32,
    /// Live channels: the stream-folding group and quality rank.
    pub fold_key: Option<Box<str>>,
    pub fold_rank: u8,
    /// IMDb's rating and vote count for the matched title, when the pipeline
    /// matched one (null while unmatched — the title may simply be off-IMDb).
    pub imdb_rating: Option<f64>,
    pub imdb_votes: Option<f64>,
    /// The matched IMDb title id: every row that carries the same one is a
    /// provider variant of the same work.
    pub imdb_tconst: Option<Box<str>>,
    /// IMDb's runtime in minutes (a series: its typical episode).
    pub imdb_runtime: Option<u16>,
    /// The title as search compares it (`normalizeText`).
    pub search_title: Box<str>,
}

/// One source's titles in provider order.
#[derive(Debug, Default)]
pub(crate) struct SourceFacets {
    pub generation: i64,
    pub rows: Vec<FacetRow>,
    pub categories: Vec<Box<str>>,
}

#[derive(Clone, Copy, Debug, Deserialize)]
pub struct RatingOverride {
    /// Null: no rating to rank by (TMDB knows too few votes, or is pending).
    pub value: Option<f64>,
    #[serde(default)]
    pub votes: f64,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CatalogQuery {
    /// NexiTV's (source-prefixed) category ids.
    pub hidden_category_ids: Vec<String>,
    /// Hidden categories that mark where a title is from ("Indian films"
    /// filed under another market): one copy there hides the whole title.
    pub origin_category_ids: Vec<String>,
    /// The page's active category: null, a `smart:` id, a `country:` id or a
    /// provider category id.
    pub category: Option<String>,
    /// For a country or provider category: the ids it shows, from
    /// `smartCategoryTargetIds`.
    pub target_category_ids: Option<Vec<String>>,
    pub favorite_ids: Vec<String>,
    /// Verified resolutions, already reduced to "is 4K/8K".
    pub ultra_hd: HashMap<String, bool>,
    /// TMDB's effective rating for the titles it has a verdict on.
    pub ratings: HashMap<String, RatingOverride>,
    /// TMDB's genres as masks, for the titles it found.
    pub tmdb_genres: HashMap<String, u16>,
    /// Genres named by each category's name, as masks.
    pub category_genres: HashMap<String, u16>,
    /// Bit index of the selected genre.
    pub genre: Option<u8>,
    pub sort: String,
    /// Fold each live channel's variants into one, like `foldLiveChannels`.
    pub fold: bool,
    /// Instead of a category: exactly these titles, in this order (matched by
    /// the id the list shows, like favourites).
    pub ordered_ids: Option<Vec<String>>,
    /// Keep only titles whose normalized title contains this text.
    pub title_filter: Option<String>,
    /// The quality view: an IMDb rating floor that only titles with at least
    /// this many votes can satisfy (step 0: "≥ 7.0 with ≥ 1k votes" is the
    /// junk killer). Both null: every title passes.
    pub imdb_min_rating: Option<f64>,
    pub imdb_min_votes: Option<f64>,
    /// Leave out the titles the provider flags as adult.
    pub exclude_adult: bool,
    /// One card per title: provider variants sharing an IMDb id collapse into
    /// a single representative.
    pub group_titles: bool,
    /// The filter panel. Every bound is inclusive; null leaves it open.
    pub year_min: Option<f64>,
    pub year_max: Option<f64>,
    /// IMDb runtime in minutes; titles without one fail an active bound.
    pub runtime_min: Option<f64>,
    pub runtime_max: Option<f64>,
    /// Genre bits a title must have at least one of (0: no constraint).
    pub genres_any: u16,
    /// Genre bits a title must have none of.
    pub genres_exclude: u16,
    /// Only titles the provider added at or after this unix time.
    pub added_since: Option<f64>,
    pub ultra_hd_only: bool,
    /// Only titles with an IMDb rating.
    pub rated_only: bool,
    /// `unwatched`, `in-progress` or `watched`, judged per title: watching
    /// any variant of an IMDb title counts for all of them.
    pub watch: Option<String>,
    pub watched_ids: Vec<String>,
    pub in_progress_ids: Vec<String>,
}

/// The watch states of the titles the viewer has touched, by row id and by
/// IMDb identity (so every variant of a title shares its state).
#[derive(Default)]
struct WatchState<'a> {
    watched: HashSet<&'a str>,
    in_progress: HashSet<&'a str>,
}

/// IMDb's genre names onto the genre bar's bits (`CATALOG_GENRES`).
pub(crate) fn imdb_genre_mask(genres: &str) -> u16 {
    const NAMES: [&str; GENRE_COUNT] = [
        "Action",
        "Comedy",
        "Drama",
        "Sci-Fi",
        "Thriller",
        "Horror",
        "Animation",
        "Adventure",
        "Romance",
        "Crime",
        "Documentary",
        "Fantasy",
        "Family",
        "Mystery",
    ];
    genres
        .split(',')
        .filter_map(|genre| NAMES.iter().position(|name| *name == genre.trim()))
        .fold(0, |mask, bit| mask | (1 << bit))
}

#[derive(Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CatalogStats {
    pub category_counts: HashMap<String, u32>,
    pub visible_total: u32,
    pub favorites: u32,
    pub recent: u32,
    pub top_rated: u32,
    pub four_k: u32,
}

#[derive(Debug, Default, PartialEq)]
pub(crate) struct PageResult {
    pub keys: Vec<u32>,
    /// How many titles the category holds before the genre filter.
    pub category_total: u32,
    pub genre_counts: [u32; GENRE_COUNT],
}

#[derive(Clone, Copy)]
struct Entry {
    source: u32,
    row: u32,
}

/// Per-source category facts resolved once per query.
struct CategoryFacts {
    hidden: Vec<bool>,
    origin: Vec<bool>,
    target: Vec<bool>,
    genres: Vec<u16>,
}

/// `foldLiveChannels`: rows sharing a group key become one channel, placed
/// where the group first appears and shown as its best-ranked variant (the
/// first one on a tie).
struct Folding {
    /// The channel each group shows, in group order.
    order: Vec<Entry>,
    /// Groups of more than one variant: shown entry -> (members in provider
    /// order, whether the folded channel declares 4K).
    groups: HashMap<(u32, u32), (Vec<Entry>, bool)>,
}

fn fold(sources: &[&SourceFacets]) -> Folding {
    let mut index: HashMap<&str, usize> = HashMap::new();
    let mut groups: Vec<Vec<Entry>> = Vec::new();
    for (source, facets) in sources.iter().enumerate() {
        for (row, facet) in facets.rows.iter().enumerate() {
            let entry = Entry {
                source: source as u32,
                row: row as u32,
            };
            match facet.fold_key.as_deref() {
                Some(key) => match index.get(key) {
                    Some(&group) => groups[group].push(entry),
                    None => {
                        index.insert(key, groups.len());
                        groups.push(vec![entry]);
                    }
                },
                None => groups.push(vec![entry]),
            }
        }
    }
    let row = |entry: &Entry| &sources[entry.source as usize].rows[entry.row as usize];
    let mut folding = Folding {
        order: Vec::with_capacity(groups.len()),
        groups: HashMap::new(),
    };
    for members in groups {
        let mut primary = members[0];
        for member in &members[1..] {
            if row(member).fold_rank > row(&primary).fold_rank {
                primary = *member;
            }
        }
        folding.order.push(primary);
        if members.len() > 1 {
            let ultra_hd = row(&primary).flags & FLAG_TITLE_UHD != 0
                || members.iter().any(|m| row(m).flags & FLAG_BADGE_UHD != 0);
            folding
                .groups
                .insert((primary.source, primary.row), (members, ultra_hd));
        }
    }
    folding
}

struct Context<'a> {
    sources: &'a [&'a SourceFacets],
    folding: Option<Folding>,
    query: &'a CatalogQuery,
    categories: Vec<CategoryFacts>,
    favorites: HashSet<&'a str>,
    /// Whether TMDB's verdicts take part (the rating checks' candidate pool
    /// is judged on provider data alone).
    use_lookups: bool,
    /// Whether the IMDb pipeline has matched anything: Top Rated ranks on
    /// IMDb's votes once it has, and on the provider rating before that.
    has_imdb: bool,
    /// Present while the watch filter is on.
    watch: Option<WatchState<'a>>,
    /// IMDb titles hidden as a whole (see `with_hidden_titles`).
    hidden_titles: HashSet<&'a str>,
}

type Rating = Option<(f64, f64)>;

/// The listed ids, plus the IMDb identity of every row they name.
fn watch_state<'a>(sources: &'a [&'a SourceFacets], query: &'a CatalogQuery) -> WatchState<'a> {
    let mut state = WatchState::default();
    let watched: HashSet<&str> = query.watched_ids.iter().map(String::as_str).collect();
    let in_progress: HashSet<&str> = query.in_progress_ids.iter().map(String::as_str).collect();
    state.watched.extend(watched.iter().copied());
    state.in_progress.extend(in_progress.iter().copied());
    for row in sources.iter().flat_map(|source| source.rows.iter()) {
        let Some(identity) = row.imdb_tconst.as_deref() else {
            continue;
        };
        if watched.contains(&*row.id) {
            state.watched.insert(identity);
        }
        if in_progress.contains(&*row.id) {
            state.in_progress.insert(identity);
        }
    }
    state
}

fn sign(value: f64) -> Ordering {
    // JavaScript's `a - b || next`: zero and NaN fall through.
    if value > 0.0 {
        Ordering::Greater
    } else if value < 0.0 {
        Ordering::Less
    } else {
        Ordering::Equal
    }
}

/// `compareRatings` in rating.ts.
fn compare_ratings(a: Rating, b: Rating) -> Ordering {
    match (a, b) {
        (None, None) => Ordering::Equal,
        (Some(_), None) => Ordering::Less,
        (None, Some(_)) => Ordering::Greater,
        (Some((av, avotes)), Some((bv, bvotes))) => {
            if av != bv {
                sign(bv - av)
            } else {
                sign(bvotes - avotes)
            }
        }
    }
}

impl<'a> Context<'a> {
    fn new(sources: &'a [&'a SourceFacets], query: &'a CatalogQuery, use_lookups: bool) -> Self {
        let hidden: HashSet<&str> = query
            .hidden_category_ids
            .iter()
            .map(String::as_str)
            .collect();
        let origin: HashSet<&str> = query
            .origin_category_ids
            .iter()
            .map(String::as_str)
            .collect();
        let target: Option<HashSet<&str>> = query
            .target_category_ids
            .as_ref()
            .map(|ids| ids.iter().map(String::as_str).collect());
        let categories = sources
            .iter()
            .map(|source| {
                let names = &source.categories;
                CategoryFacts {
                    hidden: names.iter().map(|c| hidden.contains(&**c)).collect(),
                    origin: names.iter().map(|c| origin.contains(&**c)).collect(),
                    target: names
                        .iter()
                        .map(|c| target.as_ref().is_some_and(|t| t.contains(&**c)))
                        .collect(),
                    genres: names
                        .iter()
                        .map(|c| query.category_genres.get(&**c).copied().unwrap_or(0))
                        .collect(),
                }
            })
            .collect();
        Context {
            sources,
            folding: query.fold.then(|| fold(sources)),
            query,
            categories,
            favorites: query.favorite_ids.iter().map(String::as_str).collect(),
            use_lookups,
            has_imdb: sources
                .iter()
                .any(|source| source.rows.iter().any(|row| row.imdb_rating.is_some())),
            watch: query.watch.as_ref().map(|_| watch_state(sources, query)),
            hidden_titles: HashSet::new(),
        }
        .with_hidden_titles()
    }

    /// A title is hidden as a whole when most of its provider copies sit in
    /// hidden categories, or any one sits in an origin list: hiding India
    /// must not leave Indian films behind through one copy filed under
    /// "Netflix" or another market. A foreign film with a few dubbed copies
    /// among many stays.
    fn with_hidden_titles(mut self) -> Self {
        if self.query.hidden_category_ids.is_empty() {
            return self;
        }
        let mut counts: HashMap<&'a str, (u32, u32, bool)> = HashMap::new();
        for (source, facets) in self.sources.iter().enumerate() {
            let facts = &self.categories[source];
            for row in &facets.rows {
                let Some(identity) = row.imdb_tconst.as_deref() else {
                    continue;
                };
                let entry = counts.entry(identity).or_default();
                entry.1 += 1;
                if let Some(category) = row.category {
                    entry.0 += u32::from(facts.hidden[category as usize]);
                    entry.2 |= facts.origin[category as usize];
                }
            }
        }
        self.hidden_titles = counts
            .into_iter()
            .filter(|(_, (hidden, total, origin))| *origin || hidden * 2 > *total)
            .map(|(identity, _)| identity)
            .collect();
        self
    }

    fn row(&self, entry: Entry) -> &'a FacetRow {
        &self.sources[entry.source as usize].rows[entry.row as usize]
    }

    fn is_hidden(&self, entry: Entry) -> bool {
        let row = self.row(entry);
        row.category
            .is_some_and(|c| self.categories[entry.source as usize].hidden[c as usize])
            || row
                .imdb_tconst
                .as_deref()
                .is_some_and(|identity| self.hidden_titles.contains(identity))
    }

    fn is_target(&self, entry: Entry) -> bool {
        let row = self.row(entry);
        row.category
            .is_some_and(|c| self.categories[entry.source as usize].target[c as usize])
    }

    fn is_ultra_hd(&self, entry: Entry) -> bool {
        let row = self.row(entry);
        if let Some(verified) = self.query.ultra_hd.get(&*row.id) {
            return *verified;
        }
        if let Some((_, ultra_hd)) = self
            .folding
            .as_ref()
            .and_then(|folding| folding.groups.get(&(entry.source, entry.row)))
        {
            return *ultra_hd;
        }
        row.flags & FLAG_ULTRA_HD != 0
    }

    /// `effectiveItemRating`.
    fn rating(&self, entry: Entry) -> Rating {
        let row = self.row(entry);
        if self.use_lookups {
            if let Some(found) = self.query.ratings.get(&*row.id) {
                return found.value.map(|value| (value, found.votes));
            }
        }
        row.rating.map(|value| (value, 0.0))
    }

    /// Top Rated membership: real IMDb votes once the pipeline has matched
    /// anything, the provider's own rating before that.
    fn is_top_rated(&self, row: &FacetRow) -> bool {
        if self.has_imdb {
            row.imdb_rating.is_some_and(|value| {
                value >= TOP_RATED_MIN_RATING
                    && row.imdb_votes.unwrap_or(0.0) >= TOP_RATED_MIN_VOTES
            })
        } else {
            row.rating
                .is_some_and(|value| value >= TOP_RATED_MIN_RATING)
        }
    }

    /// How strongly a variant declares 4K, for picking a group's card:
    /// measured playback first (the verification store), then the title's own
    /// tag, then a provider category that declares 4K/UHD.
    fn quality_rank(&self, entry: Entry) -> u8 {
        let row = self.row(entry);
        if self.query.ultra_hd.get(&*row.id).copied() == Some(true) {
            return 3;
        }
        if row.flags & (FLAG_TITLE_UHD | FLAG_BADGE_UHD) != 0 {
            return 2;
        }
        if let Some(category) = row.category {
            let name = &self.sources[entry.source as usize].categories[category as usize];
            let lowered = name.to_lowercase();
            if lowered.contains("4k") || lowered.contains("uhd") {
                return 1;
            }
        }
        0
    }

    fn genre_mask(&self, entry: Entry) -> u16 {
        let row = self.row(entry);
        let mut mask = row.genres;
        if let Some(category) = row.category {
            mask |= self.categories[entry.source as usize].genres[category as usize];
        }
        if self.use_lookups {
            mask |= self.query.tmdb_genres.get(&*row.id).copied().unwrap_or(0);
        }
        mask
    }

    fn all(&self) -> Box<dyn Iterator<Item = Entry> + '_> {
        if let Some(folding) = &self.folding {
            return Box::new(folding.order.iter().copied());
        }
        Box::new(
            self.sources
                .iter()
                .enumerate()
                .flat_map(|(source, facets)| {
                    (0..facets.rows.len() as u32).map(move |row| Entry {
                        source: source as u32,
                        row,
                    })
                }),
        )
    }

    /// The category, then the title filter.
    fn smart_filter(&self) -> Vec<Entry> {
        let entries = self.category_filter();
        match self
            .query
            .title_filter
            .as_deref()
            .map(normalize_text)
            .filter(|text| !text.trim().is_empty())
        {
            Some(text) => entries
                .into_iter()
                .filter(|&entry| self.row(entry).search_title.contains(text.as_str()))
                .collect(),
            None => entries,
        }
    }

    /// `ordered_ids`: each id's title as listed (first one), once, hidden
    /// ones left out.
    fn ordered(&self, ids: &[String]) -> Vec<Entry> {
        let mut by_id: HashMap<&str, Entry> = HashMap::new();
        for entry in self.all() {
            by_id.entry(&*self.row(entry).id).or_insert(entry);
        }
        let mut seen = HashSet::new();
        ids.iter()
            .filter_map(|id| by_id.get(id.as_str()).copied())
            .filter(|entry| seen.insert((entry.source, entry.row)) && !self.is_hidden(*entry))
            .collect()
    }

    /// `filterItemsBySmartCategory`.
    fn category_filter(&self) -> Vec<Entry> {
        if let Some(ids) = &self.query.ordered_ids {
            return self.ordered(ids);
        }
        let visible = |entry: &Entry| !self.is_hidden(*entry);
        let Some(category) = self.query.category.as_deref() else {
            return self.all().filter(visible).collect();
        };
        if self.query.target_category_ids.is_some() {
            return self
                .all()
                .filter(|entry| self.is_target(*entry) && !self.is_hidden(*entry))
                .collect();
        }
        let flag = |flag: u8| {
            self.all()
                .filter(|entry| visible(entry) && self.row(*entry).flags & flag != 0)
                .collect()
        };
        match category {
            "smart:favorites" => self
                .all()
                .filter(|entry| self.favorites.contains(&*self.row(*entry).id) && visible(entry))
                .collect(),
            "smart:recent" => {
                let mut entries: Vec<Entry> = self
                    .all()
                    .filter(|entry| visible(entry) && self.row(*entry).has_added)
                    .collect();
                entries.sort_by(|a, b| sign(self.row(*b).added - self.row(*a).added));
                entries
            }
            "smart:top-rated" => {
                let mut entries: Vec<Entry> = self
                    .all()
                    .filter(|entry| visible(entry) && self.is_top_rated(self.row(*entry)))
                    .collect();
                self.sort(&mut entries, if self.has_imdb { "imdb" } else { "rating" });
                entries
            }
            "smart:4k" => self
                .all()
                .filter(|entry| visible(entry) && self.is_ultra_hd(*entry))
                .collect(),
            "smart:sports" => flag(FLAG_SPORTS),
            "smart:news" => flag(FLAG_NEWS),
            "smart:kids" => flag(FLAG_KIDS),
            // Without a target list a provider category shows nothing it
            // does not hold; the frontend always sends one.
            _ => Vec::new(),
        }
    }

    /// `sortCatalogItems`: a stable sort, like `Array.prototype.sort`.
    fn sort(&self, entries: &mut [Entry], mode: &str) {
        if entries.len() <= 1 {
            return;
        }
        let missing_year = if mode == "year-asc" { 9999.0 } else { 0.0 };
        let year = |entry: Entry| self.row(entry).year.unwrap_or(missing_year);
        let added = |entry: Entry| self.row(entry).added;
        let by_title = |a: Entry, b: Entry| self.row(a).rank.cmp(&self.row(b).rank);
        // JavaScript comparators return "a minus b"-style numbers; a negative
        // one puts `a` first, which is `Ordering::Less` here.
        let js = sign;
        match mode {
            "recently-added" => entries.sort_by(|&a, &b| {
                js(added(b) - added(a))
                    .then_with(|| js(year(b) - year(a)))
                    .then_with(|| by_title(a, b))
            }),
            "year-desc" => entries.sort_by(|&a, &b| {
                js(year(b) - year(a))
                    .then_with(|| js(added(b) - added(a)))
                    .then_with(|| by_title(a, b))
            }),
            "year-asc" => {
                entries.sort_by(|&a, &b| js(year(a) - year(b)).then_with(|| by_title(a, b)))
            }
            "rating" => {
                let ratings: HashMap<(u32, u32), Rating> = entries
                    .iter()
                    .map(|&entry| ((entry.source, entry.row), self.rating(entry)))
                    .collect();
                let rating = |entry: Entry| ratings[&(entry.source, entry.row)];
                entries.sort_by(|&a, &b| {
                    compare_ratings(rating(a), rating(b))
                        .then_with(|| js(year(b) - year(a)))
                        .then_with(|| by_title(a, b))
                });
            }
            "imdb" => {
                let ratings: HashMap<(u32, u32), Rating> = entries
                    .iter()
                    .map(|&entry| {
                        let row = self.row(entry);
                        (
                            (entry.source, entry.row),
                            row.imdb_rating
                                .map(|value| (value, row.imdb_votes.unwrap_or(0.0))),
                        )
                    })
                    .collect();
                let rating = |entry: Entry| ratings[&(entry.source, entry.row)];
                entries.sort_by(|&a, &b| {
                    compare_ratings(rating(a), rating(b))
                        .then_with(|| js(year(b) - year(a)))
                        .then_with(|| by_title(a, b))
                });
            }
            "name-asc" => entries.sort_by(|&a, &b| by_title(a, b)),
            "name-desc" => entries.sort_by(|&a, &b| by_title(b, a)),
            _ => {}
        }
    }

    /// The quality view: adult titles out, and an IMDb floor that an
    /// unmatched title cannot sit under.
    fn passes_quality(&self, entry: Entry) -> bool {
        let row = self.row(entry);
        if self.query.exclude_adult && row.flags & FLAG_ADULT != 0 {
            return false;
        }
        if !self.passes_filters(entry) {
            return false;
        }
        // The IMDb floor only means something once the pipeline has matched
        // titles for the sources on screen. Until then (a source just added,
        // the first download still running) it would hide the whole catalogue,
        // so it stands aside, like Top Rated falling back to provider ratings.
        if let (true, Some(min_rating)) = (self.has_imdb, self.query.imdb_min_rating) {
            let votes = row.imdb_votes.unwrap_or(0.0);
            if votes < self.query.imdb_min_votes.unwrap_or(0.0) {
                return false;
            }
            if row.imdb_rating.unwrap_or(0.0) < min_rating {
                return false;
            }
        }
        true
    }

    /// The filter panel's bounds (see `CatalogQuery`).
    fn passes_filters(&self, entry: Entry) -> bool {
        let row = self.row(entry);
        let query = self.query;
        let within = |value: Option<f64>, min: Option<f64>, max: Option<f64>| {
            if min.is_none() && max.is_none() {
                return true;
            }
            value.is_some_and(|value| {
                min.map_or(true, |min| value >= min) && max.map_or(true, |max| value <= max)
            })
        };
        if !within(row.year, query.year_min, query.year_max) {
            return false;
        }
        if !within(
            row.imdb_runtime.map(f64::from),
            query.runtime_min,
            query.runtime_max,
        ) {
            return false;
        }
        if query.genres_any != 0 || query.genres_exclude != 0 {
            let mask = self.genre_mask(entry);
            if query.genres_any != 0 && mask & query.genres_any == 0 {
                return false;
            }
            if mask & query.genres_exclude != 0 {
                return false;
            }
        }
        if let Some(since) = query.added_since {
            if !row.has_added || row.added < since {
                return false;
            }
        }
        if query.ultra_hd_only && !self.is_ultra_hd(entry) {
            return false;
        }
        if query.rated_only && row.imdb_rating.is_none() {
            return false;
        }
        if let (Some(mode), Some(state)) = (query.watch.as_deref(), self.watch.as_ref()) {
            let knows = |set: &HashSet<&str>| {
                set.contains(&*row.id)
                    || row
                        .imdb_tconst
                        .as_deref()
                        .is_some_and(|identity| set.contains(identity))
            };
            let in_progress = knows(&state.in_progress);
            let watched = !in_progress && knows(&state.watched);
            let passes = match mode {
                "in-progress" => in_progress,
                "watched" => watched,
                "unwatched" => !in_progress && !watched,
                _ => true,
            };
            if !passes {
                return false;
            }
        }
        true
    }

    fn key(&self, entry: Entry) -> u32 {
        (entry.source << ORD_BITS) | self.row(entry).ord
    }
}

/// One collapsed card: the variant the group shows, plus the member flags the
/// sidebar counts read (a favourite or a recent addition on any variant
/// belongs to the card).
struct Group {
    representative: Entry,
    favorite: bool,
    recent: bool,
}

/// Collapses provider variants of the same IMDb title into one card. The card
/// goes to the best variant — one with a poster first (a card without one is
/// broken), then most 4K (measured playback, title tag, provider category),
/// then the shortest search title, so the plain one beats decorated ones like
/// "EN - X (2022) (US)", then list order. Titles without an IMDb id keep
/// their own card.
fn group_by_identity(context: &Context<'_>, entries: Vec<Entry>) -> Vec<Group> {
    let mut slots: HashMap<&str, usize> = HashMap::with_capacity(entries.len());
    let mut cards: Vec<Group> = Vec::with_capacity(entries.len());
    let mut widths: Vec<usize> = Vec::with_capacity(entries.len());
    // The card's rank: a poster first (a card without one is broken), then
    // the 4K tiers, 0..3.
    let mut ranks: Vec<u8> = Vec::with_capacity(entries.len());
    for entry in entries {
        let row = context.row(entry);
        let favorite = context.favorites.contains(&*row.id);
        let recent = row.has_added;
        let rank = u8::from(row.flags & FLAG_HAS_POSTER != 0) * 4 + context.quality_rank(entry);
        let Some(identity) = row.imdb_tconst.as_deref() else {
            cards.push(Group {
                representative: entry,
                favorite,
                recent,
            });
            widths.push(0);
            ranks.push(0);
            continue;
        };
        let slot = match slots.get(identity) {
            Some(&slot) => slot,
            None => {
                slots.insert(identity, cards.len());
                cards.push(Group {
                    representative: entry,
                    favorite,
                    recent,
                });
                widths.push(row.search_title.len());
                ranks.push(rank);
                continue;
            }
        };
        let card = &mut cards[slot];
        card.favorite |= favorite;
        card.recent |= recent;
        if rank > ranks[slot] || (rank == ranks[slot] && row.search_title.len() < widths[slot]) {
            card.representative = entry;
            widths[slot] = row.search_title.len();
            ranks[slot] = rank;
        }
    }
    cards
}

/// The ordered keys of one catalogue page, with its genre bar's counts.
pub(crate) fn page(sources: &[&SourceFacets], query: &CatalogQuery) -> PageResult {
    let context = Context::new(sources, query, true);
    // The quality view applies before the counts, so the genre bar and the
    // header's total say what the page can actually show.
    let filtered: Vec<Entry> = context
        .smart_filter()
        .into_iter()
        .filter(|&entry| context.passes_quality(entry))
        .collect();
    // Grouping runs on the survivors, so an adult-flagged variant cannot
    // drag its card in behind the viewer's back.
    let category: Vec<Entry> = if query.group_titles {
        group_by_identity(&context, filtered)
            .into_iter()
            .map(|group| group.representative)
            .collect()
    } else {
        filtered
    };
    let mut genre_counts = [0u32; GENRE_COUNT];
    for &entry in &category {
        let mask = context.genre_mask(entry);
        for (bit, count) in genre_counts.iter_mut().enumerate() {
            if mask & (1 << bit) != 0 {
                *count += 1;
            }
        }
    }
    let category_total = category.len() as u32;
    let mut entries: Vec<Entry> = match query.genre {
        Some(bit) if (bit as usize) < GENRE_COUNT => category
            .into_iter()
            .filter(|&entry| context.genre_mask(entry) & (1 << bit) != 0)
            .collect(),
        _ => category,
    };
    // Top Rated is a ranking with its own rule, whatever the page's sort: IMDb's
    // votes once the pipeline has matched titles, the provider's rating before.
    let sort_mode: &str = if query.category.as_deref() == Some("smart:top-rated") {
        if context.has_imdb {
            "imdb"
        } else {
            "rating"
        }
    } else {
        &query.sort
    };
    context.sort(&mut entries, sort_mode);
    PageResult {
        keys: entries.iter().map(|&entry| context.key(entry)).collect(),
        category_total,
        genre_counts,
    }
}

/// The head of a rating ranking that `useTmdbRatingChecks` checks next: the
/// candidate pool is the category judged on provider data alone and holding
/// a provider rating; in a genre, a title is a candidate when it belongs to
/// the genre by what is known, or is unchecked and names no genre at all.
pub(crate) fn rating_head(
    sources: &[&SourceFacets],
    query: &CatalogQuery,
    checked_ids: &[String],
    limit: usize,
) -> Vec<u32> {
    let provider_only = Context::new(sources, query, false);
    let with_lookups = Context::new(sources, query, true);
    let checked: HashSet<&str> = checked_ids.iter().map(String::as_str).collect();
    let genre = query.genre.filter(|&bit| (bit as usize) < GENRE_COUNT);
    let mut candidates: Vec<Entry> = provider_only
        .smart_filter()
        .into_iter()
        .filter(|&entry| provider_only.row(entry).rating.is_some())
        .filter(|&entry| match genre {
            None => true,
            Some(bit) => {
                let mask = with_lookups.genre_mask(entry);
                mask & (1 << bit) != 0
                    || (!checked.contains(&*with_lookups.row(entry).id) && mask == 0)
            }
        })
        .collect();
    with_lookups.sort(&mut candidates, "rating");
    candidates
        .into_iter()
        .take(limit)
        .map(|entry| with_lookups.key(entry))
        .collect()
}

/// The category sidebar's counts, over the channels as shown (folded when
/// folding is on).
pub(crate) fn stats(sources: &[&SourceFacets], query: &CatalogQuery) -> CatalogStats {
    let context = Context::new(sources, query, false);
    let mut stats = CatalogStats::default();
    let mut per_category: Vec<Vec<u32>> = sources
        .iter()
        .map(|source| vec![0u32; source.categories.len()])
        .collect();
    for entry in context.all() {
        let row = context.row(entry);
        if let Some(category) = row.category {
            per_category[entry.source as usize][category as usize] += 1;
        }
    }
    // The title counts follow the cards the pages show: grouped when
    // grouping is on, with a favourite or a recent addition on any variant
    // belonging to the card.
    let visible: Vec<Entry> = context
        .all()
        .filter(|&entry| !context.is_hidden(entry))
        .collect();
    let cards = if query.group_titles {
        group_by_identity(&context, visible)
    } else {
        visible
            .into_iter()
            .map(|entry| {
                let row = context.row(entry);
                Group {
                    representative: entry,
                    favorite: context.favorites.contains(&*row.id),
                    recent: row.has_added,
                }
            })
            .collect()
    };
    for card in &cards {
        let row = context.row(card.representative);
        stats.visible_total += 1;
        if card.favorite {
            stats.favorites += 1;
        }
        if card.recent {
            stats.recent += 1;
        }
        if context.is_top_rated(row) {
            stats.top_rated += 1;
        }
        if context.is_ultra_hd(card.representative) {
            stats.four_k += 1;
        }
    }
    for (source, counts) in sources.iter().zip(per_category) {
        for (category, count) in counts.into_iter().enumerate() {
            if count > 0 {
                *stats
                    .category_counts
                    .entry(source.categories[category].to_string())
                    .or_default() += count;
            }
        }
    }
    stats
}

/// `smartSearch` over the visible titles (folded when folding is on): keys
/// and scores, best first, ties in list order.
pub(crate) fn search(
    sources: &[&SourceFacets],
    query: &CatalogQuery,
    text: &str,
    kind: &str,
) -> Vec<(u32, u32)> {
    let Some(prepared) = prepare_query(text) else {
        return Vec::new();
    };
    let context = Context::new(sources, query, false);
    let mut found: Vec<(u32, u32)> = context
        .all()
        .filter(|&entry| !context.is_hidden(entry))
        .filter_map(|entry| {
            let row = context.row(entry);
            let year = row.year.map(|year| year.to_string());
            let meta = ItemMeta {
                year: year.as_deref(),
                kind,
            };
            let title = prepare(&row.search_title);
            let points = score(&prepared, &title, &meta);
            (points > 0).then(|| (context.key(entry), points))
        })
        .collect();
    found.sort_by_key(|&(_, score)| std::cmp::Reverse(score));
    found
}

/// For folded channels among `keys`: every variant's key, in provider order,
/// so the frontend can fold them with `foldLiveChannels` itself.
pub(crate) fn fold_groups(
    sources: &[&SourceFacets],
    query: &CatalogQuery,
    keys: &[u32],
) -> HashMap<u32, Vec<u32>> {
    if !query.fold {
        return HashMap::new();
    }
    let context = Context::new(sources, query, false);
    let Some(folding) = &context.folding else {
        return HashMap::new();
    };
    let wanted: HashSet<u32> = keys.iter().copied().collect();
    folding
        .groups
        .iter()
        .filter_map(|(&(source, row), (members, _))| {
            let key = context.key(Entry { source, row });
            wanted.contains(&key).then(|| {
                (
                    key,
                    members.iter().map(|&member| context.key(member)).collect(),
                )
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Title {
        id: &'static str,
        category: Option<&'static str>,
        added: f64,
        has_added: bool,
        year: Option<f64>,
        rating: Option<f64>,
        flags: u8,
        genres: u16,
        rank: u32,
        fold_key: Option<&'static str>,
        fold_rank: u8,
        imdb_rating: Option<f64>,
        imdb_votes: Option<f64>,
        imdb_tconst: Option<&'static str>,
        imdb_runtime: Option<u16>,
    }

    fn title(id: &'static str) -> Title {
        Title {
            id,
            category: Some("s:category:1"),
            added: 0.0,
            has_added: false,
            year: None,
            rating: None,
            flags: 0,
            genres: 0,
            rank: 0,
            fold_key: None,
            fold_rank: 0,
            imdb_rating: None,
            imdb_votes: None,
            imdb_tconst: None,
            imdb_runtime: None,
        }
    }

    fn source(titles: Vec<Title>) -> SourceFacets {
        let mut categories: Vec<Box<str>> = Vec::new();
        let rows = titles
            .into_iter()
            .enumerate()
            .map(|(ord, t)| {
                let category =
                    t.category
                        .map(|name| match categories.iter().position(|c| &**c == name) {
                            Some(index) => index as u32,
                            None => {
                                categories.push(name.into());
                                (categories.len() - 1) as u32
                            }
                        });
                FacetRow {
                    ord: ord as u32,
                    id: t.id.into(),
                    category,
                    added: t.added,
                    has_added: t.has_added,
                    year: t.year,
                    rating: t.rating,
                    flags: t.flags,
                    genres: t.genres,
                    rank: t.rank,
                    fold_key: t.fold_key.map(Into::into),
                    fold_rank: t.fold_rank,
                    imdb_rating: t.imdb_rating,
                    imdb_votes: t.imdb_votes,
                    imdb_tconst: t.imdb_tconst.map(Into::into),
                    imdb_runtime: t.imdb_runtime,
                    search_title: normalize_text(t.id).into(),
                }
            })
            .collect();
        SourceFacets {
            generation: 1,
            rows,
            categories,
        }
    }

    fn keys(result: &PageResult) -> Vec<u32> {
        result.keys.clone()
    }

    fn query(sort: &str) -> CatalogQuery {
        CatalogQuery {
            sort: sort.to_string(),
            ..CatalogQuery::default()
        }
    }

    #[test]
    fn default_order_is_provider_order_without_hidden_categories() {
        let facets = source(vec![
            title("a"),
            Title {
                category: Some("s:category:2"),
                ..title("b")
            },
            Title {
                category: None,
                ..title("c")
            },
        ]);
        let mut q = query("default");
        q.hidden_category_ids = vec!["s:category:2".into()];
        assert_eq!(keys(&page(&[&facets], &q)), vec![0, 2]);
    }

    #[test]
    fn keys_carry_the_source_position() {
        let first = source(vec![title("a")]);
        let second = source(vec![title("b"), title("c")]);
        let result = page(&[&first, &second], &query("default"));
        assert_eq!(result.keys, vec![0, 1 << ORD_BITS, (1 << ORD_BITS) | 1]);
    }

    #[test]
    fn sorts_are_stable_and_break_ties_like_the_frontend() {
        let facets = source(vec![
            Title {
                added: 5.0,
                year: Some(2001.0),
                rank: 2,
                ..title("a")
            },
            Title {
                added: 5.0,
                year: Some(2003.0),
                rank: 1,
                ..title("b")
            },
            Title {
                added: 9.0,
                year: None,
                rank: 1,
                ..title("c")
            },
            Title {
                added: 5.0,
                year: Some(2003.0),
                rank: 1,
                ..title("d")
            },
        ]);
        let sorted = |mode: &str| keys(&page(&[&facets], &query(mode)));
        assert_eq!(sorted("recently-added"), vec![2, 1, 3, 0]);
        assert_eq!(sorted("year-desc"), vec![1, 3, 0, 2]);
        // Undated titles go last when the oldest come first.
        assert_eq!(sorted("year-asc"), vec![0, 1, 3, 2]);
        assert_eq!(sorted("name-asc"), vec![1, 2, 3, 0]);
        assert_eq!(sorted("name-desc"), vec![0, 1, 2, 3]);
        assert_eq!(sorted("default"), vec![0, 1, 2, 3]);
        assert_eq!(sorted("unknown"), vec![0, 1, 2, 3]);
    }

    #[test]
    fn rating_order_uses_tmdb_votes_then_year_then_name() {
        let facets = source(vec![
            Title {
                rating: Some(8.0),
                year: Some(2000.0),
                ..title("a")
            },
            Title {
                rating: None,
                ..title("b")
            },
            Title {
                rating: Some(6.0),
                year: Some(2010.0),
                ..title("c")
            },
            Title {
                rating: Some(8.0),
                year: Some(2010.0),
                ..title("d")
            },
        ]);
        let mut q = query("rating");
        assert_eq!(keys(&page(&[&facets], &q)), vec![3, 0, 2, 1]);
        // TMDB: "c" really is an 8.0 with votes, "d" has too few votes.
        q.ratings.insert(
            "c".into(),
            RatingOverride {
                value: Some(8.0),
                votes: 120.0,
            },
        );
        q.ratings.insert(
            "d".into(),
            RatingOverride {
                value: None,
                votes: 0.0,
            },
        );
        // Unrated titles tie, and fall through to year like the frontend's.
        assert_eq!(keys(&page(&[&facets], &q)), vec![2, 0, 3, 1]);
    }

    #[test]
    fn smart_categories_match_the_frontend_rules() {
        let facets = source(vec![
            Title {
                has_added: true,
                added: 3.0,
                rating: Some(7.0),
                flags: FLAG_ULTRA_HD,
                ..title("a")
            },
            Title {
                has_added: true,
                added: 0.0,
                rating: Some(6.9),
                flags: FLAG_SPORTS,
                ..title("b")
            },
            Title {
                has_added: true,
                added: 7.0,
                rating: Some(9.0),
                flags: FLAG_NEWS | FLAG_KIDS,
                ..title("c")
            },
            Title {
                category: Some("s:category:2"),
                has_added: true,
                added: 9.0,
                rating: Some(9.5),
                flags: FLAG_ULTRA_HD,
                ..title("d")
            },
        ]);
        let shown = |category: &str, setup: &dyn Fn(&mut CatalogQuery)| {
            let mut q = query("default");
            q.category = Some(category.to_string());
            q.hidden_category_ids = vec!["s:category:2".into()];
            setup(&mut q);
            keys(&page(&[&facets], &q))
        };
        let none = |_: &mut CatalogQuery| {};
        assert_eq!(shown("smart:recent", &none), vec![2, 0, 1]);
        assert_eq!(shown("smart:top-rated", &none), vec![2, 0]);
        assert_eq!(shown("smart:4k", &none), vec![0]);
        assert_eq!(
            shown("smart:4k", &|q| {
                q.ultra_hd.insert("a".into(), false);
                q.ultra_hd.insert("b".into(), true);
            }),
            vec![1]
        );
        assert_eq!(shown("smart:sports", &none), vec![1]);
        assert_eq!(shown("smart:news", &none), vec![2]);
        assert_eq!(shown("smart:kids", &none), vec![2]);
        assert_eq!(
            shown("smart:favorites", &|q| q.favorite_ids =
                vec!["c".into(), "d".into()]),
            vec![2]
        );
        // A hidden category picked outright is still not shown.
        assert_eq!(
            shown("s:category:2", &|q| q.target_category_ids =
                Some(vec!["s:category:2".into()])),
            Vec::<u32>::new()
        );
        assert_eq!(
            shown("country:de", &|q| q.target_category_ids =
                Some(vec!["s:category:1".into()])),
            vec![0, 1, 2]
        );
        assert_eq!(shown("smart:unknown", &none), Vec::<u32>::new());
    }

    #[test]
    fn genres_combine_title_category_and_tmdb_masks() {
        let facets = source(vec![
            Title {
                genres: 0b01,
                ..title("a")
            },
            Title {
                category: Some("s:category:2"),
                ..title("b")
            },
            title("c"),
        ]);
        let mut q = query("default");
        q.category_genres.insert("s:category:2".into(), 0b10);
        q.tmdb_genres.insert("c".into(), 0b11);
        let all = page(&[&facets], &q);
        assert_eq!(all.category_total, 3);
        assert_eq!(&all.genre_counts[..3], &[2, 2, 0]);
        q.genre = Some(1);
        let second = page(&[&facets], &q);
        assert_eq!(second.keys, vec![1, 2]);
        assert_eq!(second.category_total, 3);
    }

    #[test]
    fn rating_head_judges_the_pool_on_provider_data() {
        let facets = source(vec![
            Title {
                rating: Some(9.0),
                genres: 0b1,
                ..title("a")
            },
            Title {
                rating: Some(8.0),
                ..title("b")
            },
            Title {
                rating: None,
                genres: 0b1,
                ..title("c")
            },
            Title {
                rating: Some(7.5),
                genres: 0b10,
                ..title("d")
            },
        ]);
        let mut q = query("rating");
        q.ratings.insert(
            "a".into(),
            RatingOverride {
                value: Some(5.0),
                votes: 50.0,
            },
        );
        assert_eq!(rating_head(&[&facets], &q, &[], 2), vec![1, 3]);
        // In a genre: "b" names no genre and is unchecked, so it may belong.
        q.genre = Some(0);
        assert_eq!(rating_head(&[&facets], &q, &[], 10), vec![1, 0]);
        assert_eq!(rating_head(&[&facets], &q, &["b".into()], 10), vec![0]);
    }

    #[test]
    fn stats_count_like_the_sidebar() {
        let facets = source(vec![
            Title {
                has_added: true,
                rating: Some(7.0),
                flags: FLAG_ULTRA_HD,
                ..title("a")
            },
            Title {
                category: Some("s:category:2"),
                has_added: true,
                rating: Some(8.0),
                ..title("b")
            },
            Title {
                category: None,
                rating: Some(6.0),
                ..title("c")
            },
        ]);
        let mut q = query("default");
        q.hidden_category_ids = vec!["s:category:2".into()];
        q.favorite_ids = vec!["b".into(), "c".into()];
        q.ultra_hd.insert("c".into(), true);
        let counted = stats(&[&facets], &q);
        assert_eq!(counted.visible_total, 2);
        assert_eq!(counted.favorites, 1);
        assert_eq!(counted.recent, 1);
        assert_eq!(counted.top_rated, 1);
        assert_eq!(counted.four_k, 2);
        assert_eq!(counted.category_counts.get("s:category:1"), Some(&1));
        assert_eq!(counted.category_counts.get("s:category:2"), Some(&1));
        assert_eq!(counted.category_counts.len(), 2);
    }

    #[test]
    fn folds_channel_variants_like_fold_live_channels() {
        let facets = source(vec![
            Title {
                fold_key: Some("c::de::one"),
                fold_rank: 50,
                rank: 3,
                ..title("one-hd")
            },
            Title {
                fold_key: Some("c::de::two"),
                rank: 1,
                flags: FLAG_ULTRA_HD,
                ..title("two")
            },
            Title {
                fold_key: Some("c::de::one"),
                fold_rank: 90,
                rank: 2,
                flags: FLAG_BADGE_UHD,
                ..title("one-4k")
            },
            Title {
                fold_key: Some("c::de::one"),
                fold_rank: 90,
                rank: 0,
                ..title("one-4k-backup")
            },
        ]);
        let mut q = query("default");
        q.fold = true;
        // The group sits where it first appears, shown as its first best variant.
        assert_eq!(keys(&page(&[&facets], &q)), vec![2, 1]);
        q.sort = "name-asc".into();
        assert_eq!(keys(&page(&[&facets], &q)), vec![1, 2]);
        q.sort = "default".into();
        q.category = Some("smart:4k".into());
        // A one-variant group keeps its own 4K claim; a folded one takes its variants'.
        assert_eq!(keys(&page(&[&facets], &q)), vec![2, 1]);
        q.ultra_hd.insert("one-4k".into(), false);
        assert_eq!(keys(&page(&[&facets], &q)), vec![1]);
        let counted = stats(&[&facets], &q);
        assert_eq!(counted.visible_total, 2);
        assert_eq!(counted.category_counts.get("s:category:1"), Some(&2));
        assert_eq!(
            fold_groups(&[&facets], &q, &[2, 1]),
            HashMap::from([(2, vec![0, 2, 3])])
        );
        q.fold = false;
        assert!(fold_groups(&[&facets], &q, &[2]).is_empty());
        q.category = None;
        assert_eq!(keys(&page(&[&facets], &q)), vec![0, 1, 2, 3]);
    }

    #[test]
    fn ordered_ids_keep_their_order_and_match_the_listed_titles() {
        let facets = source(vec![
            Title {
                fold_key: Some("g::one"),
                ..title("one-hd")
            },
            Title {
                fold_key: Some("g::two"),
                ..title("two")
            },
            Title {
                fold_key: Some("g::one"),
                fold_rank: 9,
                ..title("one-4k")
            },
            Title {
                category: Some("s:category:2"),
                fold_key: Some("g::three"),
                ..title("three")
            },
        ]);
        let mut q = query("default");
        q.fold = true;
        q.hidden_category_ids = vec!["s:category:2".into()];
        q.ordered_ids = Some(vec![
            "two".into(),
            "one-hd".into(),
            "one-4k".into(),
            "missing".into(),
            "three".into(),
        ]);
        // "one-hd" is folded into "one-4k", so like a favourite it is not listed;
        // hidden "three" stays out.
        assert_eq!(keys(&page(&[&facets], &q)), vec![1, 2]);
        q.fold = false;
        assert_eq!(keys(&page(&[&facets], &q)), vec![1, 0, 2]);
    }

    #[test]
    fn filters_and_searches_titles() {
        let facets = source(vec![title("Café Noir"), title("BBC One"), title("BBC")]);
        let mut q = query("default");
        q.title_filter = Some("CAFE".into());
        assert_eq!(keys(&page(&[&facets], &q)), vec![0]);
        q.title_filter = Some("  ".into());
        assert_eq!(keys(&page(&[&facets], &q)).len(), 3);
        q.title_filter = None;
        // Exact match first, then the prefix match; no match is left out.
        assert_eq!(
            search(&[&facets], &q, "bbc", "live"),
            vec![(2, 1350), (1, 950)]
        );
        assert!(search(&[&facets], &q, "  ", "live").is_empty());
        q.hidden_category_ids = vec!["s:category:1".into()];
        assert!(search(&[&facets], &q, "bbc", "live").is_empty());
    }

    #[test]
    fn compares_like_javascript_numbers() {
        assert_eq!(sign(f64::NAN), Ordering::Equal);
        assert_eq!(sign(-0.0), Ordering::Equal);
        assert_eq!(compare_ratings(Some((7.0, 0.0)), None), Ordering::Less);
        assert_eq!(compare_ratings(None, None), Ordering::Equal);
        assert_eq!(
            compare_ratings(Some((7.0, 10.0)), Some((7.0, 20.0))),
            Ordering::Greater
        );
    }

    fn rated(id: &'static str, imdb: Option<(f64, f64)>, adult: bool) -> Title {
        Title {
            imdb_rating: imdb.map(|(value, _)| value),
            imdb_votes: imdb.map(|(_, votes)| votes),
            flags: if adult { FLAG_ADULT } else { 0 },
            ..title(id)
        }
    }

    #[test]
    fn the_quality_floor_hides_unmatched_low_vote_and_adult_titles() {
        let facets = source(vec![
            rated("good", Some((7.4, 2_000.0)), false),
            rated("lowscore", Some((5.9, 40_000.0)), false),
            rated("lowvotes", Some((9.0, 40.0)), false),
            rated("unmatched", None, false),
            rated("adult", Some((8.2, 50_000.0)), true),
        ]);
        let mut q = query("default");
        q.imdb_min_rating = Some(7.0);
        q.imdb_min_votes = Some(1_000.0);
        assert_eq!(
            keys(&page(&[&facets], &q)),
            vec![0, 4],
            "the floor keeps 'good' and the adult title"
        );
        q.exclude_adult = true;
        assert_eq!(keys(&page(&[&facets], &q)), vec![0]);
    }

    #[test]
    fn the_quality_floor_stands_aside_until_imdb_has_matched_anything() {
        // A source the IMDb pass has not reached yet: nothing is rated.
        let facets = source(vec![
            rated("a", None, false),
            rated("b", None, false),
            rated("c", None, false),
        ]);
        let mut q = query("default");
        q.imdb_min_rating = Some(7.0);
        q.imdb_min_votes = Some(1_000.0);
        assert_eq!(
            keys(&page(&[&facets], &q)),
            vec![0, 1, 2],
            "the quality floor must not blank a catalogue with no IMDb data"
        );
    }

    #[test]
    fn the_quality_floor_leaves_the_counts_consistent() {
        let facets = source(vec![
            rated("good", Some((7.4, 2_000.0)), false),
            rated("lowscore", Some((5.9, 40_000.0)), false),
        ]);
        let mut q = query("default");
        q.imdb_min_rating = Some(7.0);
        q.imdb_min_votes = Some(1_000.0);
        let result = page(&[&facets], &q);
        assert_eq!(result.category_total, 1);
        assert_eq!(result.keys, vec![0]);
    }

    #[test]
    fn imdb_sort_orders_by_rating_then_votes() {
        let facets = source(vec![
            rated("low", Some((6.0, 90_000.0)), false),
            rated("highfew", Some((8.9, 300.0)), false),
            rated("highmany", Some((8.9, 12_000.0)), false),
            rated("unmatched", None, false),
        ]);
        assert_eq!(
            keys(&page(&[&facets], &query("imdb"))),
            vec![2, 1, 0, 3],
            "highmany, highfew, low, and the unmatched title last"
        );
    }

    #[test]
    fn top_rated_ranks_on_imdb_once_it_has_matched() {
        let facets = source(vec![
            // The provider's stale 10.0, unknown to IMDb: out once IMDb data exists.
            Title {
                rating: Some(10.0),
                ..title("junk")
            },
            rated("good", Some((7.4, 2_000.0)), false),
            rated("better", Some((8.1, 60_000.0)), false),
            rated("lowvotes", Some((9.4, 40.0)), false),
            rated("lowscore", Some((5.9, 40_000.0)), false),
        ]);
        let mut q = query("default");
        q.category = Some("smart:top-rated".into());
        // The page's sort does not decide the ranking; IMDb's votes do.
        q.sort = "name-asc".into();
        assert_eq!(
            keys(&page(&[&facets], &q)),
            vec![2, 1],
            "only the well-voted IMDb ratings stay, best first"
        );
        assert_eq!(
            stats(&[&facets], &q).top_rated,
            2,
            "the count matches the hub"
        );
        // Before the pipeline has matched anything, the provider rating rules.
        let legacy = source(vec![
            Title {
                rating: Some(7.5),
                year: Some(2010.0),
                ..title("old")
            },
            Title {
                rating: Some(9.0),
                ..title("newer")
            },
        ]);
        assert_eq!(keys(&page(&[&legacy], &q)), vec![1, 0]);
        assert_eq!(stats(&[&legacy], &q).top_rated, 2);
    }

    #[test]
    fn hidden_copies_hide_their_title_by_majority_or_origin_list() {
        let facets = source(vec![
            // An Indian film: two hidden copies, one filed under Netflix.
            Title {
                imdb_tconst: Some("tt-in"),
                category: Some("s:category:in"),
                ..title("in-1")
            },
            Title {
                imdb_tconst: Some("tt-in"),
                category: Some("s:category:in"),
                ..title("in-2")
            },
            Title {
                imdb_tconst: Some("tt-in"),
                category: Some("s:category:netflix"),
                ..title("in-netflix")
            },
            // A foreign film with one Hindi-dubbed copy among three stays.
            Title {
                imdb_tconst: Some("tt-us"),
                category: Some("s:category:in"),
                ..title("us-dub")
            },
            Title {
                imdb_tconst: Some("tt-us"),
                category: Some("s:category:netflix"),
                ..title("us-1")
            },
            Title {
                imdb_tconst: Some("tt-us"),
                category: Some("s:category:netflix"),
                ..title("us-2")
            },
            // One copy in an origin list hides a title outvoted elsewhere.
            Title {
                imdb_tconst: Some("tt-ar"),
                category: Some("s:category:ar-indian"),
                ..title("ar-indian")
            },
            Title {
                imdb_tconst: Some("tt-ar"),
                category: Some("s:category:netflix"),
                ..title("ar-1")
            },
            Title {
                imdb_tconst: Some("tt-ar"),
                category: Some("s:category:netflix"),
                ..title("ar-2")
            },
        ]);
        let mut q = query("default");
        q.hidden_category_ids = vec!["s:category:in".into(), "s:category:ar-indian".into()];
        q.origin_category_ids = vec!["s:category:ar-indian".into()];
        assert_eq!(keys(&page(&[&facets], &q)), vec![4, 5]);
    }

    #[test]
    fn imdb_genres_map_onto_the_genre_bar() {
        assert_eq!(imdb_genre_mask("Action,Drama"), 0b101);
        assert_eq!(imdb_genre_mask("Sci-Fi, Mystery"), (1 << 3) | (1 << 13));
        assert_eq!(imdb_genre_mask("Western,Music"), 0);
    }

    #[test]
    fn filters_bound_year_runtime_genres_added_and_rating() {
        let facets = source(vec![
            Title {
                year: Some(1999.0),
                imdb_runtime: Some(136),
                genres: 0b1,
                imdb_rating: Some(8.7),
                has_added: true,
                added: 100.0,
                ..title("matrix")
            },
            Title {
                year: Some(2015.0),
                imdb_runtime: Some(90),
                genres: 0b10,
                has_added: true,
                added: 500.0,
                ..title("comedy")
            },
            Title {
                year: Some(2020.0),
                genres: 0b101,
                ..title("action-drama")
            },
        ]);
        let run = |edit: &dyn Fn(&mut CatalogQuery)| {
            let mut q = query("default");
            edit(&mut q);
            keys(&page(&[&facets], &q))
        };
        assert_eq!(run(&|q| q.year_min = Some(2000.0)), vec![1, 2]);
        assert_eq!(run(&|q| q.year_max = Some(2015.0)), vec![0, 1]);
        // A runtime bound drops titles IMDb gives no runtime for.
        assert_eq!(run(&|q| q.runtime_min = Some(120.0)), vec![0]);
        assert_eq!(run(&|q| q.runtime_max = Some(120.0)), vec![1]);
        assert_eq!(run(&|q| q.genres_any = 0b1), vec![0, 2]);
        assert_eq!(run(&|q| q.genres_exclude = 0b100), vec![0, 1]);
        assert_eq!(run(&|q| q.added_since = Some(200.0)), vec![1]);
        assert_eq!(run(&|q| q.rated_only = true), vec![0]);
    }

    #[test]
    fn watch_state_follows_the_title_across_its_variants() {
        let facets = source(vec![
            Title {
                imdb_tconst: Some("tt1"),
                ..title("copy-a")
            },
            Title {
                imdb_tconst: Some("tt1"),
                ..title("copy-b")
            },
            title("fresh"),
            title("halfway"),
        ]);
        let run = |mode: &str| {
            let mut q = query("default");
            q.watch = Some(mode.to_string());
            q.watched_ids = vec!["copy-a".to_string()];
            q.in_progress_ids = vec!["halfway".to_string()];
            keys(&page(&[&facets], &q))
        };
        // Watching one copy marks the other copy of the same title too.
        assert_eq!(run("watched"), vec![0, 1]);
        assert_eq!(run("unwatched"), vec![2]);
        assert_eq!(run("in-progress"), vec![3]);
    }

    #[test]
    fn grouping_collapses_provider_variants_into_the_best_card() {
        let facets = source(vec![
            // First variant of the title: plain quality, long decorated name.
            Title {
                imdb_tconst: Some("tt1"),
                ..title("en-breaking-bad-decorated")
            },
            // An unmatched title keeps its own card.
            title("solo"),
            // A 4K-declared variant wins the card despite the longer name.
            Title {
                imdb_tconst: Some("tt1"),
                flags: FLAG_TITLE_UHD,
                ..title("breaking-bad-4k-copy")
            },
            Title {
                imdb_tconst: Some("tt1"),
                ..title("bb")
            },
        ]);
        let mut q = query("default");
        q.group_titles = true;
        let result = page(&[&facets], &q);
        assert_eq!(
            keys(&result),
            vec![2, 1],
            "the 4K variant represents tt1; the unmatched title keeps its card"
        );
        assert_eq!(result.category_total, 2);
        // A measured-4K variant outranks a merely declared one.
        q.ultra_hd.insert("bb".into(), true);
        assert_eq!(keys(&page(&[&facets], &q)), vec![3, 1]);
        // Without grouping every variant stays.
        q.group_titles = false;
        q.ultra_hd.clear();
        assert_eq!(keys(&page(&[&facets], &q)), vec![0, 1, 2, 3]);
    }

    #[test]
    fn a_4k_category_lends_its_variant_the_card() {
        let facets = source(vec![
            Title {
                imdb_tconst: Some("tt1"),
                ..title("longer-plain-variant")
            },
            Title {
                imdb_tconst: Some("tt1"),
                category: Some("4K Movies"),
                ..title("x")
            },
        ]);
        let mut q = query("default");
        q.group_titles = true;
        assert_eq!(
            keys(&page(&[&facets], &q)),
            vec![1],
            "the variant filed under the 4K category represents the title"
        );
    }

    #[test]
    fn a_variant_with_a_poster_represents_the_title() {
        let facets = source(vec![
            // Short and 4K-declared, but without a poster: a broken card.
            Title {
                imdb_tconst: Some("tt1"),
                flags: FLAG_TITLE_UHD,
                ..title("bare-4k-copy")
            },
            Title {
                imdb_tconst: Some("tt1"),
                flags: FLAG_HAS_POSTER,
                ..title("longer-copy-with-a-poster")
            },
        ]);
        let mut q = query("default");
        q.group_titles = true;
        assert_eq!(
            keys(&page(&[&facets], &q)),
            vec![1],
            "the poster wins the card over quality and a shorter name"
        );
    }

    #[test]
    fn grouped_counts_follow_the_cards() {
        let facets = source(vec![
            Title {
                imdb_tconst: Some("tt1"),
                imdb_rating: Some(7.5),
                imdb_votes: Some(2_000.0),
                ..title("long-variant")
            },
            Title {
                imdb_tconst: Some("tt1"),
                imdb_rating: Some(7.5),
                imdb_votes: Some(2_000.0),
                has_added: true,
                ..title("b")
            },
            Title {
                has_added: true,
                ..title("unmatched-recent")
            },
        ]);
        let mut q = query("default");
        q.group_titles = true;
        let counted = stats(&[&facets], &q);
        assert_eq!(
            counted.visible_total, 2,
            "the variants collapse; the unmatched title keeps its card"
        );
        assert_eq!(
            counted.top_rated, 1,
            "both tt1 rows carry the same rating; one card"
        );
        assert_eq!(
            counted.recent, 2,
            "a recent addition on any variant belongs to the card"
        );
        // A favourite on a non-card variant still counts, and the favourites
        // page shows the card it belongs to.
        q.favorite_ids = vec!["b".into()];
        assert_eq!(stats(&[&facets], &q).favorites, 1);
        q.category = Some("smart:favorites".into());
        assert_eq!(keys(&page(&[&facets], &q)), vec![1]);
    }
}
