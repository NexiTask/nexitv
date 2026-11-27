//! Title search over the catalogue index: a port of `smartSearch` and
//! `calculateMatchScore` (src/modules/search/lib/search.ts), so live search
//! finds and ranks the same titles without the full list in the webview.

use std::sync::OnceLock;

use icu_normalizer::DecomposingNormalizerBorrowed;

/// `normalizeText`: NFD, combining diacritics (U+0300–U+036F) removed, then
/// lower case.
pub(crate) fn normalize_text(text: &str) -> String {
    if text.is_ascii() {
        return text.to_ascii_lowercase();
    }
    static NFD: OnceLock<DecomposingNormalizerBorrowed<'static>> = OnceLock::new();
    let nfd = NFD.get_or_init(DecomposingNormalizerBorrowed::new_nfd);
    nfd.normalize(text)
        .chars()
        .filter(|c| !('\u{300}'..='\u{36f}').contains(c))
        .collect::<String>()
        .to_lowercase()
}

/// `prepareNormalizedText`: the compact form and the word tokens.
pub(crate) struct Prepared {
    pub normalized: String,
    pub compact: String,
    pub tokens: Vec<String>,
}

fn is_word(c: char) -> bool {
    c.is_ascii_lowercase() || c.is_ascii_digit()
}

pub(crate) fn prepare(normalized: &str) -> Prepared {
    Prepared {
        normalized: normalized.to_string(),
        compact: normalized.chars().filter(|&c| is_word(c)).collect(),
        tokens: normalized
            .split(|c: char| !is_word(c))
            .filter(|token| !token.is_empty())
            .map(str::to_string)
            .collect(),
    }
}

/// `prepareQuery`: null for a query with nothing to match.
pub(crate) fn prepare_query(raw: &str) -> Option<Prepared> {
    let normalized = normalize_text(raw);
    let normalized = normalized.trim_matches(is_js_whitespace);
    if normalized.is_empty() {
        return None;
    }
    let prepared = prepare(normalized);
    (!prepared.tokens.is_empty() || !prepared.compact.is_empty()).then_some(prepared)
}

/// What `String.prototype.trim` removes.
fn is_js_whitespace(c: char) -> bool {
    c.is_whitespace() || c == '\u{feff}'
}

/// `levenshteinDistance` on the ASCII tokens it is given.
fn levenshtein(a: &[u8], b: &[u8]) -> usize {
    if a == b {
        return 0;
    }
    if a.is_empty() {
        return b.len();
    }
    if b.is_empty() {
        return a.len();
    }
    let mut row0: Vec<usize> = (0..=a.len()).collect();
    let mut row1 = vec![0; a.len() + 1];
    for (i, &bc) in b.iter().enumerate() {
        row1[0] = i + 1;
        for (j, &ac) in a.iter().enumerate() {
            let cost = usize::from(ac != bc);
            row1[j + 1] = (row0[j + 1] + 1).min(row1[j] + 1).min(row0[j] + cost);
        }
        std::mem::swap(&mut row0, &mut row1);
    }
    row0[a.len()]
}

/// What the score reads besides the title.
pub(crate) struct ItemMeta<'a> {
    pub year: Option<&'a str>,
    pub kind: &'a str,
}

/// `calculatePreparedMatchScore`.
pub(crate) fn score(query: &Prepared, title: &Prepared, meta: &ItemMeta) -> u32 {
    let (qn, qc) = (query.normalized.as_str(), query.compact.as_str());
    let (tn, tc) = (title.normalized.as_str(), title.compact.as_str());
    let mut score = 0u32;
    if tn == qn {
        score += 1000;
    } else if tc == qc {
        score += 850;
    } else if tn.starts_with(qn) {
        score += 600;
    } else if tc.starts_with(qc) && qc.len() >= 2 {
        score += 500;
    } else if tn.contains(qn) {
        score += 400;
    } else if tc.contains(qc) && qc.len() >= 3 {
        score += 350;
    }

    let mut matched = 0usize;
    let mut token_score = 0u32;
    for q in &query.tokens {
        let mut best = 0u32;
        for t in &title.tokens {
            if t == q {
                best = best.max(100);
            } else if t.starts_with(q.as_str()) {
                best = best.max(75);
            } else if t.contains(q.as_str()) {
                best = best.max(50);
            } else if q.len() >= 3
                && t.len() >= 3
                && q.as_bytes()[0] == t.as_bytes()[0]
                && q.len().abs_diff(t.len()) <= 2
            {
                let distance = levenshtein(q.as_bytes(), t.as_bytes());
                let allowed = if q.len() <= 5 { 1 } else { 2 };
                if distance <= allowed {
                    best = best.max(35 - distance as u32 * 5);
                }
            }
        }
        if best > 0 {
            matched += 1;
            token_score += best;
        }
    }
    score += token_score;
    if !query.tokens.is_empty() && matched == query.tokens.len() {
        score += 250;
    } else if matched > 0 {
        score += (matched as f64 / query.tokens.len() as f64 * 100.0).round() as u32;
    }

    if let Some(year) = meta.year.filter(|year| !year.is_empty()) {
        if qn.contains(year.to_lowercase().as_str()) {
            score += 150;
        }
    }
    if qn.contains(meta.kind) {
        score += 40;
    }
    score
}

#[cfg(test)]
mod tests {
    use super::*;

    fn score_of(title: &str, query: &str, year: Option<&str>) -> u32 {
        let query = prepare_query(query).unwrap();
        let title = prepare(&normalize_text(title));
        score(&query, &title, &ItemMeta { year, kind: "live" })
    }

    #[test]
    fn normalizes_like_normalize_text() {
        assert_eq!(normalize_text("Café München"), "cafe munchen");
        assert_eq!(normalize_text("POKÉMON"), "pokemon");
        assert_eq!(normalize_text(""), "");
        let prepared = prepare(&normalize_text("Spider-Man: No Way Home"));
        assert_eq!(prepared.compact, "spidermannowayhome");
        assert_eq!(prepared.tokens, vec!["spider", "man", "no", "way", "home"]);
        assert!(prepare_query("   ").is_none());
        assert!(prepare_query("!!").is_none());
        assert!(prepare_query(" a ").is_some());
    }

    #[test]
    fn scores_like_the_frontend() {
        // Exact (1000) + one exact token (100) + all tokens (250).
        assert_eq!(score_of("BBC", "bbc", None), 1350);
        // Prefix (600) + token (100) + all (250).
        assert_eq!(score_of("BBC One", "bbc", None), 950);
        // Compact equality (850) + tokens.
        // No token of the title is close enough to the one-word query.
        assert_eq!(score_of("Sky-Sport", "skysport", None), 850);
        // Typo tolerance: "sprot" vs "sport", distance 2 > 1 for a 5-letter token.
        assert_eq!(score_of("Sport", "sprot", None), 0);
        assert_eq!(score_of("Sports", "sportz", None), 30 + 250);
        // Partial token ratio, and the year and kind bonuses.
        assert_eq!(score_of("Arte", "arte zdf", None), 100 + 50);
        assert_eq!(score_of("Film", "film 2020", Some("2020")), 100 + 50 + 150);
        assert_eq!(score_of("Live Sports", "live", None), 600 + 100 + 250 + 40);
        assert_eq!(score_of("News", "zzz", None), 0);
    }

    #[test]
    fn measures_edit_distance() {
        assert_eq!(levenshtein(b"kitten", b"sitting"), 3);
        assert_eq!(levenshtein(b"", b"abc"), 3);
        assert_eq!(levenshtein(b"same", b"same"), 0);
    }
}
