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

/// Declared 4K or 8K in the title, quality or tags.
pub(crate) const FLAG_ULTRA_HD: u8 = 1;
pub(crate) const FLAG_SPORTS: u8 = 2;
pub(crate) const FLAG_NEWS: u8 = 4;
pub(crate) const FLAG_KIDS: u8 = 8;
/// A channel's own title declares 4K/8K.
pub(crate) const FLAG_TITLE_UHD: u8 = 16;
/// A channel variant's quality badges declare 4K/8K.
pub(crate) const FLAG_BADGE_UHD: u8 = 32;
/// `TOP_RATED_MIN_RATING` in rating.ts.
const TOP_RATED_MIN_RATING: f64 = 7.0;
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
    /// Movena's (source-prefixed) category ids.
    pub hidden_category_ids: Vec<String>,
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
}

type Rating = Option<(f64, f64)>;

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
        }
    }

    fn row(&self, entry: Entry) -> &'a FacetRow {
        &self.sources[entry.source as usize].rows[entry.row as usize]
    }

    fn is_hidden(&self, entry: Entry) -> bool {
        let row = self.row(entry);
        row.category
            .is_some_and(|c| self.categories[entry.source as usize].hidden[c as usize])
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

    /// `filterItemsBySmartCategory`.
    fn smart_filter(&self) -> Vec<Entry> {
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
                    .filter(|entry| {
                        visible(entry)
                            && self.rating(*entry).map_or(0.0, |(value, _)| value)
                                >= TOP_RATED_MIN_RATING
                    })
                    .collect();
                self.sort(&mut entries, "rating");
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
            "name-asc" => entries.sort_by(|&a, &b| by_title(a, b)),
            "name-desc" => entries.sort_by(|&a, &b| by_title(b, a)),
            _ => {}
        }
    }

    fn key(&self, entry: Entry) -> u32 {
        (entry.source << ORD_BITS) | self.row(entry).ord
    }
}

/// The ordered keys of one catalogue page, with its genre bar's counts.
pub(crate) fn page(sources: &[&SourceFacets], query: &CatalogQuery) -> PageResult {
    let context = Context::new(sources, query, true);
    let category = context.smart_filter();
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
    context.sort(&mut entries, &query.sort);
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
        if context.is_hidden(entry) {
            continue;
        }
        stats.visible_total += 1;
        if context.favorites.contains(&*row.id) {
            stats.favorites += 1;
        }
        if row.has_added {
            stats.recent += 1;
        }
        if row.rating.unwrap_or(0.0) >= TOP_RATED_MIN_RATING {
            stats.top_rated += 1;
        }
        if context.is_ultra_hd(entry) {
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
}
