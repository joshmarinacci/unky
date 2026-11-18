//! Downloads list, popover, and reveal.

use crate::*;

pub(crate) fn emit_downloads(
    app: &tauri::AppHandle,
    downloads: &std::sync::Arc<std::sync::Mutex<Vec<DownloadEntry>>>,
) {
    if let Ok(items) = downloads.lock() {
        let _ = app.emit_to("main", DOWNLOADS_EVENT, items.clone());
    }
}

pub(crate) fn monitor_download(
    app: tauri::AppHandle,
    downloads: std::sync::Arc<std::sync::Mutex<Vec<DownloadEntry>>>,
    download_id: String,
    path: PathBuf,
) {
    thread::spawn(move || loop {
        thread::sleep(Duration::from_millis(250));
        let mut should_stop = false;
        let mut changed = false;
        if let Ok(mut items) = downloads.lock() {
            if let Some(item) = items.iter_mut().find(|item| item.id == download_id) {
                if item.status != DownloadStatus::Downloading {
                    should_stop = true;
                } else if let Ok(metadata) = fs::metadata(&path) {
                    if metadata.len() != item.bytes_received {
                        item.bytes_received = metadata.len();
                        changed = true;
                    }
                }
            } else {
                should_stop = true;
            }
        }
        if changed {
            emit_downloads(&app, &downloads);
        }
        if should_stop {
            break;
        }
    });
}

pub(crate) fn download_directory(app: &tauri::AppHandle) -> PathBuf {
    #[cfg(all(debug_assertions, feature = "desktop-test"))]
    if let Some(profile) = std::env::var_os("MY_BROWSER_PROFILE_DIR") {
        return PathBuf::from(profile).join("downloads");
    }
    #[cfg(feature = "macos-session-test")]
    if let Some(path) = std::env::var_os("MY_BROWSER_SESSION_TEST_DOWNLOAD_DIR") {
        return PathBuf::from(path);
    }
    app.path().download_dir().unwrap_or_else(|_| {
        app.path()
            .app_data_dir()
            .unwrap_or_else(|_| std::env::temp_dir())
            .join("Downloads")
    })
}

#[tauri::command]
pub(crate) fn get_downloads(
    webview: tauri::Webview,
    state: tauri::State<'_, BrowserState>,
) -> Result<Vec<DownloadEntry>, String> {
    if !is_trusted_browser_ui(webview.label()) {
        return Err("Downloads are only available to the trusted browser UI".into());
    }
    Ok(state
        .downloads
        .lock()
        .map_err(|_| "Downloads are unavailable")?
        .clone())
}

#[tauri::command]
pub(crate) async fn control_downloads_popover(
    webview: tauri::Webview,
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserState>,
    action: String,
    anchor: SecurityPopoverAnchor,
) -> Result<bool, String> {
    if !is_trusted_browser_ui(webview.label()) {
        return Err("Downloads are only available to the trusted browser UI".into());
    }
    if !matches!(action.as_str(), "show" | "toggle" | "update" | "close")
        || ![anchor.x, anchor.y, anchor.width, anchor.height]
            .iter()
            .all(|v| v.is_finite())
        || anchor.width <= 0.0
        || anchor.height <= 0.0
    {
        return Err("Invalid downloads popover request".into());
    }
    #[cfg(target_os = "macos")]
    {
        use platforms::downloads_popover::{DownloadRow, Reveal, ViewAll};
        let rows = state
            .downloads
            .lock()
            .map_err(|_| "Downloads are unavailable")?
            .iter()
            .take(8)
            .map(|item| DownloadRow {
                id: item.id.clone(),
                filename: item.filename.clone(),
                completed: item.status == DownloadStatus::Completed,
                status: match item.status {
                    DownloadStatus::Completed => "Complete".into(),
                    DownloadStatus::Failed => "Failed".into(),
                    _ => format!("Downloading · {} bytes", item.bytes_received),
                },
            })
            .collect();
        let owner = browser_window_for_ui(webview.label()).to_string();
        let main = app
            .get_webview(&owner)
            .ok_or("Browser window is unavailable")?;
        let inset = titlebar_inset(&main)?;
        let reveal_app = app.clone();
        let reveal: Reveal = Arc::new(move |id| {
            if let Err(error) = reveal_download_file(&reveal_app.state::<BrowserState>(), &id) {
                eprintln!("could not reveal download: {error}");
            }
        });
        let view_all_app = app.clone();
        let view_all_owner = owner.clone();
        let view_all: ViewAll = Arc::new(move || {
            let _ = view_all_app.emit_to(&view_all_owner, SHOW_ALL_DOWNLOADS_EVENT, ());
        });
        let anchor = platforms::security_popover::AnchorRect {
            x: anchor.x,
            y: anchor.y,
            width: anchor.width,
            height: anchor.height,
        };
        let (sender, receiver) = std::sync::mpsc::channel();
        main.with_webview(move |platform| {
            let shown = unsafe {
                platforms::downloads_popover::control(
                    platform.inner(),
                    &owner,
                    &action,
                    anchor,
                    inset,
                    rows,
                    reveal,
                    view_all,
                )
            };
            let _ = sender.send(shown);
        })
        .map_err(|error| error.to_string())?;
        return tauri::async_runtime::spawn_blocking(move || {
            receiver.recv().map_err(|error| error.to_string())
        })
        .await
        .map_err(|error| error.to_string())?;
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, state, action, anchor);
        Err("Native downloads popovers are available on macOS only".into())
    }
}

#[tauri::command]
pub(crate) fn reveal_download(
    webview: tauri::Webview,
    state: tauri::State<'_, BrowserState>,
    download_id: String,
) -> Result<(), String> {
    if !is_trusted_browser_ui(webview.label()) {
        return Err("Downloads are only available to the trusted browser UI".into());
    }
    reveal_download_file(&state, &download_id)
}

pub(crate) fn reveal_download_file(state: &BrowserState, download_id: &str) -> Result<(), String> {
    let path = state
        .downloads
        .lock()
        .map_err(|_| "Downloads are unavailable")?
        .iter()
        .find(|item| item.id == download_id && item.status == DownloadStatus::Completed)
        .map(|item| item.path.clone())
        .ok_or("That completed download is unavailable")?;
    if !path.exists() {
        return Err("The downloaded file no longer exists".into());
    }
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = Command::new("open");
        command.arg("-R").arg(&path);
        command
    };
    #[cfg(target_os = "windows")]
    let mut command = {
        let mut command = Command::new("explorer");
        command.arg(format!("/select,{}", path.display()));
        command
    };
    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    let mut command = {
        let mut command = Command::new("xdg-open");
        command.arg(path.parent().unwrap_or_else(|| std::path::Path::new(".")));
        command
    };
    command.spawn().map_err(|error| error.to_string())?;
    Ok(())
}
