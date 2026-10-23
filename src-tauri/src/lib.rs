mod browser;
use browser::tabs::{
    cycle_active_tab, download_filename, find_script, next_download_path, record_history_entry,
    remember_closed_tab, snapshot, take_recently_closed, update_history_title, BrowserSnapshot,
    BrowserState, DownloadEntry, DownloadStatus, HistoryEntry, PersistedHistory, PersistedSession,
    SessionTab, TabState, ViewBounds,
};
use std::sync::{atomic::Ordering, MutexGuard};
use std::{fs, path::PathBuf, process::Command, thread, time::Duration, time::SystemTime};
use tauri::{Emitter, Manager, WebviewUrl};

#[cfg(all(target_os = "macos", feature = "macos-interception-test"))]
mod platforms;

const TAB_EVENT: &str = "browser://tabs-changed";
const OPEN_SETTINGS_EVENT: &str = "browser://open-settings";
const SHORTCUT_EVENT: &str = "browser://shortcut";
const HISTORY_EVENT: &str = "browser://history-changed";
const DOWNLOADS_EVENT: &str = "browser://downloads-changed";

fn allowed_navigation_url(input: &str) -> Result<url::Url, String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err("Enter a web address or search term".into());
    }
    let has_web_scheme = trimmed.starts_with("http://") || trimmed.starts_with("https://");
    let looks_local = trimmed.starts_with("localhost")
        || trimmed.starts_with("127.0.0.1")
        || trimmed.starts_with("[::1]");
    let parsed = if has_web_scheme {
        url::Url::parse(trimmed)
    } else if trimmed.contains(char::is_whitespace) {
        let query: String = url::form_urlencoded::byte_serialize(trimmed.as_bytes()).collect();
        url::Url::parse(&format!("https://www.google.com/search?q={query}"))
    } else if !trimmed.contains('.') && !looks_local {
        if trimmed.contains(':') {
            return Err("Only HTTP(S) URLs without embedded credentials are allowed".into());
        }
        let query: String = url::form_urlencoded::byte_serialize(trimmed.as_bytes()).collect();
        url::Url::parse(&format!("https://www.google.com/search?q={query}"))
    } else {
        url::Url::parse(&format!(
            "{}://{trimmed}",
            if looks_local { "http" } else { "https" }
        ))
    }
    .map_err(|_| "Enter a valid web address or search term".to_string())?;
    if !matches!(parsed.scheme(), "http" | "https")
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
    {
        return Err("Only HTTP(S) URLs without embedded credentials are allowed".into());
    }
    Ok(parsed)
}

fn page_label(id: &str) -> String {
    format!("page-{id}")
}

fn emit_snapshot(app: &tauri::AppHandle, data: &MutexGuard<'_, Vec<TabState>>) {
    let _ = app.emit_to("main", TAB_EVENT, snapshot(data));
}

fn persist_session(state: &BrowserState) -> Result<(), String> {
    let path = state
        .session_file
        .lock()
        .map_err(|_| "Session path is unavailable")?
        .clone();
    let Some(path) = path else {
        return Ok(());
    };
    let tabs = state
        .data
        .lock()
        .map_err(|_| "Browser state is unavailable")?;
    let recently_closed = state
        .recently_closed
        .lock()
        .map_err(|_| "Browser state is unavailable")?;
    let session = PersistedSession {
        version: 1,
        tabs: tabs.iter().map(SessionTab::from).collect(),
        active_tab_id: tabs
            .iter()
            .find(|tab| tab.active)
            .map(|tab| tab.id.clone())
            .unwrap_or_default(),
        recently_closed: recently_closed.clone(),
    };
    let json = serde_json::to_vec_pretty(&session).map_err(|error| error.to_string())?;
    let parent = path
        .parent()
        .ok_or("Session path has no parent directory")?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let temporary = path.with_extension("json.tmp");
    fs::write(&temporary, json).map_err(|error| error.to_string())?;
    fs::rename(temporary, path).map_err(|error| error.to_string())
}

fn read_session(path: &PathBuf) -> PersistedSession {
    fs::read(path)
        .ok()
        .and_then(|contents| serde_json::from_slice::<PersistedSession>(&contents).ok())
        .filter(|session| session.version == 1)
        .unwrap_or_default()
}

fn persist_history(state: &BrowserState) -> Result<(), String> {
    let path = state
        .history_file
        .lock()
        .map_err(|_| "History path is unavailable")?
        .clone();
    let Some(path) = path else {
        return Ok(());
    };
    let entries = state
        .history
        .lock()
        .map_err(|_| "History is unavailable")?
        .clone();
    let persisted = PersistedHistory {
        version: 1,
        entries,
    };
    let parent = path
        .parent()
        .ok_or("History path has no parent directory")?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let temporary = path.with_extension("json.tmp");
    fs::write(
        &temporary,
        serde_json::to_vec_pretty(&persisted).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    fs::rename(temporary, path).map_err(|error| error.to_string())
}

fn read_history(path: &PathBuf) -> Vec<HistoryEntry> {
    fs::read(path)
        .ok()
        .and_then(|contents| serde_json::from_slice::<PersistedHistory>(&contents).ok())
        .filter(|history| history.version == 1)
        .map(|mut history| {
            history.entries.truncate(500);
            history.entries
        })
        .unwrap_or_default()
}

fn record_history_visit(app: &tauri::AppHandle, state: &BrowserState, url: String, title: String) {
    if let Ok(mut history) = state.history.lock() {
        let visited_at = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .map(|duration| duration.as_secs())
            .unwrap_or_default();
        record_history_entry(
            &mut history,
            HistoryEntry {
                url,
                title,
                visited_at,
            },
        );
        let snapshot = history.clone();
        drop(history);
        let _ = persist_history(state);
        let _ = app.emit_to("main", HISTORY_EVENT, snapshot);
    }
}

fn update_history_entry_title(
    app: &tauri::AppHandle,
    state: &BrowserState,
    url: &str,
    title: &str,
) {
    if let Ok(mut history) = state.history.lock() {
        update_history_title(&mut history, url, title);
        let snapshot = history.clone();
        drop(history);
        let _ = persist_history(state);
        let _ = app.emit_to("main", HISTORY_EVENT, snapshot);
    }
}

fn emit_downloads(
    app: &tauri::AppHandle,
    downloads: &std::sync::Arc<std::sync::Mutex<Vec<DownloadEntry>>>,
) {
    if let Ok(items) = downloads.lock() {
        let _ = app.emit_to("main", DOWNLOADS_EVENT, items.clone());
    }
}

fn monitor_download(
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

fn download_directory(app: &tauri::AppHandle) -> PathBuf {
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

fn open_url_in_new_tab(
    app: &tauri::AppHandle,
    state: &BrowserState,
    input: &str,
) -> Result<(), String> {
    let parsed = allowed_navigation_url(input)?;
    let number = state.next_id.fetch_add(1, Ordering::Relaxed) + 1;
    let id = format!("tab-{number}");
    let bounds = *state
        .bounds
        .lock()
        .map_err(|_| "Browser bounds are unavailable")?;
    create_page_webview(app, state, &id, parsed.clone(), bounds)?;
    let mut tabs = state
        .data
        .lock()
        .map_err(|_| "Browser state is unavailable")?;
    for tab in tabs.iter_mut() {
        tab.active = false;
    }
    tabs.push(TabState::new(id, parsed.to_string(), true));
    emit_snapshot(app, &tabs);
    drop(tabs);
    persist_session(state)?;
    position_tabs(app, state)
}

fn validated_session_tab(tab: SessionTab) -> Option<SessionTab> {
    let url = if tab.url.is_empty() {
        String::new()
    } else {
        allowed_navigation_url(&tab.url).ok()?.to_string()
    };
    Some(SessionTab {
        id: if tab.id.starts_with("tab-")
            && tab.id.len() <= 32
            && tab.id[4..].bytes().all(|byte| byte.is_ascii_digit())
        {
            tab.id
        } else {
            return None;
        },
        url,
        title: if tab.title.trim().is_empty() {
            "New Tab".into()
        } else {
            tab.title.chars().take(512).collect()
        },
        zoom: if tab.zoom.is_finite() {
            tab.zoom.clamp(0.5, 3.0)
        } else {
            1.0
        },
    })
}

#[cfg(feature = "macos-session-test")]
#[tauri::command]
fn session_test_phase(webview: tauri::Webview) -> Result<String, String> {
    if webview.label() != "main" {
        return Err("Session test controls are only available to the trusted browser UI".into());
    }
    std::env::var("MY_BROWSER_SESSION_TEST_PHASE")
        .map_err(|_| "Session test phase is not configured".into())
}

#[cfg(feature = "macos-session-test")]
#[tauri::command]
fn report_session_test(
    webview: tauri::Webview,
    success: bool,
    details: String,
    snapshot: BrowserSnapshot,
) -> Result<(), String> {
    if webview.label() != "main" {
        return Err("Session test controls are only available to the trusted browser UI".into());
    }
    let report_path = std::env::var_os("MY_BROWSER_SESSION_TEST_REPORT")
        .map(PathBuf::from)
        .ok_or("Session test report path is not configured")?;
    let report =
        serde_json::json!({ "success": success, "details": details, "snapshot": snapshot });
    fs::write(
        report_path,
        serde_json::to_vec_pretty(&report).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())
}

#[cfg(feature = "macos-session-test")]
#[tauri::command]
async fn session_test_open_new_tab(
    webview: tauri::Webview,
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserState>,
) -> Result<String, String> {
    if webview.label() != "main" {
        return Err("Session test controls are only available to the trusted browser UI".into());
    }
    let active_id = state
        .data
        .lock()
        .map_err(|_| "Browser state is unavailable")?
        .iter()
        .find(|tab| tab.active)
        .map(|tab| tab.id.clone())
        .ok_or("No active tab")?;
    let page = get_page(&app, &active_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        page.eval("document.getElementById('new-tab-link').click()")
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())??;
    tauri::async_runtime::spawn_blocking(|| thread::sleep(Duration::from_millis(400)))
        .await
        .map_err(|error| error.to_string())?;
    let page = get_page(&app, &active_id)?;
    let (sender, receiver) = std::sync::mpsc::channel();
    page.eval_with_callback(
        "JSON.stringify({hook:window.__MY_BROWSER_LINK_HOOK__===true,tauri:typeof window.__TAURI_INTERNALS__?.invoke,result:window.__MY_BROWSER_LINK_RESULT__||''})",
        move |result| { let _ = sender.send(result); },
    )
    .map_err(|error| error.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        receiver
            .recv_timeout(Duration::from_secs(2))
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(feature = "macos-session-test")]
#[tauri::command]
async fn session_test_start_download(
    webview: tauri::Webview,
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserState>,
) -> Result<(), String> {
    if webview.label() != "main" {
        return Err("Session test controls are only available to the trusted browser UI".into());
    }
    let active_id = state
        .data
        .lock()
        .map_err(|_| "Browser state is unavailable")?
        .iter()
        .find(|tab| tab.active)
        .map(|tab| tab.id.clone())
        .ok_or("No active tab")?;
    let page = get_page(&app, &active_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        page.eval("document.getElementById('download-link').click()")
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
fn open_link_in_new_tab(
    webview: tauri::Webview,
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserState>,
    url: String,
) -> Result<(), String> {
    if !webview.label().starts_with("page-") {
        return Err("Links can only be opened from a browser page".into());
    }
    open_url_in_new_tab(&app, &state, &url)
}

#[tauri::command]
fn sync_page_url(
    webview: tauri::Webview,
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserState>,
    url: String,
    kind: String,
) -> Result<(), String> {
    let label = webview.label();
    let tab_id = label
        .strip_prefix("page-")
        .ok_or("Page URL updates are only available from browser pages")?;
    let current_url = webview.url().map_err(|error| error.to_string())?;
    let parsed_url = allowed_navigation_url(&url)?;
    if parsed_url.origin() != current_url.origin() {
        return Err("Page URL updates must stay on the current origin".into());
    }
    if !matches!(kind.as_str(), "push" | "replace" | "traverse") {
        return Err("Invalid page URL update type".into());
    }

    let mut tabs = state
        .data
        .lock()
        .map_err(|_| "Browser state is unavailable")?;
    let tab = tabs
        .iter_mut()
        .find(|tab| tab.id == tab_id)
        .ok_or("That tab no longer exists")?;
    if tab.url == parsed_url.as_str() {
        return Ok(());
    }
    if kind == "replace" {
        tab.replace_navigation(parsed_url.to_string());
    } else {
        tab.record_navigation(parsed_url.to_string());
    }
    emit_snapshot(&app, &tabs);
    drop(tabs);
    persist_session(&state)
}

fn create_page_webview(
    app: &tauri::AppHandle,
    state: &BrowserState,
    id: &str,
    url: url::Url,
    bounds: ViewBounds,
) -> Result<(), String> {
    let window = app
        .get_window("main")
        .ok_or("Browser window is unavailable")?;
    let state_data = state.data.clone();
    let navigation_tab_id = id.to_string();
    let event_app = app.clone();
    let title_data = state.data.clone();
    let title_app = app.clone();
    let download_app = app.clone();
    let download_items = state.downloads.clone();
    let next_download_id = state.next_download_id.clone();
    let label = page_label(id);
    let builder = tauri::webview::WebviewBuilder::new(label, WebviewUrl::External(url))
        .initialization_script(
            r#"document.addEventListener('click', event => {
              window.__MY_BROWSER_LINK_HOOK__ = true;
              const link = event.target instanceof Element ? event.target.closest('a[target="_blank"][href]') : null;
              if (!link) return;
              event.preventDefault();
              event.stopImmediatePropagation();
              window.__MY_BROWSER_LINK_RESULT__ = 'pending';
              window.__TAURI_INTERNALS__.invoke('open_link_in_new_tab', { url: link.href })
                .then(() => { window.__MY_BROWSER_LINK_RESULT__ = 'opened'; })
                .catch(error => { window.__MY_BROWSER_LINK_RESULT__ = String(error); console.error(error); });
            }, true);"#,
        )
        .initialization_script(
            r#"(() => {
              let lastUrl = window.location.href;
              const syncUrl = kind => {
                const url = window.location.href;
                if (url === lastUrl) return;
                lastUrl = url;
                window.__TAURI_INTERNALS__.invoke('sync_page_url', { url, kind }).catch(error => console.error('Could not sync browser URL', error));
              };
              for (const [method, kind] of [['pushState', 'push'], ['replaceState', 'replace']]) {
                const original = history[method];
                history[method] = function(...args) {
                  const result = Reflect.apply(original, this, args);
                  syncUrl(kind);
                  return result;
                };
              }
              window.addEventListener('popstate', () => syncUrl('traverse'));
              window.addEventListener('hashchange', () => syncUrl('traverse'));
            })();"#,
        )
        .on_navigation({
            let state_data = state_data.clone();
            let navigation_tab_id = navigation_tab_id.clone();
            move |target| {
                if !matches!(target.scheme(), "http" | "https") {
                    return false;
                }
                if let Ok(mut tabs) = state_data.lock() {
                    if let Some(tab) = tabs.iter_mut().find(|tab| tab.id == navigation_tab_id) {
                        tab.loading = true;
                        if tab.url != target.as_str() {
                            tab.url = target.to_string();
                        }
                    }
                }
                true
            }
        })
        .on_page_load(move |webview, payload| {
            if let Ok(mut tabs) = state_data.lock() {
                if let Some(tab) = tabs
                    .iter_mut()
                    .find(|tab| page_label(&tab.id) == webview.label())
                {
                    let is_web_url = matches!(payload.url().scheme(), "http" | "https");
                    tab.loading = is_web_url
                        && matches!(payload.event(), tauri::webview::PageLoadEvent::Started);
                    if is_web_url {
                        tab.url = payload.url().to_string();
                        if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
                            tab.record_navigation(payload.url().to_string());
                        }
                    }
                    let history_visit = if is_web_url
                        && matches!(payload.event(), tauri::webview::PageLoadEvent::Finished)
                    {
                        Some((tab.url.clone(), tab.title.clone()))
                    } else {
                        None
                    };
                    emit_snapshot(&event_app, &tabs);
                    drop(tabs);
                    let _ = persist_session(&event_app.state::<BrowserState>());
                    if let Some((url, title)) = history_visit {
                        record_history_visit(
                            &event_app,
                            &event_app.state::<BrowserState>(),
                            url,
                            title,
                        );
                    }
                }
            }
        })
        .on_document_title_changed(move |webview, title| {
            if let Ok(mut tabs) = title_data.lock() {
                if let Some(tab) = tabs
                    .iter_mut()
                    .find(|tab| page_label(&tab.id) == webview.label())
                {
                    tab.title = if title.trim().is_empty() {
                        "New Tab".into()
                    } else {
                        title.clone()
                    };
                    let history_url = tab.url.clone();
                    emit_snapshot(&title_app, &tabs);
                    drop(tabs);
                    let _ = persist_session(&title_app.state::<BrowserState>());
                    update_history_entry_title(
                        &title_app,
                        &title_app.state::<BrowserState>(),
                        &history_url,
                        &title,
                    );
                }
            }
        })
        .on_new_window(|_url, _features| tauri::webview::NewWindowResponse::Deny)
        .on_download(move |_webview, event| match event {
            tauri::webview::DownloadEvent::Requested { url, destination } => {
                let directory = download_directory(&download_app);
                if fs::create_dir_all(&directory).is_err() {
                    return false;
                }
                let filename = download_filename(url.as_str());
                let Ok(mut items) = download_items.lock() else {
                    return false;
                };
                let in_use: Vec<PathBuf> = items.iter().map(|item| item.path.clone()).collect();
                let path = next_download_path(&directory, &filename, &in_use);
                let number = next_download_id.fetch_add(1, Ordering::Relaxed) + 1;
                let id = format!("download-{number}");
                *destination = path.clone();
                items.insert(
                    0,
                    DownloadEntry {
                        id: id.clone(),
                        url: url.to_string(),
                        filename,
                        path: path.clone(),
                        status: DownloadStatus::Downloading,
                        bytes_received: 0,
                    },
                );
                drop(items);
                emit_downloads(&download_app, &download_items);
                monitor_download(download_app.clone(), download_items.clone(), id, path);
                true
            }
            tauri::webview::DownloadEvent::Finished { url, path, success } => {
                if let Ok(mut items) = download_items.lock() {
                    if let Some(item) = items.iter_mut().find(|item| {
                        item.url == url.as_str() && item.status == DownloadStatus::Downloading
                    }) {
                        if let Some(saved_path) = path {
                            item.path = saved_path;
                        }
                        item.status = if success {
                            DownloadStatus::Completed
                        } else {
                            DownloadStatus::Failed
                        };
                        item.bytes_received = fs::metadata(&item.path)
                            .map(|metadata| metadata.len())
                            .unwrap_or(item.bytes_received);
                    }
                }
                emit_downloads(&download_app, &download_items);
                true
            }
            _ => true,
        });
    window
        .add_child(
            builder,
            tauri::LogicalPosition::new(bounds.x, bounds.y),
            tauri::LogicalSize::new(bounds.width.max(1.0), bounds.height.max(1.0)),
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
fn get_browser_state(
    webview: tauri::Webview,
    state: tauri::State<'_, BrowserState>,
) -> Result<BrowserSnapshot, String> {
    if webview.label() != "main" {
        return Err("Browser state is only available to the trusted UI".into());
    }
    let tabs = state
        .data
        .lock()
        .map_err(|_| "Browser state is unavailable")?;
    Ok(snapshot(&tabs))
}

#[tauri::command]
fn get_history(
    webview: tauri::Webview,
    state: tauri::State<'_, BrowserState>,
) -> Result<Vec<HistoryEntry>, String> {
    if webview.label() != "main" {
        return Err("History is only available to the trusted browser UI".into());
    }
    Ok(state
        .history
        .lock()
        .map_err(|_| "History is unavailable")?
        .clone())
}

#[tauri::command]
fn get_downloads(
    webview: tauri::Webview,
    state: tauri::State<'_, BrowserState>,
) -> Result<Vec<DownloadEntry>, String> {
    if webview.label() != "main" {
        return Err("Downloads are only available to the trusted browser UI".into());
    }
    Ok(state
        .downloads
        .lock()
        .map_err(|_| "Downloads are unavailable")?
        .clone())
}

#[tauri::command]
async fn find_in_page(
    webview: tauri::Webview,
    app: tauri::AppHandle,
    tab_id: String,
    query: String,
    backwards: bool,
) -> Result<bool, String> {
    if webview.label() != "main" {
        return Err("Find is only available to the trusted browser UI".into());
    }
    let page = get_page(&app, &tab_id)?;
    let (sender, receiver) = std::sync::mpsc::channel();
    page.eval_with_callback(find_script(&query, backwards), move |result| {
        let _ = sender.send(result);
    })
    .map_err(|error| error.to_string())?;
    let result = tauri::async_runtime::spawn_blocking(move || {
        receiver.recv().map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())??;
    serde_json::from_str(&result).map_err(|error| error.to_string())
}

#[tauri::command]
fn cycle_tab(
    webview: tauri::Webview,
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserState>,
    backwards: bool,
) -> Result<BrowserSnapshot, String> {
    if webview.label() != "main" {
        return Err("Tabs can only be cycled from the trusted browser UI".into());
    }
    let mut tabs = state
        .data
        .lock()
        .map_err(|_| "Browser state is unavailable")?;
    cycle_active_tab(&mut tabs, if backwards { -1 } else { 1 });
    emit_snapshot(&app, &tabs);
    drop(tabs);
    persist_session(&state)?;
    position_tabs(&app, &state)?;
    let tabs = state
        .data
        .lock()
        .map_err(|_| "Browser state is unavailable")?;
    Ok(snapshot(&tabs))
}

#[tauri::command]
fn reveal_download(
    webview: tauri::Webview,
    state: tauri::State<'_, BrowserState>,
    download_id: String,
) -> Result<(), String> {
    if webview.label() != "main" {
        return Err("Downloads are only available to the trusted browser UI".into());
    }
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

#[tauri::command]
fn create_tab(
    webview: tauri::Webview,
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserState>,
) -> Result<BrowserSnapshot, String> {
    if webview.label() != "main" {
        return Err("Tabs can only be created from the trusted browser UI".into());
    }
    let number = state.next_id.fetch_add(1, Ordering::Relaxed) + 1;
    let id = format!("tab-{number}");
    let bounds = *state
        .bounds
        .lock()
        .map_err(|_| "Browser bounds are unavailable")?;
    let blank = url::Url::parse("about:blank").unwrap();
    create_page_webview(&app, &state, &id, blank, bounds)?;
    let mut tabs = state
        .data
        .lock()
        .map_err(|_| "Browser state is unavailable")?;
    for tab in tabs.iter_mut() {
        tab.active = false;
    }
    tabs.push(TabState::new(id, String::new(), true));
    emit_snapshot(&app, &tabs);
    drop(tabs);
    persist_session(&state)?;
    position_tabs(&app, &state)?;
    Ok(snapshot(
        &state
            .data
            .lock()
            .map_err(|_| "Browser state is unavailable")?,
    ))
}

#[tauri::command]
fn select_tab(
    webview: tauri::Webview,
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserState>,
    tab_id: String,
) -> Result<BrowserSnapshot, String> {
    if webview.label() != "main" {
        return Err("Tabs can only be selected from the trusted browser UI".into());
    }
    let mut tabs = state
        .data
        .lock()
        .map_err(|_| "Browser state is unavailable")?;
    if !tabs.iter().any(|tab| tab.id == tab_id) {
        return Err("That tab no longer exists".into());
    }
    for tab in tabs.iter_mut() {
        tab.active = tab.id == tab_id;
    }
    emit_snapshot(&app, &tabs);
    drop(tabs);
    persist_session(&state)?;
    position_tabs(&app, &state)?;
    Ok(snapshot(
        &state
            .data
            .lock()
            .map_err(|_| "Browser state is unavailable")?,
    ))
}

#[tauri::command]
fn close_tab(
    webview: tauri::Webview,
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserState>,
    tab_id: String,
) -> Result<BrowserSnapshot, String> {
    if webview.label() != "main" {
        return Err("Tabs can only be closed from the trusted browser UI".into());
    }
    let closing_was_active;
    {
        let mut tabs = state
            .data
            .lock()
            .map_err(|_| "Browser state is unavailable")?;
        let index = tabs
            .iter()
            .position(|tab| tab.id == tab_id)
            .ok_or("That tab no longer exists")?;
        closing_was_active = tabs[index].active;
        let closed = SessionTab::from(&tabs[index]);
        let mut recently_closed = state
            .recently_closed
            .lock()
            .map_err(|_| "Browser state is unavailable")?;
        remember_closed_tab(&mut recently_closed, closed);
        tabs.remove(index);
        if closing_was_active && !tabs.is_empty() {
            let new_active_index = index.min(tabs.len() - 1);
            tabs[new_active_index].active = true;
        }
    }
    if let Some(page) = app.get_webview(&page_label(&tab_id)) {
        let _ = page.close();
    }
    if state
        .data
        .lock()
        .map_err(|_| "Browser state is unavailable")?
        .is_empty()
    {
        return create_tab(webview, app, state);
    }
    persist_session(&state)?;
    position_tabs(&app, &state)?;
    let tabs = state
        .data
        .lock()
        .map_err(|_| "Browser state is unavailable")?;
    emit_snapshot(&app, &tabs);
    Ok(snapshot(&tabs))
}

#[tauri::command]
fn reopen_closed_tab(
    webview: tauri::Webview,
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserState>,
) -> Result<BrowserSnapshot, String> {
    if webview.label() != "main" {
        return Err("Tabs can only be reopened from the trusted browser UI".into());
    }
    let restored = state
        .recently_closed
        .lock()
        .map_err(|_| "Browser state is unavailable")?
        .first()
        .cloned()
        .ok_or("There are no recently closed tabs")?;
    let url = if restored.url.is_empty() {
        url::Url::parse("about:blank").unwrap()
    } else {
        allowed_navigation_url(&restored.url)?
    };
    let bounds = *state
        .bounds
        .lock()
        .map_err(|_| "Browser bounds are unavailable")?;
    let number = state.next_id.fetch_add(1, Ordering::Relaxed) + 1;
    let id = format!("tab-{number}");
    create_page_webview(&app, &state, &id, url, bounds)?;
    {
        let mut tabs = state
            .data
            .lock()
            .map_err(|_| "Browser state is unavailable")?;
        for tab in tabs.iter_mut() {
            tab.active = false;
        }
        let mut tab = TabState::new(id, restored.url, true);
        tab.title = restored.title;
        tab.zoom = restored.zoom;
        tabs.push(tab);
    }
    let mut recently_closed = state
        .recently_closed
        .lock()
        .map_err(|_| "Browser state is unavailable")?;
    take_recently_closed(&mut recently_closed);
    drop(recently_closed);
    if let Some(page) = app.get_webview(&page_label(&format!("tab-{number}"))) {
        page.set_zoom(restored.zoom)
            .map_err(|error| error.to_string())?;
    }
    position_tabs(&app, &state)?;
    persist_session(&state)?;
    let tabs = state
        .data
        .lock()
        .map_err(|_| "Browser state is unavailable")?;
    emit_snapshot(&app, &tabs);
    Ok(snapshot(&tabs))
}

fn get_page(app: &tauri::AppHandle, tab_id: &str) -> Result<tauri::Webview, String> {
    app.get_webview(&page_label(tab_id))
        .ok_or_else(|| "Website view is unavailable".into())
}

#[tauri::command]
fn navigate(
    webview: tauri::Webview,
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserState>,
    tab_id: String,
    url: String,
) -> Result<(), String> {
    if webview.label() != "main" {
        return Err("Navigation is only available from the trusted browser UI".into());
    }
    let parsed = allowed_navigation_url(&url)?;
    let page = get_page(&app, &tab_id)?;
    {
        let mut tabs = state
            .data
            .lock()
            .map_err(|_| "Browser state is unavailable")?;
        let tab = tabs
            .iter_mut()
            .find(|tab| tab.id == tab_id)
            .ok_or("That tab no longer exists")?;
        tab.url = parsed.to_string();
        tab.loading = true;
        emit_snapshot(&app, &tabs);
    }
    persist_session(&state)?;
    position_tabs(&app, &state)?;
    page.navigate(parsed).map_err(|e| e.to_string())
}

#[tauri::command]
fn go_back(
    webview: tauri::Webview,
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserState>,
    tab_id: String,
) -> Result<(), String> {
    if webview.label() != "main" {
        return Err("Navigation is only available from the trusted browser UI".into());
    }
    let page = get_page(&app, &tab_id)?;
    let mut tabs = state
        .data
        .lock()
        .map_err(|_| "Browser state is unavailable")?;
    let tab = tabs
        .iter_mut()
        .find(|tab| tab.id == tab_id)
        .ok_or("That tab no longer exists")?;
    if tab.move_history(false).is_some() {
        page.eval("history.back()").map_err(|e| e.to_string())?;
    }
    emit_snapshot(&app, &tabs);
    drop(tabs);
    persist_session(&state)?;
    Ok(())
}

#[tauri::command]
fn go_forward(
    webview: tauri::Webview,
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserState>,
    tab_id: String,
) -> Result<(), String> {
    if webview.label() != "main" {
        return Err("Navigation is only available from the trusted browser UI".into());
    }
    let page = get_page(&app, &tab_id)?;
    let mut tabs = state
        .data
        .lock()
        .map_err(|_| "Browser state is unavailable")?;
    let tab = tabs
        .iter_mut()
        .find(|tab| tab.id == tab_id)
        .ok_or("That tab no longer exists")?;
    if tab.move_history(true).is_some() {
        page.eval("history.forward()").map_err(|e| e.to_string())?;
    }
    emit_snapshot(&app, &tabs);
    drop(tabs);
    persist_session(&state)?;
    Ok(())
}

#[tauri::command]
fn reload(webview: tauri::Webview, app: tauri::AppHandle, tab_id: String) -> Result<(), String> {
    if webview.label() != "main" {
        return Err("Navigation is only available from the trusted browser UI".into());
    }
    get_page(&app, &tab_id)?.reload().map_err(|e| e.to_string())
}

#[tauri::command]
fn stop_loading(
    webview: tauri::Webview,
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserState>,
    tab_id: String,
) -> Result<(), String> {
    if webview.label() != "main" {
        return Err("Navigation is only available from the trusted browser UI".into());
    }
    get_page(&app, &tab_id)?
        .eval("window.stop()")
        .map_err(|e| e.to_string())?;
    let mut tabs = state
        .data
        .lock()
        .map_err(|_| "Browser state is unavailable")?;
    if let Some(tab) = tabs.iter_mut().find(|tab| tab.id == tab_id) {
        tab.loading = false;
    }
    emit_snapshot(&app, &tabs);
    drop(tabs);
    persist_session(&state)?;
    Ok(())
}

#[tauri::command]
fn set_view_bounds(
    webview: tauri::Webview,
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserState>,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    if webview.label() != "main" {
        return Err("View bounds are only available to the trusted browser UI".into());
    }
    if ![x, y, width, height].iter().all(|value| value.is_finite()) || width < 1.0 || height < 1.0 {
        return Err("Invalid website view bounds".into());
    }
    #[cfg(target_os = "macos")]
    let bounds = ViewBounds {
        x,
        // Child WebViews use the window content origin, offset from the main
        // WebView's CSS viewport on macOS by the native titlebar inset.
        y: y + 20.0,
        width,
        height: (height - 20.0).max(1.0),
    };
    #[cfg(not(target_os = "macos"))]
    let bounds = ViewBounds {
        x,
        y,
        width,
        height,
    };
    *state
        .bounds
        .lock()
        .map_err(|_| "Browser bounds are unavailable")? = bounds;
    position_tabs(&app, &state)
}

#[tauri::command]
fn set_settings_open(
    webview: tauri::Webview,
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserState>,
    open: bool,
) -> Result<(), String> {
    if webview.label() != "main" {
        return Err("Settings are only available to the trusted browser UI".into());
    }
    *state
        .settings_open
        .lock()
        .map_err(|_| "Browser state unavailable")? = open;
    position_tabs(&app, &state)
}

fn adjust_active_zoom(
    app: &tauri::AppHandle,
    state: &BrowserState,
    action: &str,
) -> Result<(), String> {
    let mut tabs = state.data.lock().map_err(|_| "Browser state unavailable")?;
    let tab = tabs
        .iter_mut()
        .find(|tab| tab.active)
        .ok_or("No active tab")?;
    tab.zoom = match action {
        "zoom-in" => (tab.zoom + 0.1).min(3.0),
        "zoom-out" => (tab.zoom - 0.1).max(0.5),
        _ => 1.0,
    };
    if let Some(page) = app.get_webview(&page_label(&tab.id)) {
        page.set_zoom(tab.zoom).map_err(|e| e.to_string())?;
    }
    drop(tabs);
    let _ = persist_session(state);
    Ok(())
}

fn position_tabs(app: &tauri::AppHandle, state: &BrowserState) -> Result<(), String> {
    let bounds = *state
        .bounds
        .lock()
        .map_err(|_| "Browser bounds are unavailable")?;
    let tabs = state
        .data
        .lock()
        .map_err(|_| "Browser state is unavailable")?;
    for tab in tabs.iter() {
        if let Some(page) = app.get_webview(&page_label(&tab.id)) {
            let settings_open = *state
                .settings_open
                .lock()
                .map_err(|_| "Browser state unavailable")?;
            let is_visible = !settings_open && tab.active && !tab.url.is_empty();
            let position = if is_visible {
                tauri::LogicalPosition::new(bounds.x, bounds.y)
            } else {
                tauri::LogicalPosition::new(20000.0, 20000.0)
            };
            page.set_position(position).map_err(|e| e.to_string())?;
            if is_visible {
                page.set_size(tauri::LogicalSize::new(bounds.width, bounds.height))
                    .map_err(|e| e.to_string())?;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{allowed_navigation_url, persist_session, read_session, validated_session_tab};
    use crate::browser::tabs::{BrowserState, SessionTab, TabState};
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static TEMP_SESSION_ID: AtomicU64 = AtomicU64::new(0);

    fn temporary_session_path() -> std::path::PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir()
            .join(format!(
                "my-browser-session-test-{}-{unique}-{}",
                std::process::id(),
                TEMP_SESSION_ID.fetch_add(1, Ordering::Relaxed)
            ))
            .join("session.json")
    }

    #[test]
    fn navigation_accepts_http_and_https() {
        assert!(allowed_navigation_url("http://example.com/").is_ok());
        assert!(allowed_navigation_url("https://example.com/path").is_ok());
    }

    #[test]
    fn navigation_rejects_privileged_schemes_and_credentials() {
        assert!(allowed_navigation_url("javascript:alert(1)").is_err());
        assert!(allowed_navigation_url("file:///etc/passwd").is_err());
        assert!(allowed_navigation_url("https://user:pass@example.com/").is_err());
    }

    #[test]
    fn session_persistence_round_trips_tab_order_selection_and_recently_closed() {
        let path = temporary_session_path();
        let state = BrowserState::default();
        *state.session_file.lock().unwrap() = Some(path.clone());

        let mut first = TabState::new("tab-1".into(), "https://example.com/first".into(), false);
        first.title = "First page".into();
        let mut second = TabState::new("tab-2".into(), "https://example.com/second".into(), true);
        second.title = "Second page".into();
        second.zoom = 1.4;
        *state.data.lock().unwrap() = vec![first, second];
        *state.recently_closed.lock().unwrap() = vec![SessionTab {
            id: "tab-3".into(),
            url: "https://example.com/closed".into(),
            title: "Closed page".into(),
            zoom: 1.2,
        }];

        persist_session(&state).unwrap();
        let restored = read_session(&path);

        assert_eq!(restored.version, 1);
        assert_eq!(restored.tabs.len(), 2);
        assert_eq!(restored.tabs[0].url, "https://example.com/first");
        assert_eq!(restored.tabs[1].title, "Second page");
        assert_eq!(restored.tabs[1].zoom, 1.4);
        assert_eq!(restored.active_tab_id, "tab-2");
        assert_eq!(restored.recently_closed[0].id, "tab-3");
        assert_eq!(
            restored.recently_closed[0].url,
            "https://example.com/closed"
        );

        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn session_restore_rejects_invalid_urls_and_tab_ids() {
        let invalid_url = SessionTab {
            id: "tab-1".into(),
            url: "javascript:alert(1)".into(),
            title: "Bad URL".into(),
            zoom: 1.0,
        };
        let invalid_id = SessionTab {
            id: "page-1".into(),
            url: "https://example.com/".into(),
            title: "Bad ID".into(),
            zoom: 1.0,
        };

        assert!(validated_session_tab(invalid_url).is_none());
        assert!(validated_session_tab(invalid_id).is_none());
    }

    #[test]
    fn session_restore_ignores_unsupported_file_versions() {
        let path = temporary_session_path();
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(
            &path,
            r#"{"version":2,"tabs":[],"activeTabId":"","recentlyClosed":[]}"#,
        )
        .unwrap();

        let restored = read_session(&path);

        assert_eq!(restored.version, 1);
        assert!(restored.tabs.is_empty());
        assert!(restored.recently_closed.is_empty());
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .manage(BrowserState::default())
        .setup(|app| {
            let state = app.state::<BrowserState>();
            let session_path = app.path().app_data_dir()?.join("session.json");
            #[cfg(feature = "macos-session-test")]
            let session_path = std::env::var_os("MY_BROWSER_SESSION_TEST_PATH")
                .map(PathBuf::from)
                .unwrap_or(session_path);
            *state
                .session_file
                .lock()
                .expect("session path lock poisoned") = Some(session_path.clone());
            let history_path = session_path.with_file_name("history.json");
            *state
                .history_file
                .lock()
                .expect("history path lock poisoned") = Some(history_path.clone());
            *state.history.lock().expect("history lock poisoned") = read_history(&history_path);
            let saved_session = read_session(&session_path);
            *state
                .recently_closed
                .lock()
                .expect("recently closed lock poisoned") = saved_session
                .recently_closed
                .into_iter()
                .filter_map(validated_session_tab)
                .take(20)
                .collect();
            let bounds = *state.bounds.lock().expect("browser bounds lock poisoned");
            #[cfg(target_os = "macos")]
            {
                use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};
                let settings = MenuItemBuilder::with_id("open-settings", "Settings…")
                    .accelerator("CmdOrCtrl+,")
                    .build(app)?;
                let app_menu = SubmenuBuilder::new(app, "My Browser")
                    .item(&settings)
                    .separator()
                    .hide()
                    .hide_others()
                    .separator()
                    .quit()
                    .build()?;
                let new_tab = MenuItemBuilder::with_id("shortcut-new-tab", "New Tab")
                    .accelerator("CmdOrCtrl+T")
                    .build(app)?;
                let close_tab = MenuItemBuilder::with_id("shortcut-close-tab", "Close Tab")
                    .accelerator("CmdOrCtrl+W")
                    .build(app)?;
                let reopen_closed_tab =
                    MenuItemBuilder::with_id("shortcut-reopen-closed-tab", "Reopen Closed Tab")
                        .accelerator("CmdOrCtrl+Shift+T")
                        .build(app)?;
                let next_tab = MenuItemBuilder::with_id("shortcut-next-tab", "Next Tab")
                    .accelerator("Ctrl+Tab")
                    .build(app)?;
                let previous_tab =
                    MenuItemBuilder::with_id("shortcut-previous-tab", "Previous Tab")
                        .accelerator("Ctrl+Shift+Tab")
                        .build(app)?;
                let file_menu = SubmenuBuilder::new(app, "File")
                    .item(&new_tab)
                    .item(&close_tab)
                    .item(&reopen_closed_tab)
                    .item(&next_tab)
                    .item(&previous_tab)
                    .build()?;
                let edit_menu = SubmenuBuilder::new(app, "Edit")
                    .undo()
                    .redo()
                    .separator()
                    .cut()
                    .copy()
                    .paste()
                    .separator()
                    .select_all()
                    .build()?;
                let zoom_in = MenuItemBuilder::with_id("zoom-in", "Zoom In")
                    .accelerator("CmdOrCtrl+Shift+=")
                    .build(app)?;
                let zoom_out = MenuItemBuilder::with_id("zoom-out", "Zoom Out")
                    .accelerator("CmdOrCtrl+-")
                    .build(app)?;
                let actual_size = MenuItemBuilder::with_id("zoom-reset", "Actual Size")
                    .accelerator("CmdOrCtrl+0")
                    .build(app)?;
                let focus_address =
                    MenuItemBuilder::with_id("shortcut-focus-address", "Focus Address Bar")
                        .accelerator("CmdOrCtrl+L")
                        .build(app)?;
                let find = MenuItemBuilder::with_id("shortcut-find", "Find in Page")
                    .accelerator("CmdOrCtrl+F")
                    .build(app)?;
                let reload = MenuItemBuilder::with_id("shortcut-reload", "Reload Page")
                    .accelerator("CmdOrCtrl+R")
                    .build(app)?;
                let go_back = MenuItemBuilder::with_id("shortcut-go-back", "Back")
                    .accelerator("CmdOrCtrl+Alt+Left")
                    .build(app)?;
                let go_forward = MenuItemBuilder::with_id("shortcut-go-forward", "Forward")
                    .accelerator("CmdOrCtrl+Alt+Right")
                    .build(app)?;
                let view_menu = SubmenuBuilder::new(app, "View")
                    .item(&focus_address)
                    .item(&find)
                    .item(&reload)
                    .item(&go_back)
                    .item(&go_forward)
                    .separator()
                    .item(&zoom_in)
                    .item(&zoom_out)
                    .separator()
                    .item(&actual_size)
                    .build()?;
                let menu = MenuBuilder::new(app)
                    .item(&app_menu)
                    .item(&file_menu)
                    .item(&edit_menu)
                    .item(&view_menu)
                    .build()?;
                app.set_menu(menu)?;
            }
            #[cfg(all(target_os = "macos", feature = "macos-interception-test"))]
            {
                let window = app.get_window("main").expect("main window configured");
                let start = url::Url::parse("about:blank").unwrap();
                window.add_child(
                    tauri::webview::WebviewBuilder::new("page", WebviewUrl::External(start)),
                    tauri::LogicalPosition::new(bounds.x, bounds.y),
                    tauri::LogicalSize::new(bounds.width, bounds.height),
                )?;
                platforms::macos::install_interception_test(app.handle().clone())?;
            }
            #[cfg(not(all(target_os = "macos", feature = "macos-interception-test")))]
            {
                let mut restored_tabs = Vec::new();
                let mut seen_ids = std::collections::HashSet::new();
                for saved in saved_session
                    .tabs
                    .into_iter()
                    .filter_map(validated_session_tab)
                {
                    if !seen_ids.insert(saved.id.clone()) {
                        continue;
                    }
                    let parsed = if saved.url.is_empty() {
                        url::Url::parse("about:blank").unwrap()
                    } else {
                        allowed_navigation_url(&saved.url).unwrap()
                    };
                    create_page_webview(app.handle(), &state, &saved.id, parsed, bounds)
                        .map_err(std::io::Error::other)?;
                    if let Some(page) = app.get_webview(&page_label(&saved.id)) {
                        page.set_zoom(saved.zoom).map_err(std::io::Error::other)?;
                    }
                    let mut tab = TabState::new(
                        saved.id.clone(),
                        saved.url,
                        saved.id == saved_session.active_tab_id,
                    );
                    tab.title = saved.title;
                    tab.zoom = saved.zoom;
                    restored_tabs.push(tab);
                    if let Some(number) = saved
                        .id
                        .strip_prefix("tab-")
                        .and_then(|value| value.parse::<u64>().ok())
                    {
                        state.next_id.fetch_max(number, Ordering::Relaxed);
                    }
                }
                if restored_tabs.is_empty() {
                    let number = state.next_id.fetch_add(1, Ordering::Relaxed) + 1;
                    let id = format!("tab-{number}");
                    create_page_webview(
                        app.handle(),
                        &state,
                        &id,
                        url::Url::parse("about:blank").unwrap(),
                        bounds,
                    )
                    .map_err(std::io::Error::other)?;
                    restored_tabs.push(TabState::new(id, String::new(), true));
                } else if !restored_tabs.iter().any(|tab| tab.active) {
                    restored_tabs[0].active = true;
                }
                *state.data.lock().expect("browser state lock poisoned") = restored_tabs;
                position_tabs(app.handle(), &state).map_err(std::io::Error::other)?;
                persist_session(&state).map_err(std::io::Error::other)?;
            }
            Ok(())
        });
    #[cfg(feature = "macos-session-test")]
    let builder = builder.invoke_handler(tauri::generate_handler![
        get_browser_state,
        get_history,
        get_downloads,
        find_in_page,
        cycle_tab,
        reveal_download,
        open_link_in_new_tab,
        sync_page_url,
        create_tab,
        select_tab,
        close_tab,
        navigate,
        go_back,
        go_forward,
        reload,
        stop_loading,
        set_settings_open,
        set_view_bounds,
        reopen_closed_tab,
        session_test_phase,
        report_session_test,
        session_test_open_new_tab,
        session_test_start_download
    ]);
    #[cfg(not(feature = "macos-session-test"))]
    let builder = builder.invoke_handler(tauri::generate_handler![
        get_browser_state,
        get_history,
        get_downloads,
        find_in_page,
        cycle_tab,
        reveal_download,
        open_link_in_new_tab,
        sync_page_url,
        create_tab,
        select_tab,
        close_tab,
        navigate,
        go_back,
        go_forward,
        reload,
        stop_loading,
        set_settings_open,
        set_view_bounds,
        reopen_closed_tab
    ]);
    builder
        .on_menu_event(|app, event| {
            if event.id().as_ref() == "open-settings" {
                let _ = app.emit_to("main", OPEN_SETTINGS_EVENT, ());
            }
            let id = event.id().as_ref();
            if id.starts_with("shortcut-") {
                let _ = app.emit_to("main", SHORTCUT_EVENT, id.trim_start_matches("shortcut-"));
            }
            if let Some(action) = ["zoom-in", "zoom-out", "zoom-reset"]
                .iter()
                .find(|id| event.id().as_ref() == **id)
            {
                if let Some(state) = app.try_state::<BrowserState>() {
                    let _ = adjust_active_zoom(app, &state, action);
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running browser");
}
