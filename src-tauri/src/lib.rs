mod app_data;
mod credentials;
mod downloads;
mod metadata;
mod perf;
mod platform;
mod player;
mod sources;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    perf::init();
    let context = tauri::generate_context!();
    #[cfg(all(target_os = "linux", not(feature = "desktop-e2e")))]
    if context.config().identifier == app_data::linux_profile::APP_ID {
        app_data::linux_profile::migrate().expect("could not migrate the Movena settings profile");
    }
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init());

    // Test-only WebDriver support is feature-gated so release builds cannot
    // accidentally expose automation commands or a listening driver.
    #[cfg(feature = "desktop-e2e")]
    let builder = builder
        .plugin(tauri_plugin_wdio::init())
        .plugin(tauri_plugin_wdio_webdriver::init());

    builder
        .manage(player::NativePlayerManager::default())
        .manage(downloads::DownloadManager::default())
        .invoke_handler(tauri::generate_handler![
            perf::perf_log,
            platform::commands::player_set_fullscreen,
            platform::commands::player_set_cursor_hidden,
            credentials::xtream::credential_store,
            credentials::xtream::credential_load,
            credentials::xtream::credential_delete,
            credentials::source::source_secret_store,
            credentials::source::source_secret_load,
            credentials::source::source_secret_delete,
            sources::remote::m3u_fetch,
            sources::remote::m3u_probe_stream,
            sources::xmltv::xmltv_fetch,
            metadata::intro_db::introdb_fetch_segments,
            metadata::imdb::imdb_refresh_status,
            metadata::imdb::imdb_refresh_start,
            metadata::imdb::imdb_refresh_set_enabled,
            downloads::download_media_start,
            downloads::download_media_pause,
            downloads::download_media_resume,
            downloads::download_media_cancel,
            downloads::download_media_delete,
            sources::remote::m3u_read_file,
            app_data::files::m3u_write_file,
            sources::cache::m3u_cache_store,
            sources::cache::m3u_cache_load,
            sources::cache::m3u_cache_delete,
            sources::catalog_cache::catalog_cache_store,
            sources::catalog_cache::catalog_cache_load,
            sources::catalog_cache::catalog_cache_delete,
            sources::catalog_index::catalog_index_rows,
            sources::catalog_index::catalog_index_page_status,
            sources::catalog_index::catalog_index_page,
            sources::catalog_index::catalog_index_page_rows,
            sources::catalog_index::catalog_index_variants,
            sources::catalog_index::catalog_index_imdb,
            sources::catalog_index::catalog_index_page_stats,
            sources::catalog_index::catalog_index_rating_head,
            sources::catalog_index::catalog_index_facet_batch,
            sources::catalog_index::catalog_index_store_facets,
            sources::catalog_index::catalog_index_titles,
            sources::catalog_index::catalog_index_store_ranks,
            sources::catalog_index::catalog_index_search,
            app_data::app_data_clear,
            app_data::files::settings_config_read,
            app_data::files::settings_config_write,
            player::mpv_start,
            player::mpv_stop,
            player::mpv_play_pause,
            player::mpv_seek,
            player::mpv_seek_relative,
            player::mpv_set_volume,
            player::mpv_set_speed,
            player::mpv_set_audio_track,
            player::mpv_set_sub_track,
            player::mpv_set_recording,
            player::mpv_set_property,
        ])
        .on_window_event(|_window, _event| {
            // Keep the embedded mpv window glued to the main window's content area.
            #[cfg(target_os = "macos")]
            {
                use tauri::{Manager, WindowEvent};
                if matches!(
                    _event,
                    WindowEvent::Resized(_)
                        | WindowEvent::Moved(_)
                        | WindowEvent::ScaleFactorChanged { .. }
                ) {
                    platform::macos::sync(_window.app_handle());
                    // A fullscreen transition animates, and AppKit can drop the
                    // child window relationship after the last resize event.
                    platform::macos::sync_after_settle(_window.app_handle());
                }
            }
        })
        .setup(|_app| {
            // Claim the dock icon before any stream can start, and take native
            // fullscreen off the table — see macos_embed.
            #[cfg(target_os = "macos")]
            platform::macos::prepare_main_window(_app.handle());
            // Put a GTK video layer under the webview for mpv to render into.
            #[cfg(target_os = "linux")]
            platform::linux::prepare_main_window(_app.handle());

            // The WebDriver plugin installs its own logger so it can forward
            // backend output to the runner. Registering both panics at startup.
            #[cfg(all(debug_assertions, not(feature = "desktop-e2e")))]
            {
                _app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            // The IMDb refresh loop starts on its own delayed thread; it must
            // never sit on the startup path.
            metadata::imdb::schedule(_app.handle().clone());
            Ok(())
        })
        .run(context)
        .expect("error while running tauri application");
}

#[cfg(test)]
mod source_tests {
    use super::sources::remote::{
        apply_conditional_headers, decode_m3u, remote_cache_key, validate_remote_url,
        HttpValidators, M3uFetchOptions,
    };
    use std::collections::HashMap;

    #[test]
    fn validates_source_ids_and_remote_schemes() {
        assert!(validate_remote_url("https://list.test/main.m3u").is_ok());
        assert!(validate_remote_url("file:///private/list.m3u").is_err());
        assert!(validate_remote_url("http://list.test/main.m3u").is_ok());
    }

    #[test]
    fn decodes_legacy_playlists() {
        assert_eq!(decode_m3u(&[b'#', 0x80]), "#€");
    }

    #[test]
    fn builds_opaque_stable_remote_cache_keys() {
        let first = M3uFetchOptions {
            url: "https://guide.test/epg.xml?token=secret".to_string(),
            headers: HashMap::from([
                ("Referer".to_string(), "https://portal.test".to_string()),
                ("Authorization".to_string(), "Bearer private".to_string()),
            ]),
            cache_key: None,
        };
        let reordered = M3uFetchOptions {
            url: first.url.clone(),
            headers: HashMap::from([
                ("Authorization".to_string(), "Bearer private".to_string()),
                ("referer".to_string(), "https://portal.test".to_string()),
            ]),
            cache_key: None,
        };
        let key = remote_cache_key(&first);
        assert_eq!(key, remote_cache_key(&reordered));
        assert_eq!(key.len(), 16);
        assert!(!key.contains("secret"));
    }

    #[test]
    fn applies_http_cache_validators() {
        let mut headers = reqwest::header::HeaderMap::new();
        apply_conditional_headers(
            &mut headers,
            Some(&HttpValidators {
                etag: Some("\"guide-v2\"".to_string()),
                last_modified: Some("Wed, 12 Aug 2026 08:00:00 GMT".to_string()),
            }),
            "XMLTV guide",
        )
        .unwrap();
        assert_eq!(headers[reqwest::header::IF_NONE_MATCH], "\"guide-v2\"");
        assert_eq!(
            headers[reqwest::header::IF_MODIFIED_SINCE],
            "Wed, 12 Aug 2026 08:00:00 GMT"
        );
    }
}
