use rusqlite::{Connection, OpenFlags};
use std::{error::Error, fs, io, path::Path};

pub(crate) const APP_ID: &str = "com.nexitv.desktop";
const LEGACY_APP_ID: &str = "com.movena.desktop";
const MIGRATION_MARKER: &str = ".movena-settings-migrated";
const SETTINGS_DATABASES: [&str; 2] = [
    "tauri_localhost_0.localstorage",
    "http_localhost_5173.localstorage",
];

pub(crate) fn migrate() -> Result<(), Box<dyn Error>> {
    if let Some(data_dir) = dirs::data_local_dir() {
        migrate_settings(&data_dir)?;
    }
    Ok(())
}

fn migrate_settings(data_dir: &Path) -> Result<(), Box<dyn Error>> {
    let legacy = data_dir.join(LEGACY_APP_ID).join("localstorage");
    let current_profile = data_dir.join(APP_ID);
    let marker = current_profile.join(MIGRATION_MARKER);
    if marker.try_exists()? {
        return Ok(());
    }

    let current = current_profile.join("localstorage");
    let mut found_legacy_settings = false;
    for name in SETTINGS_DATABASES {
        let source = legacy.join(name);
        let destination = current.join(name);
        if !source.try_exists()? {
            continue;
        }
        found_legacy_settings = true;
        if destination.try_exists()? {
            continue;
        }

        fs::create_dir_all(&current)?;
        let snapshot = tempfile::NamedTempFile::new_in(&current)?;
        // SQLite includes committed WAL data even while the old app is running.
        let database = Connection::open_with_flags(source, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        database.execute(
            "VACUUM INTO ?1",
            [snapshot.path().to_str().ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "settings path is not valid UTF-8",
                )
            })?],
        )?;
        snapshot.as_file().sync_all()?;
        if let Err(error) = snapshot.persist_noclobber(destination) {
            if error.error.kind() != io::ErrorKind::AlreadyExists {
                return Err(error.error.into());
            }
        }
    }
    if found_legacy_settings {
        fs::File::create(marker)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn copies_both_live_profiles_and_preserves_nexitv_edits() {
        let root = tempfile::tempdir().unwrap();
        let legacy = root.path().join(LEGACY_APP_ID).join("localstorage");
        let current = root.path().join(APP_ID).join("localstorage");
        fs::create_dir_all(&legacy).unwrap();
        let open_legacy_databases: Vec<_> = SETTINGS_DATABASES
            .iter()
            .map(|name| {
                let conn = Connection::open(legacy.join(name)).unwrap();
                conn.execute_batch(
                    "PRAGMA journal_mode = WAL;
                     CREATE TABLE ItemTable(key TEXT PRIMARY KEY, value BLOB);",
                )
                .unwrap();
                conn.execute(
                    "INSERT INTO ItemTable VALUES ('iptv-settings-storage', ?1)",
                    [name],
                )
                .unwrap();
                conn
            })
            .collect();

        migrate_settings(root.path()).unwrap();
        for name in SETTINGS_DATABASES {
            let migrated = Connection::open(current.join(name)).unwrap();
            let value: String = migrated
                .query_row("SELECT value FROM ItemTable", [], |row| row.get(0))
                .unwrap();
            assert_eq!(value, name);
            migrated.execute("DELETE FROM ItemTable", []).unwrap();
        }

        migrate_settings(root.path()).unwrap();
        for (name, source) in SETTINGS_DATABASES.into_iter().zip(open_legacy_databases) {
            let migrated = Connection::open(current.join(name)).unwrap();
            let target_count: i64 = migrated
                .query_row("SELECT count(*) FROM ItemTable", [], |row| row.get(0))
                .unwrap();
            let source_count: i64 = source
                .query_row("SELECT count(*) FROM ItemTable", [], |row| row.get(0))
                .unwrap();
            assert_eq!(target_count, 0);
            assert_eq!(source_count, 1);
        }

        let reset_profile = current.join(SETTINGS_DATABASES[0]);
        fs::remove_file(&reset_profile).unwrap();
        migrate_settings(root.path()).unwrap();
        assert!(!reset_profile.exists());
    }

    #[test]
    fn fresh_install_needs_no_migration() {
        let root = tempfile::tempdir().unwrap();
        migrate_settings(root.path()).unwrap();
        assert!(!root.path().join(APP_ID).exists());
    }
}
