use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Series {
    #[serde(skip_serializing)]
    local_key: String,
    title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    year: Option<String>,
    genres: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    imdb_url: Option<String>,
}

#[derive(Deserialize)]
pub(crate) struct Request {
    library: Vec<Series>,
    watching: Vec<Series>,
    catalogue: Vec<Series>,
}

impl Request {
    pub(super) fn validate(&self) -> Result<(), String> {
        if self.catalogue.is_empty() || self.library.len() > 100 || self.watching.len() > 64 {
            return Err("The list of series for ChatGPT is invalid.".into());
        }
        Ok(())
    }
}

const PAGE_SIZE: usize = 24;
const INITIAL_CATALOGUE_SIZE: usize = 48;

fn normalized(text: &str) -> String {
    text.split(|ch: char| !ch.is_alphanumeric())
        .filter(|word| !word.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

fn display(imdb_id: &impl Fn(&str) -> Option<String>, series: &Series) -> Value {
    let mut value = json!(series);
    if series.imdb_url.is_none() {
        if let Some(imdb_id) = serde_json::from_str::<(String, String)>(&series.local_key)
            .ok()
            .and_then(|(_, item_id)| imdb_id(&item_id))
        {
            value["imdbUrl"] = json!(format!("https://www.imdb.com/title/{imdb_id}/"));
        }
    }
    value
}

#[derive(Deserialize)]
struct Proposal {
    title: String,
    year: Option<String>,
}

#[derive(Deserialize)]
struct Proposals {
    titles: Vec<Proposal>,
}

#[derive(Deserialize)]
struct Search {
    query: String,
    offset: usize,
}

pub(super) struct Catalogue<'a, F> {
    imdb_id: F,
    request: &'a Request,
    titles: HashMap<String, Vec<usize>>,
    verified: HashSet<usize>,
    miss_rounds: u8,
}

impl<'a, F> Catalogue<'a, F> {
    pub(super) fn key(&self, id: usize) -> Option<&str> {
        self.verified
            .contains(&id)
            .then(|| self.request.catalogue[id].local_key.as_str())
    }
}

impl<'a, F: Fn(&str) -> Option<String>> Catalogue<'a, F> {
    pub(super) fn new(request: &'a Request, imdb_id: F) -> Self {
        let mut titles: HashMap<String, Vec<usize>> = HashMap::new();
        for (id, series) in request.catalogue.iter().enumerate() {
            titles
                .entry(normalized(&series.title))
                .or_default()
                .push(id);
        }
        Self {
            imdb_id,
            request,
            titles,
            verified: HashSet::new(),
            miss_rounds: 0,
        }
    }

    pub(super) fn context(&self) -> Value {
        let total = self.request.catalogue.len();
        let sample_size = total.min(INITIAL_CATALOGUE_SIZE);
        let sample = (0..sample_size).map(|position| self.entry(position * total / sample_size));
        json!({
            "task": "Recommend up to 12 TV series for this viewer and validate availability before returning.",
            "watchedSeries": self.request.watching.iter().map(|series| display(&self.imdb_id, series)).collect::<Vec<_>>(),
            "savedSeries": self.request.library.iter().map(|series| display(&self.imdb_id, series)).collect::<Vec<_>>(),
            "availableSeriesCount": total,
            "availableSeriesSample": sample.collect::<Vec<_>>(),
        })
    }

    fn entry(&self, id: usize) -> Value {
        let mut value = display(&self.imdb_id, &self.request.catalogue[id]);
        value["id"] = json!(id);
        value
    }

    pub(super) fn call(&mut self, name: &str, arguments: &str) -> Value {
        match name {
            "validate_series" => match serde_json::from_str::<Proposals>(arguments) {
                Ok(request) if (1..=12).contains(&request.titles.len()) => self.verify(request),
                _ => json!({"error": "Supply between 1 and 12 title and year pairs."}),
            },
            "search_series" => match serde_json::from_str::<Search>(arguments) {
                Ok(request) if request.query.chars().count() <= 100 => self.search(request),
                _ => {
                    json!({"error": "Supply a query of at most 100 characters and a non-negative offset."})
                }
            },
            _ => json!({"error": "Unknown tool."}),
        }
    }

    fn verify(&mut self, request: Proposals) -> Value {
        let mut missed = false;
        let results: Vec<_> = request.titles.into_iter().map(|proposal| {
            let matches: Vec<_> = self.titles.get(&normalized(&proposal.title))
                .into_iter()
                .flatten()
                .copied()
                .filter(|&id| {
                    proposal.year.as_ref().map_or(true, |year| {
                        self.request.catalogue[id].year.as_ref() == Some(year)
                    })
                })
                .take(PAGE_SIZE)
                .collect();
            if let [id] = matches.as_slice() {
                self.verified.insert(*id);
                json!({"title": proposal.title, "available": self.entry(*id)})
            } else {
                missed = true;
                json!({
                    "title": proposal.title,
                    "available": null,
                    "ambiguousMatches": matches.into_iter().map(|id| self.entry(id)).collect::<Vec<_>>(),
                })
            }
        }).collect();
        if missed {
            self.miss_rounds = self.miss_rounds.saturating_add(1);
        }
        json!({
            "results": results,
            "validatedCount": self.verified.len(),
            "searchSuggested": self.miss_rounds >= 3 && self.verified.len() < 12,
        })
    }

    fn search(&self, request: Search) -> Value {
        let query = normalized(&request.query);
        let terms: Vec<_> = query.split_whitespace().collect();
        let mut matches = self
            .request
            .catalogue
            .iter()
            .enumerate()
            .filter(|(_, series)| {
                if terms.is_empty() {
                    return true;
                }
                let text = normalized(&format!(
                    "{} {} {}",
                    series.title,
                    series.genres.join(" "),
                    series.description.as_deref().unwrap_or_default()
                ));
                terms.iter().all(|term| text.contains(term))
            })
            .skip(request.offset)
            .map(|(id, _)| id);
        let results: Vec<_> = matches
            .by_ref()
            .take(PAGE_SIZE)
            .map(|id| self.entry(id))
            .collect();
        let next_offset = matches.next().map(|_| request.offset + results.len());
        json!({"results": results, "nextOffset": next_offset})
    }
}

pub(super) fn tools() -> Value {
    json!([
        {
            "type": "function", "name": "validate_series", "strict": true,
            "description": "Check whether proposed TV series are eligible and available. Match exact titles, with a year to distinguish remakes. Only IDs confirmed here may be recommended.",
            "parameters": {"type": "object", "additionalProperties": false, "required": ["titles"], "properties": {
                "titles": {"type": "array", "items": {
                    "type": "object", "additionalProperties": false, "required": ["title", "year"],
                    "properties": {"title": {"type": "string"}, "year": {"type": ["string", "null"]}}
                }}
            }}
        },
        {
            "type": "function", "name": "search_series", "strict": true,
            "description": "Search the full eligible local catalogue by words in titles, genres or descriptions. Try fewer terms or an empty query to browse. Use nextOffset for more results.",
            "parameters": {"type": "object", "additionalProperties": false, "required": ["query", "offset"], "properties": {
                "query": {"type": "string"}, "offset": {"type": "integer"}
            }}
        }
    ])
}
