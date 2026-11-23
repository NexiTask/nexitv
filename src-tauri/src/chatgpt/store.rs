use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File, OpenOptions},
    io::ErrorKind,
    path::{Path, PathBuf},
};
use tauri::Manager;

#[derive(Default, Deserialize, Serialize)]
pub(super) struct Profiles {
    pub host_id: String,
    pub active_client: Option<String>,
    pub accounts: Vec<Account>,
}

#[derive(Deserialize, Serialize)]
pub(super) struct Account {
    pub client_id: String,
    pub subject: String,
    pub email: Option<String>,
    pub name: Option<String>,
    #[serde(default)]
    pub plan_permission_seen: bool,
    pub session: Option<Session>,
}

#[derive(Deserialize, Serialize)]
pub(super) struct Session {
    pub id_token: String,
    pub access_token: Option<String>,
    pub refresh_token: Option<String>,
    pub expires_at: Option<u64>,
    pub scopes: Vec<String>,
}

impl Session {
    pub fn has_plan_permission(&self) -> bool {
        self.access_token.is_some()
            && self
                .scopes
                .iter()
                .any(|scope| scope == "chatgpt.tokens.use.direct")
            && self.scopes.iter().any(|scope| scope == "resource.invoke")
    }
}

pub(super) struct Store(PathBuf);

impl Store {
    pub fn new(app: &tauri::AppHandle) -> Result<Self, String> {
        app.path()
            .app_local_data_dir()
            .map(|path| Self(path.join("chatgpt")))
            .map_err(|_| "ChatGPT storage is unavailable.".into())
    }

    pub fn load(&self) -> Result<Profiles, String> {
        match File::open(self.profile_path()) {
            Ok(file) => serde_json::from_reader(file)
                .map_err(|_| "Could not read saved ChatGPT accounts.".into()),
            Err(error) if error.kind() == ErrorKind::NotFound => Ok(Profiles::default()),
            Err(_) => Err("Could not open saved ChatGPT accounts.".into()),
        }
    }

    // Serialize changes across app processes. The file stays open until the
    // operation finishes, including any exchange or revocation in flight.
    pub fn lock(&self) -> Result<File, String> {
        create_private_dir(&self.0).map_err(|_| "Could not open ChatGPT storage.".to_string())?;
        let mut options = OpenOptions::new();
        options.read(true).write(true).create(true).truncate(false);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let file = options
            .open(self.0.join("accounts.lock"))
            .map_err(|_| "Could not lock ChatGPT storage.".to_string())?;
        fs2::FileExt::try_lock_exclusive(&file)
            .map_err(|_| "Another ChatGPT connection action is in progress.".to_string())?;
        Ok(file)
    }

    pub fn save(&self, profiles: &Profiles) -> Result<(), String> {
        // NamedTempFile creates owner-only files on Unix. On Windows the
        // temporary and final files inherit the per-user app data directory ACL.
        let mut file = tempfile::NamedTempFile::new_in(&self.0)
            .map_err(|_| "Could not create protected ChatGPT storage.".to_string())?;
        serde_json::to_writer(file.as_file_mut(), profiles)
            .map_err(|_| "Could not save the ChatGPT connection.".to_string())?;
        file.as_file()
            .sync_all()
            .map_err(|_| "Could not save the ChatGPT connection.".to_string())?;
        file.persist(self.profile_path())
            .map_err(|_| "Could not update the saved ChatGPT connection.".to_string())?;
        Ok(())
    }

    pub fn clear(&self) -> Result<(), String> {
        if !self.0.exists() {
            return Ok(());
        }
        let _lock = self.lock()?;
        match fs::remove_file(self.profile_path()) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
            Err(_) => Err("Could not delete saved ChatGPT accounts.".into()),
        }
    }

    fn profile_path(&self) -> PathBuf {
        self.0.join("accounts.json")
    }
}

fn create_private_dir(path: &Path) -> std::io::Result<()> {
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn private_store_preserves_host_and_serializes_writes() {
        let root = tempfile::tempdir().unwrap();
        let store = Store(root.path().join("chatgpt"));
        assert!(store.load().unwrap().host_id.is_empty());
        let lock = store.lock().unwrap();
        assert!(store.lock().is_err());
        let profiles = Profiles {
            host_id: "urn:uuid:test".into(),
            ..Profiles::default()
        };
        store.save(&profiles).unwrap();
        assert_eq!(store.load().unwrap().host_id, profiles.host_id);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let permissions = fs::metadata(store.profile_path()).unwrap().permissions();
            assert_eq!(permissions.mode() & 0o777, 0o600);
        }
        drop(lock);
        assert!(store.lock().is_ok());
    }
}
