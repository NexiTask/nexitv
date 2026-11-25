use super::store::{Account, Session};
use crate::loopback::read_request;
use aws_lc_rs::{digest, rand};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use jsonwebtoken::{decode, decode_header, jwk::JwkSet, Algorithm, DecodingKey, Validation};
use reqwest::Client;
use serde::Deserialize;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::{
    io::AsyncWriteExt,
    net::{TcpListener, TcpStream},
    sync::watch,
    time::{sleep, timeout},
};
use url::Url;

const ISSUER: &str = "https://auth.openai.com";
const AUTHORIZE: &str = "https://auth.openai.com/api/accounts/authorize";
const TOKEN: &str = "https://auth.openai.com/api/accounts/oauth/token";
const DISCOVERY: &str = "https://auth.openai.com/.well-known/openid-configuration";
const JWKS: &str = "https://auth.openai.com/.well-known/jwks.json";
const RESOURCE: &str = "https://api.openai.com/v1";
const REGISTER: &str = "dynamic_agent_client";
const SCOPE: &str = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const CALLBACK: &str = "/auth/callback";

pub(super) fn client() -> Result<Client, String> {
    Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|_| "Could not prepare the connection to OpenAI.".into())
}

pub(super) struct Attempt {
    listener: TcpListener,
    authority: String,
    redirect_uri: String,
    state: String,
    nonce: String,
    verifier: String,
}

impl Attempt {
    pub async fn new() -> Result<Self, String> {
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .await
            .map_err(|_| "Could not start the local ChatGPT sign-in callback.".to_string())?;
        let authority = listener
            .local_addr()
            .map_err(|_| "Could not start the local ChatGPT sign-in callback.".to_string())?
            .to_string();
        Ok(Self {
            listener,
            redirect_uri: format!("http://{authority}{CALLBACK}"),
            authority,
            state: random_value()?,
            nonce: random_value()?,
            verifier: random_value()?,
        })
    }

    pub fn authorization_url(&self, host: &str, account: Option<&Account>) -> Url {
        let mut url = Url::parse(AUTHORIZE).expect("valid OpenAI authorization endpoint");
        let challenge = digest::digest(&digest::SHA256, self.verifier.as_bytes());
        let mut query = url.query_pairs_mut();
        query
            .append_pair(
                "client_id",
                account.map_or(REGISTER, |account| &account.client_id),
            )
            .append_pair("ext_agent_host_id", host)
            .append_pair("response_type", "code")
            .append_pair("redirect_uri", &self.redirect_uri)
            .append_pair("scope", SCOPE)
            .append_pair("resource", RESOURCE)
            .append_pair("state", &self.state)
            .append_pair("nonce", &self.nonce)
            .append_pair("code_challenge_method", "S256")
            .append_pair("code_challenge", &URL_SAFE_NO_PAD.encode(challenge));
        if let Some(account) = account {
            if let Some(session) = &account.session {
                query.append_pair("id_token_hint", &session.id_token);
            }
            if !account
                .session
                .as_ref()
                .is_some_and(Session::has_plan_permission)
            {
                query.append_pair("prompt", "consent");
            }
        } else {
            query.append_pair("agent_name_hint", "NexiTV");
        }
        drop(query);
        url
    }

    pub async fn finish(
        self,
        client: &Client,
        account: Option<&Account>,
        mut cancel: watch::Receiver<()>,
    ) -> Result<Account, String> {
        let (mut stream, callback) = tokio::select! {
            biased;
            _ = cancel.changed() => return Err("ChatGPT sign-in canceled.".into()),
            result = timeout(Duration::from_secs(180), self.callback()) =>
                result.map_err(|_| "ChatGPT sign-in timed out. Try again.".to_string())??,
        };
        let result = async {
            let (code, client_id) = callback.into_code(account)?;
            self.exchange(client, client_id, code, account).await
        }
        .await;
        let message = if result.is_ok() {
            "You can close this tab and return to NexiTV to finish connecting."
        } else {
            "ChatGPT sign-in did not complete. Return to NexiTV for details."
        };
        let _ = timeout(
            Duration::from_secs(1),
            reply(&mut stream, "200 OK", message),
        )
        .await;
        result
    }

    async fn callback(&self) -> Result<(TcpStream, Callback), String> {
        loop {
            let (mut stream, _) = self
                .listener
                .accept()
                .await
                .map_err(|_| "The local ChatGPT callback stopped unexpectedly.".to_string())?;
            if let Ok(Some(target)) = timeout(
                Duration::from_secs(2),
                read_request(&mut stream, &self.authority),
            )
            .await
            {
                if let Some(callback) = parse_callback(&target, &self.state) {
                    return Ok((stream, callback));
                }
            }
            let _ = timeout(
                Duration::from_secs(1),
                reply(
                    &mut stream,
                    "400 Bad Request",
                    "This request did not match NexiTV’s ChatGPT sign-in.",
                ),
            )
            .await;
        }
    }

    async fn exchange(
        &self,
        client: &Client,
        client_id: String,
        code: String,
        account: Option<&Account>,
    ) -> Result<Account, String> {
        let tokens: TokenResponse = client
            .post(TOKEN)
            .form(&[
                ("grant_type", "authorization_code"),
                ("client_id", &client_id),
                ("code", &code),
                ("redirect_uri", &self.redirect_uri),
                ("code_verifier", &self.verifier),
                ("resource", RESOURCE),
            ])
            .send()
            .await
            .and_then(reqwest::Response::error_for_status)
            .map_err(|_| "OpenAI could not complete ChatGPT sign-in. Try again.".to_string())?
            .json()
            .await
            .map_err(|_| "OpenAI returned an unreadable sign-in response.".to_string())?;
        let identity = verify_identity(client, &tokens.id_token, &client_id, &self.nonce).await?;
        if account.is_some_and(|saved| saved.subject != identity.sub) {
            return Err(
                "OpenAI returned a different account. Choose Add account to connect it.".into(),
            );
        }
        let scopes = tokens
            .scope
            .split_ascii_whitespace()
            .map(str::to_owned)
            .collect();
        let expires_at = tokens
            .expires_in
            .and_then(|duration| now().checked_add(duration));
        Ok(Account {
            client_id,
            subject: identity.sub,
            email: identity.email,
            name: identity.name,
            plan_permission_seen: false,
            recommendations: None,
            session: Some(Session {
                id_token: tokens.id_token,
                access_token: tokens.access_token.filter(|token| {
                    !token.is_empty()
                        && tokens
                            .token_type
                            .as_deref()
                            .is_some_and(|kind| kind.eq_ignore_ascii_case("Bearer"))
                }),
                refresh_token: tokens.refresh_token.filter(|token| !token.is_empty()),
                expires_at,
                scopes,
            }),
        })
    }
}

fn random_value() -> Result<String, String> {
    let mut bytes = [0; 32];
    rand::fill(&mut bytes).map_err(|_| "Could not prepare secure ChatGPT sign-in.".to_string())?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

#[derive(Default)]
struct Callback {
    code: Option<String>,
    client_id: Option<String>,
    error: Option<String>,
}

impl Callback {
    fn into_code(self, account: Option<&Account>) -> Result<(String, String), String> {
        if let Some(error) = self.error {
            return Err(if error == "access_denied" {
                "ChatGPT sign-in was declined."
            } else {
                "OpenAI did not authorize ChatGPT sign-in."
            }
            .into());
        }
        let client_id = match (account, self.client_id) {
            (Some(saved), Some(id)) if id != saved.client_id => {
                return Err("OpenAI returned a different ChatGPT registration.".into());
            }
            (Some(saved), _) => saved.client_id.clone(),
            (None, Some(id))
                if id.starts_with("oaiapp_")
                    && id.len() > "oaiapp_".len()
                    && id.len() <= 256
                    && id
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || b"_-".contains(&byte)) =>
            {
                id
            }
            _ => return Err("OpenAI did not return a ChatGPT registration.".into()),
        };
        let code = self
            .code
            .filter(|code| !code.is_empty())
            .ok_or_else(|| "OpenAI did not return a sign-in code.".to_string())?;
        Ok((code, client_id))
    }
}

fn parse_callback(target: &str, expected_state: &str) -> Option<Callback> {
    let (path, query) = target.split_once('?')?;
    if path != CALLBACK {
        return None;
    }
    let mut state = None;
    let mut callback = Callback::default();
    for (key, value) in url::form_urlencoded::parse(query.as_bytes()) {
        let field = match key.as_ref() {
            "state" => &mut state,
            "code" => &mut callback.code,
            "client_id" => &mut callback.client_id,
            "error" => &mut callback.error,
            _ => continue,
        };
        if field.replace(value.into_owned()).is_some() {
            return None;
        }
    }
    (state.as_deref() == Some(expected_state)).then_some(callback)
}

async fn reply(stream: &mut TcpStream, status: &str, message: &str) -> std::io::Result<()> {
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n\r\n{message}",
        message.len()
    );
    stream.write_all(response.as_bytes()).await
}

#[derive(Deserialize)]
struct TokenResponse {
    id_token: String,
    access_token: Option<String>,
    refresh_token: Option<String>,
    expires_in: Option<u64>,
    token_type: Option<String>,
    #[serde(default)]
    scope: String,
}

#[derive(Deserialize)]
struct Identity {
    sub: String,
    nonce: String,
    iat: u64,
    email: Option<String>,
    name: Option<String>,
}

async fn verify_identity(
    client: &Client,
    token: &str,
    id: &str,
    nonce: &str,
) -> Result<Identity, String> {
    let invalid = || "Could not verify the ChatGPT account returned by OpenAI.".to_string();
    let header = decode_header(token).map_err(|_| invalid())?;
    let kid = header
        .kid
        .filter(|_| header.alg == Algorithm::RS256)
        .ok_or_else(invalid)?;
    let keys: JwkSet = client
        .get(JWKS)
        .send()
        .await
        .and_then(reqwest::Response::error_for_status)
        .map_err(|_| invalid())?
        .json()
        .await
        .map_err(|_| invalid())?;
    let key = DecodingKey::from_jwk(keys.find(&kid).ok_or_else(invalid)?).map_err(|_| invalid())?;
    let mut validation = Validation::new(Algorithm::RS256);
    validation.set_issuer(&[ISSUER]);
    validation.set_audience(&[id]);
    validation.set_required_spec_claims(&["exp", "iss", "aud", "sub"]);
    validation.leeway = 5;
    let identity = decode::<Identity>(token, &key, &validation)
        .map_err(|_| invalid())?
        .claims;
    if identity.nonce != nonce
        || identity.sub.trim().is_empty()
        || identity.iat > now().saturating_add(5)
    {
        return Err(invalid());
    }
    Ok(identity)
}

#[derive(Deserialize)]
struct Discovery {
    issuer: String,
    revocation_endpoint: String,
}

pub(super) async fn revoke(client: &Client, account: &Account, token: &str) -> bool {
    let Ok(response) = client
        .get(DISCOVERY)
        .send()
        .await
        .and_then(reqwest::Response::error_for_status)
    else {
        return false;
    };
    let Ok(discovery) = response.json::<Discovery>().await else {
        return false;
    };
    let Ok(endpoint) = Url::parse(&discovery.revocation_endpoint) else {
        return false;
    };
    if discovery.issuer != ISSUER
        || endpoint.origin().ascii_serialization() != ISSUER
        || !endpoint.username().is_empty()
        || endpoint.password().is_some()
    {
        return false;
    }
    for attempt in 0..2 {
        match client
            .post(endpoint.clone())
            .form(&[
                ("token", token),
                ("token_type_hint", "refresh_token"),
                ("client_id", &account.client_id),
            ])
            .send()
            .await
        {
            Ok(response) if response.status() == reqwest::StatusCode::OK => return true,
            Ok(response) if !response.status().is_server_error() => return false,
            _ if attempt == 0 => sleep(Duration::from_millis(400)).await,
            _ => return false,
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn callback_checks_path_state_and_parameter_uniqueness() {
        assert!(parse_callback("/auth/callback?state=other&code=secret", "state").is_none());
        assert!(parse_callback("/auth/callback?state=state&state=state", "state").is_none());
        assert!(parse_callback("/other?state=state&code=secret", "state").is_none());
        let callback = parse_callback(
            "/auth/callback?state=state&code=code&client_id=oaiapp_test",
            "state",
        )
        .unwrap();
        assert_eq!(
            callback.into_code(None).unwrap(),
            ("code".into(), "oaiapp_test".into())
        );
    }

    #[test]
    fn decline_never_returns_a_code() {
        let callback = parse_callback(
            "/auth/callback?state=state&error=access_denied&code=code",
            "state",
        )
        .unwrap();
        assert_eq!(
            callback.into_code(None).unwrap_err(),
            "ChatGPT sign-in was declined."
        );
    }

    #[tokio::test]
    async fn authorization_uses_the_loopback_listener_and_pkce() {
        let attempt = Attempt::new().await.unwrap();
        let url = attempt.authorization_url("urn:uuid:test", None);
        let params: std::collections::HashMap<_, _> = url.query_pairs().collect();
        assert_eq!(params["client_id"], REGISTER);
        assert_eq!(params["redirect_uri"], attempt.redirect_uri);
        assert_eq!(params["state"], attempt.state);
        assert_eq!(params["nonce"], attempt.nonce);
        assert_eq!(params["code_challenge_method"], "S256");
        assert_ne!(params["code_challenge"], attempt.verifier);
        assert!(params["scope"].contains("chatgpt.tokens.use.direct"));
        assert!(!params.contains_key("code_verifier"));
    }
}
