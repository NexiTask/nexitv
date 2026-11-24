use super::store::{Account, Session, Store};
use eventsource_stream::Eventsource;
use futures_util::StreamExt;
use reqwest::{Client, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const API: &str = "https://api.openai.com/v1";
const TOKEN: &str = "https://auth.openai.com/api/accounts/oauth/token";
const GENRES: &[&str] = &[
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
const MAX_CANDIDATES: usize = 48;
const MAX_PICKS: usize = 12;
const INSTRUCTIONS: &str = "Rank TV series and episodes for this viewer. Use their favorite and watched genre summaries, give a varied mix across available kinds and prefer recently added items when relevant. Prefer only candidates that stand out, up to 12. Reply with one JSON object, no Markdown, shaped like {\"picks\":[{\"id\":0,\"genreMatch\":true}]}. Use only supplied IDs, once each. genreMatch must be true only when the candidate shares a genre with the viewer's summary.";

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
enum Kind {
    Resume,
    Next,
    Discover,
    New,
    Upcoming,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Candidate {
    #[serde(skip_serializing)]
    local_key: String,
    kind: Kind,
    genres: Vec<String>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Request {
    favorites: Vec<String>,
    watching: Vec<String>,
    candidates: Vec<Candidate>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Snapshot {
    generated_at: u64,
    picks: Vec<SavedPick>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SavedPick {
    key: String,
    genre_match: bool,
}

#[derive(Deserialize)]
struct Model {
    slug: String,
    visibility: Option<String>,
}

#[derive(Deserialize)]
struct Models {
    models: Vec<Model>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModelPick {
    id: usize,
    genre_match: bool,
}

#[derive(Deserialize)]
struct Rankings {
    picks: Vec<ModelPick>,
}

#[derive(Deserialize)]
struct RefreshedToken {
    access_token: String,
    refresh_token: Option<String>,
    expires_in: u64,
    scope: Option<String>,
    token_type: String,
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn active_account(accounts: &[Account], active_client: Option<&str>) -> Option<usize> {
    accounts
        .iter()
        .position(|account| Some(account.client_id.as_str()) == active_client)
}

#[tauri::command(async)]
pub(crate) fn recommendations_cached(
    app: tauri::AppHandle,
    client_id: String,
) -> Result<Option<Snapshot>, String> {
    let profiles = Store::new(&app)?.load()?;
    if profiles.active_client.as_deref() != Some(client_id.as_str()) {
        return Ok(None);
    }
    Ok(profiles
        .accounts
        .into_iter()
        .find(|account| Some(account.client_id.as_str()) == profiles.active_client.as_deref())
        .and_then(|account| account.recommendations))
}

#[tauri::command]
pub(crate) async fn recommendations_generate(
    app: tauri::AppHandle,
    client_id: String,
    request: Request,
) -> Result<Snapshot, String> {
    validate(&request)?;
    let store = Store::new(&app)?;
    let _lock = store.lock()?;
    let mut profiles = store.load()?;
    let index = active_account(&profiles.accounts, profiles.active_client.as_deref())
        .filter(|index| profiles.accounts[*index].client_id == client_id)
        .ok_or_else(|| "Connect your ChatGPT account in Settings.".to_string())?;
    let client = Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(10))
        .read_timeout(Duration::from_secs(30))
        .timeout(Duration::from_secs(90))
        .build()
        .map_err(|_| "Could not prepare the connection to OpenAI.".to_string())?;

    let session = profiles.accounts[index]
        .session
        .as_ref()
        .filter(|session| session.has_plan_permission())
        .ok_or_else(|| "Enable ChatGPT plan usage in Settings.".to_string())?;
    if session
        .expires_at
        .is_some_and(|expiry| expiry <= now().saturating_add(60))
    {
        match refresh(&client, &client_id, session).await {
            Ok(replacement) => profiles.accounts[index].session = Some(replacement),
            Err(RefreshError::Reconnect) => {
                profiles.accounts[index].session = None;
                store.save(&profiles)?;
                return Err("Your ChatGPT session expired. Reconnect in Settings.".into());
            }
            Err(RefreshError::Unavailable) => {
                return Err("Could not renew the ChatGPT session. Try again.".into());
            }
        }
        store.save(&profiles)?;
    }
    let token = profiles.accounts[index]
        .session
        .as_ref()
        .filter(|session| session.has_plan_permission())
        .and_then(|session| session.access_token.as_deref())
        .ok_or_else(|| "Enable ChatGPT plan usage in Settings.".to_string())?;
    let snapshot = rank(&client, token, &request).await?;
    profiles.accounts[index].recommendations = Some(snapshot);
    store.save(&profiles)?;
    Ok(profiles.accounts[index]
        .recommendations
        .take()
        .expect("snapshot was just saved"))
}

enum RefreshError {
    Reconnect,
    Unavailable,
}

async fn refresh(client: &Client, id: &str, session: &Session) -> Result<Session, RefreshError> {
    let current = session
        .refresh_token
        .as_deref()
        .ok_or(RefreshError::Reconnect)?;
    let response = client
        .post(TOKEN)
        .form(&[
            ("grant_type", "refresh_token"),
            ("client_id", id),
            ("refresh_token", current),
            ("resource", API),
        ])
        .send()
        .await
        .map_err(|_| RefreshError::Unavailable)?;
    if !response.status().is_success() {
        let payload: Value = response.json().await.unwrap_or_default();
        let code = payload["error"]
            .as_str()
            .or(payload["error"]["code"].as_str());
        return Err(match code {
            Some(
                "invalid_grant"
                | "invalid_refresh_token"
                | "token_expired"
                | "refresh_token_expired"
                | "refresh_token_invalidated"
                | "refresh_token_reused",
            ) => RefreshError::Reconnect,
            _ => RefreshError::Unavailable,
        });
    }
    let token: RefreshedToken = response
        .json()
        .await
        .map_err(|_| RefreshError::Unavailable)?;
    if !token.token_type.eq_ignore_ascii_case("bearer") || token.access_token.is_empty() {
        return Err(RefreshError::Unavailable);
    }
    Ok(Session {
        id_token: session.id_token.clone(),
        access_token: Some(token.access_token),
        refresh_token: token
            .refresh_token
            .filter(|token| !token.is_empty())
            .or_else(|| session.refresh_token.clone()),
        expires_at: Some(now().saturating_add(token.expires_in)),
        scopes: token
            .scope
            .map(|scope| scope.split_ascii_whitespace().map(str::to_owned).collect())
            .unwrap_or_else(|| session.scopes.clone()),
    })
}

fn validate(request: &Request) -> Result<(), String> {
    let valid_genres = |genres: &[String]| {
        genres.len() <= GENRES.len() && genres.iter().all(|genre| GENRES.contains(&genre.as_str()))
    };
    let mut keys = HashSet::new();
    if request.candidates.is_empty()
        || request.candidates.len() > MAX_CANDIDATES
        || !valid_genres(&request.favorites)
        || !valid_genres(&request.watching)
        || !request.candidates.iter().all(|candidate| {
            !candidate.local_key.is_empty()
                && candidate.local_key.len() <= 512
                && keys.insert(&candidate.local_key)
                && valid_genres(&candidate.genres)
        })
    {
        return Err("The list of series for ChatGPT is invalid.".into());
    }
    Ok(())
}

fn model_input(request: &Request) -> Value {
    let candidates: Vec<_> = request
        .candidates
        .iter()
        .enumerate()
        .map(|(id, item)| json!({ "id": id, "candidate": item }))
        .collect();
    json!({ "favoriteGenres": request.favorites, "watchedGenres": request.watching, "candidates": candidates })
}

fn error_message(status: StatusCode) -> String {
    match status {
        StatusCode::TOO_MANY_REQUESTS => {
            "ChatGPT usage limit reached. Check your plan usage in ChatGPT."
        }
        StatusCode::UNAUTHORIZED => "ChatGPT could not verify the session. Reconnect in Settings.",
        StatusCode::FORBIDDEN => "This account cannot use its ChatGPT plan for this request.",
        _ => "ChatGPT recommendations are unavailable. Try again.",
    }
    .into()
}

async fn rank(client: &Client, token: &str, request: &Request) -> Result<Snapshot, String> {
    let unavailable = || "Could not reach ChatGPT. Try again.".to_string();
    let models = client
        .get(format!("{API}/models"))
        .bearer_auth(token)
        .send()
        .await
        .map_err(|_| unavailable())?;
    if !models.status().is_success() {
        return Err(error_message(models.status()));
    }
    let model = models
        .json::<Models>()
        .await
        .map_err(|_| unavailable())?
        .models
        .into_iter()
        .find(|model| model.visibility.as_deref() == Some("list") && !model.slug.is_empty())
        .ok_or_else(|| "No ChatGPT model is available for this account.".to_string())?;
    let response = client
        .post(format!("{API}/responses"))
        .bearer_auth(token)
        .json(&json!({
            "model": model.slug,
            "store": false,
            "stream": true,
            "instructions": INSTRUCTIONS,
            "text": { "format": {
                "type": "json_schema",
                "name": "series_recommendations",
                "strict": true,
                "schema": {
                    "type": "object",
                    "properties": { "picks": { "type": "array", "items": {
                        "type": "object",
                        "properties": { "id": { "type": "integer" }, "genreMatch": { "type": "boolean" } },
                        "required": ["id", "genreMatch"],
                        "additionalProperties": false
                    } } },
                    "required": ["picks"],
                    "additionalProperties": false
                }
            } },
            "input": [{"role": "user", "content": model_input(request).to_string()}],
        }))
        .send()
        .await
        .map_err(|_| unavailable())?;
    if !response.status().is_success() {
        return Err(error_message(response.status()));
    }

    let mut events = response.bytes_stream().eventsource();
    let mut output = String::new();
    while let Some(event) = events.next().await {
        let event = event.map_err(|_| unavailable())?;
        let event: Value = serde_json::from_str(&event.data)
            .map_err(|_| "ChatGPT returned an invalid response.".to_string())?;
        match event["type"].as_str() {
            Some("response.output_text.delta") => {
                if let Some(delta) = event["delta"].as_str() {
                    output.push_str(delta);
                    if output.len() > 16_384 {
                        return Err("ChatGPT returned too much recommendation data.".into());
                    }
                }
            }
            Some("response.completed") => return snapshot(&output, request),
            Some("response.failed" | "response.incomplete" | "error") => {
                let code = event["response"]["error"]["code"]
                    .as_str()
                    .or(event["code"].as_str())
                    .or(event["error"]["code"].as_str());
                return Err(match code {
                    Some("subscription_sharing_usage_limit_exceeded") => {
                        error_message(StatusCode::TOO_MANY_REQUESTS)
                    }
                    Some("subscription_sharing_user_not_eligible") => {
                        error_message(StatusCode::FORBIDDEN)
                    }
                    Some("subscription_sharing_invalid_user") => {
                        error_message(StatusCode::UNAUTHORIZED)
                    }
                    _ => "ChatGPT did not finish ranking the recommendations. Try again.".into(),
                });
            }
            _ => {}
        }
    }
    Err("ChatGPT ended the response before the recommendations were ready.".into())
}

fn snapshot(output: &str, request: &Request) -> Result<Snapshot, String> {
    let invalid = || "ChatGPT returned an invalid recommendation list.".to_string();
    let rankings: Rankings = serde_json::from_str(output).map_err(|_| invalid())?;
    let mut seen = HashSet::new();
    if rankings.picks.is_empty() || rankings.picks.len() > MAX_PICKS {
        return Err(invalid());
    }
    let picks = rankings
        .picks
        .into_iter()
        .map(|pick| {
            let candidate = request
                .candidates
                .get(pick.id)
                .filter(|_| seen.insert(pick.id))
                .ok_or_else(invalid)?;
            let genre_match = pick.genre_match
                && candidate.genres.iter().any(|genre| {
                    request.favorites.contains(genre) || request.watching.contains(genre)
                });
            Ok(SavedPick {
                key: candidate.local_key.clone(),
                genre_match,
            })
        })
        .collect::<Result<_, String>>()?;
    Ok(Snapshot {
        generated_at: now(),
        picks,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn outbound_data_uses_temporary_ids_and_picks_must_match_the_shortlist() {
        let request = Request {
            favorites: vec!["Drama".into()],
            watching: vec![],
            candidates: vec![Candidate {
                local_key: "private-provider-series-id".into(),
                kind: Kind::Discover,
                genres: vec!["Comedy".into()],
            }],
        };
        assert!(validate(&request).is_ok());
        assert!(!model_input(&request)
            .to_string()
            .contains("private-provider-series-id"));
        assert!(snapshot(r#"{"picks":[{"id":1,"genreMatch":true}]}"#, &request).is_err());
        assert!(snapshot(
            r#"{"picks":[{"id":0,"genreMatch":false},{"id":0,"genreMatch":false}]}"#,
            &request
        )
        .is_err());
        let result = snapshot(r#"{"picks":[{"id":0,"genreMatch":true}]}"#, &request).unwrap();
        assert_eq!(result.picks[0].key, request.candidates[0].local_key);
        assert!(!result.picks[0].genre_match);
    }
}
