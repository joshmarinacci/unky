//! Content-filter settings and list updates.

use crate::*;

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FilterUpdateProgress {
    phase: &'static str,
    received_bytes: u64,
    total_bytes: Option<u64>,
}

pub(crate) fn emit_filter_update_progress(app: &tauri::AppHandle, progress: FilterUpdateProgress) {
    let _ = app.emit(FILTER_UPDATE_PROGRESS_EVENT, progress);
}

pub(crate) fn filter_settings_path(state: &BrowserState) -> Result<PathBuf, String> {
    state
        .filtering_file
        .lock()
        .map_err(|_| "Filter settings path is unavailable".to_string())?
        .clone()
        .ok_or_else(|| "Filter settings path is unavailable".to_string())
}

pub(crate) fn persist_filter_settings(
    state: &BrowserState,
    settings: &FilterSettings,
) -> Result<(), String> {
    settings.persist(&filter_settings_path(state)?)
}

pub(crate) fn commit_filter_settings(
    app: &tauri::AppHandle,
    state: &BrowserState,
    settings: FilterSettings,
) -> Result<FilterSettingsView, String> {
    persist_filter_settings(state, &settings)?;
    let view = settings.view();
    let enabled = settings.enabled;
    let rules = settings.compiled_rules.clone();
    *state
        .filtering
        .lock()
        .map_err(|_| "Filter settings are unavailable".to_string())? = Some(settings);
    #[cfg(target_os = "macos")]
    platforms::macos::update_filter_on_all_pages(app.clone(), enabled, rules);
    #[cfg(not(target_os = "macos"))]
    let _ = (app, enabled, rules);
    Ok(view)
}

#[tauri::command]
pub(crate) fn get_filter_settings(
    webview: tauri::Webview,
    state: tauri::State<'_, BrowserState>,
) -> Result<FilterSettingsView, String> {
    if !is_trusted_browser_ui(webview.label()) {
        return Err("Filter settings are only available to the trusted browser UI".into());
    }
    state
        .filtering
        .lock()
        .map_err(|_| "Filter settings are unavailable".to_string())?
        .as_ref()
        .map(FilterSettings::view)
        .ok_or_else(|| "Filter settings are not initialized".into())
}

#[tauri::command]
pub(crate) async fn set_filtering_enabled(
    webview: tauri::Webview,
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserState>,
    enabled: bool,
) -> Result<FilterSettingsView, String> {
    if !is_trusted_browser_ui(webview.label()) {
        return Err("Filter settings are only available to the trusted browser UI".into());
    }
    #[cfg(not(target_os = "macos"))]
    if enabled {
        return Err("Content filtering is currently available on macOS only".into());
    }
    let mut settings = state
        .filtering
        .lock()
        .map_err(|_| "Filter settings are unavailable".to_string())?
        .clone()
        .ok_or("Filter settings are not initialized")?;
    settings.set_enabled(enabled);
    #[cfg(target_os = "macos")]
    if enabled {
        platforms::macos::validate_filter_rules(app.clone(), settings.compiled_rules.clone())
            .await?;
    }
    commit_filter_settings(&app, &state, settings)
}

#[tauri::command]
pub(crate) async fn set_filter_site_exception(
    webview: tauri::Webview,
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserState>,
    domain: String,
    enabled: bool,
) -> Result<FilterSettingsView, String> {
    if !is_trusted_browser_ui(webview.label()) {
        return Err("Filter settings are only available to the trusted browser UI".into());
    }
    #[cfg(not(target_os = "macos"))]
    return Err("Content filtering is currently available on macOS only".into());
    let mut settings = state
        .filtering
        .lock()
        .map_err(|_| "Filter settings are unavailable".to_string())?
        .clone()
        .ok_or("Filter settings are not initialized")?;
    settings.set_exception(&domain, enabled)?;
    #[cfg(target_os = "macos")]
    platforms::macos::validate_filter_rules(app.clone(), settings.compiled_rules.clone()).await?;
    commit_filter_settings(&app, &state, settings)
}

#[tauri::command]
pub(crate) async fn update_filter_list(
    webview: tauri::Webview,
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserState>,
) -> Result<FilterSettingsView, String> {
    if !is_trusted_browser_ui(webview.label()) {
        return Err("Filter updates are only available to the trusted browser UI".into());
    }
    #[cfg(not(target_os = "macos"))]
    return Err("Content filtering is currently available on macOS only".into());
    const MAX_FILTER_DOWNLOAD_BYTES: usize = 8 * 1024 * 1024;
    emit_filter_update_progress(
        &app,
        FilterUpdateProgress {
            phase: "downloading",
            received_bytes: 0,
            total_bytes: None,
        },
    );
    let app_for_download = app.clone();
    let output = tauri::async_runtime::spawn_blocking(move || {
        use std::io::Read;
        use std::process::Stdio;

        let mut child = Command::new("/usr/bin/curl")
            .args([
                "--fail",
                "--location",
                "--silent",
                "--show-error",
                "--proto",
                "=https",
                "--proto-redir",
                "=https",
                "--max-redirs",
                "5",
                "--max-time",
                "25",
                "--max-filesize",
                "8388608",
                "--user-agent",
                "Unky/0.1 EasyList updater",
                browser::filtering::EASYLIST_URL,
            ])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()?;
        let mut stdout = child
            .stdout
            .take()
            .ok_or_else(|| std::io::Error::other("EasyList stdout unavailable"))?;
        let mut bytes = Vec::new();
        let mut chunk = [0u8; 16 * 1024];
        let mut last_reported = 0;
        loop {
            let read = stdout.read(&mut chunk)?;
            if read == 0 {
                break;
            }
            bytes.extend_from_slice(&chunk[..read]);
            if bytes.len() > MAX_FILTER_DOWNLOAD_BYTES {
                let _ = child.kill();
                let _ = child.wait();
                return Err(std::io::Error::other(
                    "EasyList update is too large; the current list was kept",
                ));
            }
            if bytes.len() - last_reported >= 32 * 1024 {
                last_reported = bytes.len();
                emit_filter_update_progress(
                    &app_for_download,
                    FilterUpdateProgress {
                        phase: "downloading",
                        received_bytes: bytes.len() as u64,
                        total_bytes: None,
                    },
                );
            }
        }
        let status = child.wait()?;
        let mut stderr = String::new();
        if let Some(mut pipe) = child.stderr.take() {
            let _ = pipe.read_to_string(&mut stderr);
        }
        if !status.success() {
            return Err(std::io::Error::other(format!(
                "EasyList update failed: {}",
                stderr.trim()
            )));
        }
        let received_bytes = bytes.len() as u64;
        emit_filter_update_progress(
            &app_for_download,
            FilterUpdateProgress {
                phase: "compiling",
                received_bytes,
                total_bytes: Some(received_bytes),
            },
        );
        Ok::<Vec<u8>, std::io::Error>(bytes)
    })
    .await
    .map_err(|error| format!("EasyList download task failed: {error}"))?
    .map_err(|error| error.to_string())?;
    let raw_list = String::from_utf8(output)
        .map_err(|_| "EasyList update was not valid UTF-8; the current list was kept")?;
    let updated_at = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or_default();
    let mut settings = state
        .filtering
        .lock()
        .map_err(|_| "Filter settings are unavailable".to_string())?
        .clone()
        .ok_or("Filter settings are not initialized")?;
    settings.replace_list(raw_list, updated_at)?;
    #[cfg(target_os = "macos")]
    platforms::macos::validate_filter_rules(app.clone(), settings.compiled_rules.clone()).await?;
    let result = commit_filter_settings(&app, &state, settings);
    if result.is_ok() {
        emit_filter_update_progress(
            &app,
            FilterUpdateProgress {
                phase: "complete",
                received_bytes: 0,
                total_bytes: Some(0),
            },
        );
    }
    result
}
