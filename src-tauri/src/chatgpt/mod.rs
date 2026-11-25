mod oauth;
mod recommendation_catalogue;
pub(crate) mod recommendations;
mod store;

use serde::Serialize;
use store::{Profiles, Session, Store};
use tauri::{AppHandle, State};
use tauri_plugin_opener::OpenerExt;
use tokio::sync::watch;

#[derive(Default)]
pub(crate) struct Connection {
    cancel: watch::Sender<()>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConnectionStatus {
    active_client: Option<String>,
    accounts: Vec<AccountStatus>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AccountStatus {
    client_id: String,
    label: String,
    plan_permission: bool,
}

impl From<&Profiles> for ConnectionStatus {
    fn from(profiles: &Profiles) -> Self {
        Self {
            active_client: profiles.active_client.clone(),
            accounts: profiles
                .accounts
                .iter()
                .enumerate()
                .map(|(index, account)| {
                    let label = account.email.as_deref().or(account.name.as_deref());
                    let label = match label {
                        Some(label) if !label.trim().is_empty() => {
                            format!("{label} · {}", index + 1)
                        }
                        _ => format!("ChatGPT account {}", index + 1),
                    };
                    AccountStatus {
                        client_id: account.client_id.clone(),
                        label,
                        plan_permission: account
                            .session
                            .as_ref()
                            .is_some_and(Session::has_plan_permission),
                    }
                })
                .collect(),
        }
    }
}

#[tauri::command(async)]
pub(crate) fn chatgpt_status(app: AppHandle) -> Result<ConnectionStatus, String> {
    let profiles = Store::new(&app)?.load()?;
    Ok(ConnectionStatus::from(&profiles))
}

pub(crate) fn clear_local_accounts(app: &AppHandle) -> Result<(), String> {
    Store::new(app)?.clear()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConnectResult {
    status: ConnectionStatus,
    first_plan_permission: bool,
}

#[tauri::command]
pub(crate) async fn chatgpt_connect(
    app: AppHandle,
    connection: State<'_, Connection>,
    client_id: Option<String>,
) -> Result<ConnectResult, String> {
    let store = Store::new(&app)?;
    let _lock = store.lock()?;
    let cancel = connection.cancel.subscribe();
    let mut profiles = store.load()?;
    if profiles.host_id.is_empty() {
        profiles.host_id = format!("urn:uuid:{}", uuid::Uuid::new_v4());
        store.save(&profiles)?;
    }

    let saved = client_id
        .as_ref()
        .map(|client_id| {
            profiles
                .accounts
                .iter()
                .find(|account| &account.client_id == client_id)
                .ok_or_else(|| "This ChatGPT account is no longer saved.".to_string())
        })
        .transpose()?;
    let attempt = oauth::Attempt::new().await?;
    let client = oauth::client()?;
    let authorization = attempt.authorization_url(&profiles.host_id, saved);
    app.opener()
        .open_url(authorization.as_str(), None::<&str>)
        .map_err(|_| "Could not open ChatGPT sign-in in the browser.".to_string())?;
    let mut account = attempt.finish(&client, saved, cancel).await?;
    let previous = profiles
        .accounts
        .iter_mut()
        .find(|saved| saved.client_id == account.client_id);
    if previous
        .as_ref()
        .is_some_and(|saved| saved.subject != account.subject)
    {
        return Err(
            "Could not match the verified ChatGPT account to its saved registration.".into(),
        );
    }
    let first_plan_permission = account
        .session
        .as_ref()
        .is_some_and(Session::has_plan_permission)
        && !previous
            .as_ref()
            .is_some_and(|saved| saved.plan_permission_seen);
    account.plan_permission_seen = first_plan_permission
        || previous
            .as_ref()
            .is_some_and(|saved| saved.plan_permission_seen);
    profiles.active_client = Some(account.client_id.clone());
    match previous {
        Some(saved) => {
            account.recommendations = saved.recommendations.take();
            *saved = account;
        }
        None => profiles.accounts.push(account),
    }
    store.save(&profiles)?;
    Ok(ConnectResult {
        status: ConnectionStatus::from(&profiles),
        first_plan_permission,
    })
}

#[tauri::command]
pub(crate) fn chatgpt_cancel(connection: State<'_, Connection>) {
    connection.cancel.send_replace(());
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DisconnectResult {
    status: ConnectionStatus,
    revocation_confirmed: bool,
}

#[tauri::command]
pub(crate) async fn chatgpt_disconnect(app: AppHandle) -> Result<DisconnectResult, String> {
    let store = Store::new(&app)?;
    let _lock = store.lock()?;
    let mut profiles = store.load()?;
    let mut revocation_confirmed = true;
    if let Some(account) = profiles
        .accounts
        .iter_mut()
        .find(|account| profiles.active_client.as_deref() == Some(account.client_id.as_str()))
    {
        if let Some(token) = account
            .session
            .as_ref()
            .and_then(|session| session.refresh_token.as_deref())
        {
            revocation_confirmed = match oauth::client() {
                Ok(client) => oauth::revoke(&client, account, token).await,
                Err(_) => false,
            };
        }
        account.session = None;
    }
    profiles.active_client = None;
    store.save(&profiles)?;
    Ok(DisconnectResult {
        status: ConnectionStatus::from(&profiles),
        revocation_confirmed,
    })
}
