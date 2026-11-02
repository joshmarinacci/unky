mod browser;
#[cfg(all(feature = "desktop-test", not(debug_assertions)))]
compile_error!("desktop-test is only supported in debug builds");
use browser::filtering::{FilterSettings, FilterSettingsView};
use browser::tabs::{
    cycle_active_tab, download_filename, find_script, next_download_path, record_history_entry,
    remember_closed_tab, snapshot, take_recently_closed, update_history_title, BrowserSnapshot,
    BrowserState, DownloadEntry, DownloadStatus, HistoryEntry, PersistedHistory, PersistedSession,
    SessionTab, SplitLayout, SplitOrientation, TabState, ViewBounds,
};
use std::sync::{atomic::Ordering, Arc, Mutex, MutexGuard};
use std::{
    collections::HashSet, fs, path::PathBuf, process::Command, thread, time::Duration,
    time::SystemTime,
};
use tauri::{Emitter, Manager, WebviewUrl};

mod platforms;

const TAB_EVENT: &str = "browser://tabs-changed";
const SPLIT_EVENT: &str = "browser://split-changed";
const SPLIT_RESIZE_EVENT: &str = "browser://split-resize";
const OPEN_SETTINGS_EVENT: &str = "browser://open-settings";
const SHOW_HISTORY_EVENT: &str = "browser://show-history";
const SHOW_DOWNLOADS_EVENT: &str = "browser://show-downloads";
const SHORTCUT_EVENT: &str = "browser://shortcut";
const HISTORY_EVENT: &str = "browser://history-changed";
const DOWNLOADS_EVENT: &str = "browser://downloads-changed";
const FILTER_UPDATE_PROGRESS_EVENT: &str = "browser://filter-update-progress";
const LAUNCH_REQUEST_EVENT: &str = "browser://launch-request";

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct FilterUpdateProgress {
    phase: &'static str,
    received_bytes: u64,
    total_bytes: Option<u64>,
}

fn emit_filter_update_progress(app: &tauri::AppHandle, progress: FilterUpdateProgress) {
    let _ = app.emit(FILTER_UPDATE_PROGRESS_EVENT, progress);
}

fn parse_launch_args(
    args: impl IntoIterator<Item = String>,
) -> Result<Option<browser::launch::LaunchRequest>, String> {
    browser::launch::parse_args(args)?
        .map(|mut request| {
            request.url = allowed_navigation_url(&request.url)?.to_string();
            Ok(request)
        })
        .transpose()
}

#[tauri::command]
fn take_launch_request(
    webview: tauri::Webview,
    state: tauri::State<'_, BrowserState>,
) -> Result<Option<browser::launch::LaunchRequest>, String> {
    if !is_trusted_browser_ui(webview.label()) {
        return Err("Launch arguments are only available to the trusted browser UI".into());
    }
    state
        .launch_request
        .lock()
        .map_err(|_| "Launch request is unavailable".to_string())
        .map(|mut request| request.take())
}

#[tauri::command]
fn get_external_browsers(
    webview: tauri::Webview,
    app: tauri::AppHandle,
) -> Result<Vec<browser::external::ExternalBrowser>, String> {
    if !is_trusted_browser_ui(webview.label()) {
        return Err("Browser discovery is only available to the trusted browser UI".into());
    }
    browser::external::installed_browsers(&app.config().identifier)
}

#[tauri::command]
async fn open_in_external_browser(
    webview: tauri::Webview,
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserState>,
    tab_id: String,
    browser_id: String,
) -> Result<(), String> {
    if !is_trusted_browser_ui(webview.label()) {
        return Err("Only the trusted browser UI can open another browser".into());
    }
    {
        let tabs = state
            .data
            .lock()
            .map_err(|_| "Browser state is unavailable")?;
        if !tabs.iter().any(|tab| {
            tab.id == tab_id && tab.window_label == browser_window_for_ui(webview.label())
        }) {
            return Err("The requested tab does not belong to this browser window".into());
        }
    }
    // Read the actual WebView location, not editable address-bar text or a caller-supplied URL.
    let url = browser::external::current_page_url(&get_page(&app, &tab_id)?).await?;
    let browser = browser::external::installed_browsers(&app.config().identifier)?
        .into_iter()
        .find(|browser| browser.id == browser_id)
        .ok_or("That browser is no longer available; reopen the browser picker")?;

    // Automated tests exercise discovery and validation without opening tabs in the user's browsers.
    #[cfg(all(debug_assertions, feature = "desktop-test"))]
    if std::env::var("MY_BROWSER_TEST_EXTERNAL_OPEN").as_deref() == Ok("1") {
        let profile =
            std::env::var_os("MY_BROWSER_PROFILE_DIR").ok_or("Test profile is unavailable")?;
        let request =
            serde_json::json!({ "browserId": browser.id, "url": url.as_str(), "tabId": tab_id });
        fs::write(
            PathBuf::from(profile).join("external-open.json"),
            request.to_string(),
        )
        .map_err(|error| error.to_string())?;
        return Ok(());
    }

    tauri::async_runtime::spawn_blocking(move || browser::external::open(&browser, &url))
        .await
        .map_err(|error| error.to_string())?
}

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

fn is_trusted_browser_ui(label: &str) -> bool {
    label == "main"
        || label.starts_with("browser-window-")
        || (cfg!(all(debug_assertions, feature = "desktop-test")) && label == "wdio-host")
}

fn focused_browser_window_label(app: &tauri::AppHandle) -> Option<String> {
    app.windows().into_iter().find_map(|(label, window)| {
        let is_browser_window = label == "main" || label.starts_with("browser-window-");
        (is_browser_window && window.is_focused().unwrap_or(false)).then_some(label)
    })
}

fn browser_window_for_ui(label: &str) -> &str {
    if label == "wdio-host" {
        "main"
    } else {
        label
    }
}

fn emit_snapshot(app: &tauri::AppHandle, data: &MutexGuard<'_, Vec<TabState>>) {
    for label in app
        .windows()
        .keys()
        .filter(|label| label.as_str() == "main" || label.starts_with("browser-window-"))
    {
        let tabs: Vec<_> = data
            .iter()
            .filter(|tab| &tab.window_label == label)
            .cloned()
            .collect();
        let _ = app.emit_to(label, TAB_EVENT, snapshot(&tabs));
    }
}

fn emit_history(app: &tauri::AppHandle, entries: &[HistoryEntry]) {
    for label in app
        .windows()
        .keys()
        .filter(|label| label.as_str() == "main" || label.starts_with("browser-window-"))
    {
        let _ = app.emit_to(label, HISTORY_EVENT, entries);
    }
}

fn snapshot_for_window(tabs: &[TabState], window_label: &str) -> BrowserSnapshot {
    let window_label = browser_window_for_ui(window_label);
    let local: Vec<_> = tabs
        .iter()
        .filter(|tab| tab.window_label == window_label)
        .cloned()
        .collect();
    snapshot(&local)
}

fn window_bounds(state: &BrowserState, window_label: &str) -> Result<ViewBounds, String> {
    let window_label = browser_window_for_ui(window_label);
    let bounds = state
        .window_bounds
        .lock()
        .map_err(|_| "Browser bounds are unavailable")?;
    Ok(bounds
        .get(window_label)
        .copied()
        .unwrap_or_else(ViewBounds::default))
}

fn close_browser_window_tabs(app: &tauri::AppHandle, state: &BrowserState, window_label: &str) {
    if let Ok(mut tabs) = state.data.lock() {
        let closing: Vec<_> = tabs
            .iter()
            .filter(|tab| tab.window_label == window_label)
            .cloned()
            .collect();
        if let Ok(mut recently_closed) = state.recently_closed.lock() {
            for tab in closing.iter().rev().filter(|tab| !tab.private) {
                remember_closed_tab(&mut recently_closed, SessionTab::from(tab));
            }
        }
        tabs.retain(|tab| tab.window_label != window_label);
        emit_snapshot(app, &tabs);
    }
    let split_changed = state
        .split_tabs
        .lock()
        .map(|mut splits| splits.remove(window_label).is_some())
        .unwrap_or(false);
    if split_changed {
        let _ = app.emit_to(window_label, SPLIT_EVENT, Option::<SplitLayout>::None);
    }
    let _ = persist_session(state);
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
        tabs: tabs
            .iter()
            .filter(|tab| !tab.private)
            .map(SessionTab::from)
            .collect(),
        active_tab_id: tabs
            .iter()
            .find(|tab| tab.active && !tab.private)
            .or_else(|| tabs.iter().find(|tab| !tab.private))
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
        emit_history(app, &snapshot);
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
        emit_history(app, &snapshot);
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
    private: bool,
    owner_window: &str,
) -> Result<(), String> {
    let parsed = allowed_navigation_url(input)?;
    let number = state.next_id.fetch_add(1, Ordering::Relaxed) + 1;
    let id = format!("tab-{number}");
    let bounds = window_bounds(state, owner_window)?;
    create_page_webview(
        app,
        state,
        &id,
        parsed.clone(),
        bounds,
        private,
        owner_window,
    )?;
    let mut tabs = state
        .data
        .lock()
        .map_err(|_| "Browser state is unavailable")?;
    for tab in tabs
        .iter_mut()
        .filter(|tab| tab.window_label == owner_window)
    {
        tab.active = false;
    }
    let mut tab = TabState::new_in_window(
        id,
        parsed.to_string(),
        true,
        private,
        owner_window.to_string(),
    );
    if private {
        tab.record_navigation(parsed.to_string());
    }
    tabs.push(tab);
    emit_snapshot(app, &tabs);
    drop(tabs);
    state
        .split_tabs
        .lock()
        .map_err(|_| "Browser state is unavailable")?
        .remove(owner_window);
    let _ = app.emit_to(owner_window, SPLIT_EVENT, Option::<SplitLayout>::None);
    persist_session(state)?;
    position_tabs(app, state)
}

fn route_webview_new_window_request(
    app: &tauri::AppHandle,
    state: &BrowserState,
    source_tab_id: &str,
    url: &str,
) -> Result<String, String> {
    let (private, owner_window) = state
        .data
        .lock()
        .map_err(|_| "Browser state is unavailable")?
        .iter()
        .find(|tab| tab.id == source_tab_id)
        .map(|tab| (tab.private, tab.window_label.clone()))
        .ok_or("The source tab no longer exists")?;
    open_url_in_new_tab(app, state, url, private, &owner_window)?;
    Ok(owner_window)
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
    if !is_trusted_browser_ui(webview.label()) {
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
    if !is_trusted_browser_ui(webview.label()) {
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
    if !is_trusted_browser_ui(webview.label()) {
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
    if !is_trusted_browser_ui(webview.label()) {
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

// WebView creation must leave the IPC callback on Windows so WebView2 can pump messages.
#[tauri::command(async)]
fn open_link_in_new_tab(
    webview: tauri::Webview,
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserState>,
    url: String,
) -> Result<(), String> {
    if !webview.label().starts_with("page-") {
        return Err("Links can only be opened from a browser page".into());
    }
    let (private, owner_window) = state
        .data
        .lock()
        .map_err(|_| "Browser state is unavailable")?
        .iter()
        .find(|tab| page_label(&tab.id) == webview.label())
        .map(|tab| (tab.private, tab.window_label.clone()))
        .ok_or("That tab no longer exists")?;
    open_url_in_new_tab(&app, &state, &url, private, &owner_window)
}

#[tauri::command]
fn focus_browser_tab(
    webview: tauri::Webview,
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserState>,
) -> Result<(), String> {
    let tab_id = webview
        .label()
        .strip_prefix("page-")
        .ok_or("Only browser pages can request focus")?
        .to_string();
    let owner_window = state
        .data
        .lock()
        .map_err(|_| "Browser state is unavailable")?
        .iter()
        .find(|tab| tab.id == tab_id)
        .map(|tab| tab.window_label.clone())
        .ok_or("That tab no longer exists")?;
    let mut tabs = state
        .data
        .lock()
        .map_err(|_| "Browser state is unavailable")?;
    for tab in tabs
        .iter_mut()
        .filter(|tab| tab.window_label == owner_window)
    {
        tab.active = tab.id == tab_id;
    }
    emit_snapshot(&app, &tabs);
    drop(tabs);
    persist_session(&state)?;
    position_tabs(&app, &state)
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

#[cfg(all(debug_assertions, feature = "desktop-test"))]
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopPageDiagnostics {
    browser: BrowserSnapshot,
    window_labels: Vec<String>,
    tab_id: String,
    loading: bool,
    url: String,
    title: String,
    ready_state: String,
    text: String,
    dom: String,
    errors: Vec<String>,
}

#[cfg(all(debug_assertions, feature = "desktop-test"))]
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopTabDragOverlayDiagnostics {
    attached: bool,
    visible: bool,
    target: Option<&'static str>,
}

/// WebDriver attaches to the trusted `main` webview. Website tabs are separate native
/// WKWebViews, so this debug-only command inspects the selected child through Tauri's handle.
#[cfg(all(debug_assertions, feature = "desktop-test"))]
#[tauri::command]
async fn desktop_test_inspect_page(
    webview: tauri::Webview,
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserState>,
    tab_id: Option<String>,
) -> Result<DesktopPageDiagnostics, String> {
    if !is_trusted_browser_ui(webview.label()) {
        return Err("Desktop diagnostics are only available to the trusted browser UI".into());
    }
    let (id, loading, browser) = {
        let tabs = state
            .data
            .lock()
            .map_err(|_| "Browser state is unavailable")?;
        let tab = match tab_id {
            Some(id) => tabs.iter().find(|tab| tab.id == id),
            None => tabs.iter().find(|tab| tab.active),
        }
        .ok_or("The requested browser tab does not exist")?;
        (tab.id.clone(), tab.loading, snapshot(&tabs))
    };
    let window_labels = app.windows().keys().cloned().collect();

    let page = get_page(&app, &id)?;
    let script = r#"JSON.stringify((() => ({
      url: location.href,
      title: document.title,
      readyState: document.readyState,
      text: document.body?.innerText ?? '',
      dom: document.documentElement?.outerHTML ?? '',
      errors: window.__MY_BROWSER_TEST_ERRORS__ ?? []
    }))())"#;
    let (sender, receiver) = std::sync::mpsc::channel();
    page.eval_with_callback(script, move |result| {
        let _ = sender.send(result);
    })
    .map_err(|error| error.to_string())?;
    let encoded = tauri::async_runtime::spawn_blocking(move || {
        receiver
            .recv_timeout(Duration::from_secs(5))
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())??;
    let mut page: serde_json::Value =
        serde_json::from_str(&encoded).map_err(|error| error.to_string())?;
    if let Some(json) = page.as_str() {
        page = serde_json::from_str(json).map_err(|error| error.to_string())?;
    }
    Ok(DesktopPageDiagnostics {
        browser,
        window_labels,
        tab_id: id,
        loading,
        url: page["url"].as_str().unwrap_or_default().to_string(),
        title: page["title"].as_str().unwrap_or_default().to_string(),
        ready_state: page["readyState"].as_str().unwrap_or_default().to_string(),
        text: page["text"]
            .as_str()
            .unwrap_or_default()
            .chars()
            .take(20_000)
            .collect(),
        dom: page["dom"]
            .as_str()
            .unwrap_or_default()
            .chars()
            .take(100_000)
            .collect(),
        errors: page["errors"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|error| error.as_str().map(str::to_string))
            .collect(),
    })
}

/// Inspect the macOS overlay attached to the active website child WebView.
#[cfg(all(debug_assertions, feature = "desktop-test"))]
#[tauri::command]
fn desktop_test_inspect_tab_drag_overlay(
    webview: tauri::Webview,
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserState>,
) -> Result<DesktopTabDragOverlayDiagnostics, String> {
    if !is_trusted_browser_ui(webview.label()) {
        return Err("Desktop diagnostics are only available to the trusted browser UI".into());
    }
    #[cfg(target_os = "macos")]
    {
        use objc2::MainThreadMarker;

        let owner = browser_window_for_ui(webview.label());
        let active_id = state
            .data
            .lock()
            .map_err(|_| "Browser state is unavailable")?
            .iter()
            .find(|tab| tab.window_label == owner && tab.active)
            .map(|tab| tab.id.clone())
            .ok_or("The browser window has no active tab")?;
        let target_id = state
            .tab_drag_target
            .lock()
            .map_err(|_| "Browser state is unavailable")?
            .clone()
            .unwrap_or(active_id);
        let page = get_page(&app, &target_id)?;
        let (sender, receiver) = std::sync::mpsc::channel();
        page.with_webview(move |_| {
            let diagnostics = MainThreadMarker::new()
                .map(|_| unsafe { platforms::tab_drag_overlay::diagnostics() });
            let result = diagnostics
                .map(|native| DesktopTabDragOverlayDiagnostics {
                    attached: native.attached,
                    visible: native.visible,
                    target: native.target,
                })
                .ok_or_else(|| {
                    "Native overlay inspection requires the AppKit main thread".to_string()
                });
            let _ = sender.send(result);
        })
        .map_err(|error| error.to_string())?;
        receiver.recv().map_err(|error| error.to_string())?
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, state);
        Err("The native tab drag overlay is only available on macOS".into())
    }
}

/// Drive and inspect the trusted browser UI from the debug-only WebDriver host.
#[cfg(all(debug_assertions, feature = "desktop-test"))]
#[tauri::command]
async fn desktop_test_browser_ui(
    webview: tauri::Webview,
    app: tauri::AppHandle,
    action: String,
    tab_id: Option<String>,
    menu_item: Option<String>,
) -> Result<serde_json::Value, String> {
    if !is_trusted_browser_ui(webview.label()) {
        return Err("Desktop UI controls are only available to the trusted browser UI".into());
    }
    let ui = app
        .get_webview("main")
        .ok_or("The trusted browser UI is unavailable")?;
    let args = serde_json::json!({ "action": action, "tabId": tab_id, "menuItem": menu_item });
    let script = format!(
        r#"JSON.stringify((() => {{
          const args = {args};
          if (args.action === 'open-context-menu') {{
            const row = Array.from(document.querySelectorAll('[data-tab-id]')).find(node => node.dataset.tabId === args.tabId);
            if (!row) return {{ error: `Tab row ${{args.tabId}} was not found` }};
            if (typeof window.__myBrowserTestOpenTabContextMenu !== 'function') return {{ error: 'The desktop-test context menu bridge is unavailable' }};
            window.__myBrowserTestOpenTabContextMenu(args.tabId);
            return {{ opened: true }};
          }}
          if (args.action === 'click-context-item') {{
            const item = Array.from(document.querySelectorAll('.sidebar-context-menu button')).find(node => node.textContent.trim() === args.menuItem);
            if (!item) return {{ error: `Context item ${{args.menuItem}} was not found` }};
            if (item.getAttribute('aria-disabled') === 'true' || item.hasAttribute('disabled')) return {{ error: `Context item ${{args.menuItem}} is disabled` }};
            const pointer = {{ bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 1 }};
            item.dispatchEvent(new PointerEvent('pointerdown', pointer));
            item.dispatchEvent(new PointerEvent('pointerup', {{ ...pointer, buttons: 0 }}));
            item.dispatchEvent(new MouseEvent('click', {{ bubbles: true, cancelable: true, button: 0 }}));
            return {{ clicked: true }};
          }}
          if (args.action === 'inspect') {{
            const page = document.querySelector('.start-page');
            const menuItems = Array.from(document.querySelectorAll('.sidebar-context-menu button')).map(node => node.textContent.trim());
            const hasTestContextMenuBridge = typeof window.__myBrowserTestOpenTabContextMenu === 'function';
            if (!page) return {{ startPage: null, menuItems, tabRows: document.querySelectorAll('[data-tab-id]').length, menus: document.querySelectorAll('[role="menu"]').length, hasTestContextMenuBridge }};
            const rect = page.getBoundingClientRect();
            return {{ startPage: {{ text: page.innerText, left: rect.left, top: rect.top, width: rect.width, height: rect.height, className: page.className }}, slot: (() => {{ const slot = document.querySelector('.webview-slot').getBoundingClientRect(); return {{ left: slot.left, top: slot.top, width: slot.width, height: slot.height }}; }})(), menuItems, tabRows: document.querySelectorAll('[data-tab-id]').length, menus: document.querySelectorAll('[role="menu"]').length, hasTestContextMenuBridge }};
          }}
          throw new Error(`Unsupported UI test action ${{args.action}}`);
        }})())"#,
        args = args
    );
    let (sender, receiver) = std::sync::mpsc::channel();
    ui.eval_with_callback(&script, move |result| {
        let _ = sender.send(result);
    })
    .map_err(|error| error.to_string())?;
    let encoded = tauri::async_runtime::spawn_blocking(move || {
        receiver
            .recv_timeout(Duration::from_secs(5))
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())??;
    let mut value: serde_json::Value = serde_json::from_str(&encoded).map_err(|error| {
        format!("Could not decode browser UI test result ({error}); raw result: {encoded:?}")
    })?;
    if let Some(json) = value.as_str() {
        value = serde_json::from_str(json).map_err(|error| error.to_string())?;
    }
    Ok(value)
}

/// Exercise app-tab routing for a website's new-window request.
#[cfg(all(debug_assertions, feature = "desktop-test"))]
#[tauri::command]
fn desktop_test_request_new_window(
    webview: tauri::Webview,
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserState>,
    tab_id: String,
    url: String,
) -> Result<String, String> {
    if !is_trusted_browser_ui(webview.label()) {
        return Err("Desktop UI controls are only available to the trusted browser UI".into());
    }
    allowed_navigation_url(&url)?;
    route_webview_new_window_request(&app, &state, &tab_id, &url)
}

fn create_page_webview(
    app: &tauri::AppHandle,
    state: &BrowserState,
    id: &str,
    url: url::Url,
    bounds: ViewBounds,
    private: bool,
    owner_window: &str,
) -> Result<(), String> {
    let window = app
        .get_window(owner_window)
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
    let filter_settings = state
        .filtering
        .lock()
        .map_err(|_| "Filter settings are unavailable".to_string())?
        .clone();
    let filter_enabled = cfg!(target_os = "macos")
        && filter_settings
            .as_ref()
            .is_some_and(|settings| settings.enabled);
    let filter_json = filter_settings
        .as_ref()
        .map(|settings| settings.compiled_rules.clone())
        .unwrap_or_default();
    let filter_ready = Arc::new(std::sync::atomic::AtomicBool::new(!filter_enabled));
    let pending_navigation = Arc::new(Mutex::new(
        filter_enabled
            .then_some(url.clone())
            .filter(|url| matches!(url.scheme(), "http" | "https")),
    ));
    let initial_url = if filter_enabled {
        url::Url::parse("about:blank").expect("valid blank URL")
    } else {
        url.clone()
    };
    let navigation_filter_ready = filter_ready.clone();
    let navigation_pending = pending_navigation.clone();
    let builder = tauri::webview::WebviewBuilder::new(label, WebviewUrl::External(initial_url))
        .incognito(private)
        .initialization_script(
            r#"window.__MY_BROWSER_TEST_ERRORS__ = [];
              window.addEventListener('error', event => window.__MY_BROWSER_TEST_ERRORS__.push(String(event.message)));
              window.addEventListener('unhandledrejection', event => window.__MY_BROWSER_TEST_ERRORS__.push(String(event.reason)));"#,
        )
        .initialization_script(
            r#"(() => {
              let pending = false;
              const focusBrowserTab = () => {
                if (pending) return;
                pending = true;
                window.__TAURI_INTERNALS__?.invoke('focus_browser_tab')
                  .catch(() => {})
                  .finally(() => { pending = false; });
              };
              window.addEventListener('focus', focusBrowserTab);
              document.addEventListener('pointerdown', focusBrowserTab, true);
            })();"#,
        )
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
                if !navigation_filter_ready.load(std::sync::atomic::Ordering::Acquire) {
                    if let Ok(mut pending) = navigation_pending.lock() {
                        *pending = Some(target.clone());
                    }
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
                        && !tab.private
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
                    let history_url = (!tab.private).then(|| tab.url.clone());
                    emit_snapshot(&title_app, &tabs);
                    drop(tabs);
                    let _ = persist_session(&title_app.state::<BrowserState>());
                    if let Some(history_url) = history_url {
                        update_history_entry_title(
                            &title_app,
                            &title_app.state::<BrowserState>(),
                            &history_url,
                            &title,
                        );
                    }
                }
            }
        })
        .on_new_window({
            let new_window_app = app.clone();
            let new_window_state = (*state).clone();
            let new_window_tab_id = navigation_tab_id.clone();
            move |url, _features| {
                if let Err(error) = route_webview_new_window_request(
                    &new_window_app,
                    &new_window_state,
                    &new_window_tab_id,
                    url.as_str(),
                ) {
                    eprintln!("could not route the requested link to a new browser tab: {error}");
                }
                // The browser creates a tab in its current app shell. Deny WebKit's
                // unmanaged popup after routing the request into that tab.
                tauri::webview::NewWindowResponse::Deny
            }
        })
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
    #[cfg(target_os = "macos")]
    if filter_enabled {
        platforms::macos::install_filter_for_page(
            app.clone(),
            page_label(id),
            filter_json,
            pending_navigation,
            filter_ready,
        );
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (filter_json, pending_navigation, filter_ready);
    #[cfg(target_os = "windows")]
    platforms::windows::install_shortcuts(app, &page_label(id), owner_window)?;
    Ok(())
}

#[tauri::command]
fn get_browser_state(
    webview: tauri::Webview,
    state: tauri::State<'_, BrowserState>,
) -> Result<BrowserSnapshot, String> {
    if !is_trusted_browser_ui(webview.label()) {
        return Err("Browser state is only available to the trusted UI".into());
    }
    let tabs = state
        .data
        .lock()
        .map_err(|_| "Browser state is unavailable")?;
    Ok(snapshot_for_window(&tabs, webview.label()))
}

#[tauri::command]
fn clear_browsing_data(
    webview: tauri::Webview,
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserState>,
) -> Result<(), String> {
    if !is_trusted_browser_ui(webview.label()) {
        return Err("Browsing data can only be cleared from the trusted browser UI".into());
    }
    for (label, page) in app.webviews() {
        if label.starts_with("page-") {
            page.clear_all_browsing_data()
                .map_err(|error| format!("Could not clear website data: {error}"))?;
        }
    }
    state
        .history
        .lock()
        .map_err(|_| "History is unavailable")?
        .clear();
    persist_history(&state)?;
    emit_history(&app, &[]);
    Ok(())
}

fn filter_settings_path(state: &BrowserState) -> Result<PathBuf, String> {
    state
        .filtering_file
        .lock()
        .map_err(|_| "Filter settings path is unavailable".to_string())?
        .clone()
        .ok_or_else(|| "Filter settings path is unavailable".to_string())
}

fn persist_filter_settings(state: &BrowserState, settings: &FilterSettings) -> Result<(), String> {
    settings.persist(&filter_settings_path(state)?)
}

fn commit_filter_settings(
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
fn get_filter_settings(
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
async fn set_filtering_enabled(
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
async fn set_filter_site_exception(
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
async fn update_filter_list(
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

#[tauri::command]
fn get_history(
    webview: tauri::Webview,
    state: tauri::State<'_, BrowserState>,
) -> Result<Vec<HistoryEntry>, String> {
    if !is_trusted_browser_ui(webview.label()) {
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
async fn find_in_page(
    webview: tauri::Webview,
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserState>,
    tab_id: String,
    query: String,
    backwards: bool,
) -> Result<usize, String> {
    if !is_trusted_browser_ui(webview.label()) {
        return Err("Find is only available to the trusted browser UI".into());
    }
    let page = get_page_for_window(&app, &state, webview.label(), &tab_id)?;
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
async fn get_tab_favicon(
    webview: tauri::Webview,
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserState>,
    tab_id: String,
) -> Result<String, String> {
    if !is_trusted_browser_ui(webview.label()) {
        return Err("Favicons are only available to the trusted browser UI".into());
    }
    let page = get_page_for_window(&app, &state, webview.label(), &tab_id)?;
    let script = r#"(() => {
      const icon = document.querySelector('link[rel~="icon" i], link[rel~="shortcut" i]');
      if (icon && icon.href) return icon.href;
      return /^https?:$/.test(location.protocol) ? new URL('/favicon.ico', location.href).href : '';
    })()"#;
    let (sender, receiver) = std::sync::mpsc::channel();
    page.eval_with_callback(script, move |result| {
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

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct PageSecurityInfo {
    origin: String,
    secure_https: bool,
    location: String,
    camera: String,
    microphone: String,
    playing_audio: bool,
}

#[tauri::command]
async fn get_page_security_info(
    webview: tauri::Webview,
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserState>,
    tab_id: String,
) -> Result<PageSecurityInfo, String> {
    if !is_trusted_browser_ui(webview.label()) {
        return Err("Security information is only available to the trusted browser UI".into());
    }
    let page = get_page_for_window(&app, &state, webview.label(), &tab_id)?;
    // Permissions.query() is asynchronous in WebKit, while eval_with_callback returns
    // immediately. Cache its result in the page and read that cache on subsequent polls.
    let script = r#"(() => {
      const cacheKey = '__myBrowserSecurityPermissionState';
      const state = window[cacheKey] || (window[cacheKey] = {});
      for (const [name, key] of [['geolocation', 'location'], ['camera', 'camera'], ['microphone', 'microphone']]) {
        if (state[key] === undefined && !state[`${key}Pending`]) {
          state[`${key}Pending`] = true;
          try {
            navigator.permissions.query({ name }).then(permission => {
              state[key] = permission.state;
              permission.onchange = () => { state[key] = permission.state; };
            }).catch(() => { state[key] = 'unsupported'; }).finally(() => { state[`${key}Pending`] = false; });
          } catch (_) { state[key] = 'unsupported'; state[`${key}Pending`] = false; }
        }
      }
      const mediaPlaying = [...document.querySelectorAll('audio,video')].some(media =>
        !media.paused && !media.ended && !media.muted && media.volume > 0
      );
      return JSON.stringify({
        origin: location.origin,
        secureHttps: location.protocol === 'https:' && window.isSecureContext,
        location: state.location || 'unknown',
        camera: state.camera || 'unknown',
        microphone: state.microphone || 'unknown',
        playingAudio: mediaPlaying
      });
    })()"#;
    let (sender, receiver) = std::sync::mpsc::channel();
    page.eval_with_callback(script, move |result| {
        let _ = sender.send(result);
    })
    .map_err(|error| error.to_string())?;
    let result = tauri::async_runtime::spawn_blocking(move || {
        receiver.recv().map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())??;
    // WebKit's callback result encodes the string value as JSON, hence two parses.
    let encoded: String = serde_json::from_str(&result).map_err(|error| error.to_string())?;
    serde_json::from_str(&encoded).map_err(|error| error.to_string())
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct SecurityPopoverAnchor {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

#[cfg(target_os = "macos")]
fn security_popover_inputs(
    anchor: SecurityPopoverAnchor,
    info: PageSecurityInfo,
) -> (
    platforms::security_popover::AnchorRect,
    platforms::security_popover::SecurityInfo,
) {
    (
        platforms::security_popover::AnchorRect {
            x: anchor.x,
            y: anchor.y,
            width: anchor.width,
            height: anchor.height,
        },
        platforms::security_popover::SecurityInfo {
            origin: info.origin,
            secure_https: info.secure_https,
            location: info.location,
            camera: info.camera,
            microphone: info.microphone,
            playing_audio: info.playing_audio,
        },
    )
}

#[tauri::command]
async fn toggle_page_security_popover(
    webview: tauri::Webview,
    app: tauri::AppHandle,
    anchor: SecurityPopoverAnchor,
    info: PageSecurityInfo,
) -> Result<bool, String> {
    if !is_trusted_browser_ui(webview.label()) {
        return Err("Security popovers are only available to the trusted browser UI".into());
    }
    #[cfg(target_os = "macos")]
    {
        let main = app
            .get_webview("main")
            .ok_or("Browser window is unavailable")?;
        let (anchor, info) = security_popover_inputs(anchor, info);
        let inset = titlebar_inset(&main)?;
        let (sender, receiver) = std::sync::mpsc::channel();
        main.with_webview(move |platform| {
            let shown = unsafe {
                platforms::security_popover::toggle(platform.inner(), anchor, info, inset)
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
        let _ = (app, anchor, info);
        Err("Native security popovers are currently available on macOS only".into())
    }
}

#[tauri::command]
async fn update_page_security_popover(
    webview: tauri::Webview,
    app: tauri::AppHandle,
    anchor: SecurityPopoverAnchor,
    info: PageSecurityInfo,
) -> Result<bool, String> {
    if !is_trusted_browser_ui(webview.label()) {
        return Err("Security popovers are only available to the trusted browser UI".into());
    }
    #[cfg(target_os = "macos")]
    {
        let main = app
            .get_webview("main")
            .ok_or("Browser window is unavailable")?;
        let (anchor, info) = security_popover_inputs(anchor, info);
        let inset = titlebar_inset(&main)?;
        let (sender, receiver) = std::sync::mpsc::channel();
        main.with_webview(move |platform| {
            let shown = unsafe {
                platforms::security_popover::update(platform.inner(), anchor, info, inset)
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
        let _ = (app, anchor, info);
        Err("Native security popovers are currently available on macOS only".into())
    }
}

#[tauri::command]
fn cycle_tab(
    webview: tauri::Webview,
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserState>,
    backwards: bool,
) -> Result<BrowserSnapshot, String> {
    if !is_trusted_browser_ui(webview.label()) {
        return Err("Tabs can only be cycled from the trusted browser UI".into());
    }
    let owner_window = browser_window_for_ui(webview.label()).to_string();
    let mut tabs = state
        .data
        .lock()
        .map_err(|_| "Browser state is unavailable")?;
    let mut local: Vec<_> = tabs
        .iter()
        .filter(|tab| tab.window_label == owner_window)
        .cloned()
        .collect();
    cycle_active_tab(&mut local, if backwards { -1 } else { 1 });
    let active_id = local
        .iter()
        .find(|tab| tab.active)
        .map(|tab| tab.id.clone());
    for tab in tabs
        .iter_mut()
        .filter(|tab| tab.window_label == owner_window)
    {
        tab.active = Some(tab.id.clone()) == active_id;
    }
    emit_snapshot(&app, &tabs);
    drop(tabs);
    persist_session(&state)?;
    position_tabs(&app, &state)?;
    let tabs = state
        .data
        .lock()
        .map_err(|_| "Browser state is unavailable")?;
    Ok(snapshot_for_window(&tabs, &owner_window))
}

#[tauri::command]
fn reveal_download(
    webview: tauri::Webview,
    state: tauri::State<'_, BrowserState>,
    download_id: String,
) -> Result<(), String> {
    if !is_trusted_browser_ui(webview.label()) {
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

#[tauri::command(async)]
fn create_tab(
    webview: tauri::Webview,
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserState>,
    private: Option<bool>,
) -> Result<BrowserSnapshot, String> {
    if !is_trusted_browser_ui(webview.label()) {
        return Err("Tabs can only be created from the trusted browser UI".into());
    }
    let owner_window = browser_window_for_ui(webview.label()).to_string();
    let number = state.next_id.fetch_add(1, Ordering::Relaxed) + 1;
    let id = format!("tab-{number}");
    let bounds = window_bounds(&state, &owner_window)?;
    let blank = url::Url::parse("about:blank").unwrap();
    let private = private.unwrap_or(false);
    create_page_webview(&app, &state, &id, blank, bounds, private, &owner_window)?;
    let mut tabs = state
        .data
        .lock()
        .map_err(|_| "Browser state is unavailable")?;
    for tab in tabs
        .iter_mut()
        .filter(|tab| tab.window_label == owner_window)
    {
        tab.active = false;
    }
    tabs.push(TabState::new_in_window(
        id,
        String::new(),
        true,
        private,
        owner_window.clone(),
    ));
    emit_snapshot(&app, &tabs);
    drop(tabs);
    state
        .split_tabs
        .lock()
        .map_err(|_| "Browser state is unavailable")?
        .remove(&owner_window);
    let _ = app.emit_to(&owner_window, SPLIT_EVENT, Option::<SplitLayout>::None);
    persist_session(&state)?;
    position_tabs(&app, &state)?;
    Ok(snapshot_for_window(
        &state
            .data
            .lock()
            .map_err(|_| "Browser state is unavailable")?,
        &owner_window,
    ))
}

#[tauri::command]
fn select_tab(
    webview: tauri::Webview,
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserState>,
    tab_id: String,
) -> Result<BrowserSnapshot, String> {
    if !is_trusted_browser_ui(webview.label()) {
        return Err("Tabs can only be selected from the trusted browser UI".into());
    }
    let owner_window = browser_window_for_ui(webview.label()).to_string();
    let mut tabs = state
        .data
        .lock()
        .map_err(|_| "Browser state is unavailable")?;
    for tab in tabs
        .iter_mut()
        .filter(|tab| tab.window_label == owner_window)
    {
        tab.active = tab.id == tab_id;
    }
    emit_snapshot(&app, &tabs);
    drop(tabs);
    persist_session(&state)?;
    position_tabs(&app, &state)?;
    Ok(snapshot_for_window(
        &state
            .data
            .lock()
            .map_err(|_| "Browser state is unavailable")?,
        &owner_window,
    ))
}

#[tauri::command]
fn reorder_tabs(
    webview: tauri::Webview,
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserState>,
    tab_ids: Vec<String>,
) -> Result<BrowserSnapshot, String> {
    if !is_trusted_browser_ui(webview.label()) {
        return Err("Tabs can only be reordered from the trusted browser UI".into());
    }
    let mut tabs = state
        .data
        .lock()
        .map_err(|_| "Browser state is unavailable")?;
    let owner_window = browser_window_for_ui(webview.label()).to_string();
    let requested: HashSet<&str> = tab_ids.iter().map(String::as_str).collect();
    let local_count = tabs
        .iter()
        .filter(|tab| tab.window_label == owner_window)
        .count();
    if tab_ids.len() != local_count
        || requested.len() != local_count
        || tabs
            .iter()
            .filter(|tab| tab.window_label == owner_window)
            .any(|tab| !requested.contains(tab.id.as_str()))
    {
        return Err("The new tab order does not match the open tabs".into());
    }
    let positions: std::collections::HashMap<&str, usize> = tab_ids
        .iter()
        .enumerate()
        .map(|(index, id)| (id.as_str(), index))
        .collect();
    let mut reordered: Vec<_> = tabs
        .iter()
        .filter(|tab| tab.window_label == owner_window)
        .cloned()
        .collect();
    reordered.sort_by_key(|tab| positions[tab.id.as_str()]);
    let mut reordered = reordered.into_iter();
    for tab in tabs
        .iter_mut()
        .filter(|tab| tab.window_label == owner_window)
    {
        *tab = reordered.next().expect("local tabs were counted");
    }
    emit_snapshot(&app, &tabs);
    let result = snapshot_for_window(&tabs, &owner_window);
    drop(tabs);
    persist_session(&state)?;
    Ok(result)
}

#[tauri::command]
fn close_tab(
    webview: tauri::Webview,
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserState>,
    tab_id: String,
) -> Result<BrowserSnapshot, String> {
    if !is_trusted_browser_ui(webview.label()) {
        return Err("Tabs can only be closed from the trusted browser UI".into());
    }
    let closing_was_active;
    let owner_window = browser_window_for_ui(webview.label()).to_string();
    {
        let mut tabs = state
            .data
            .lock()
            .map_err(|_| "Browser state is unavailable")?;
        let index = tabs
            .iter()
            .position(|tab| tab.id == tab_id && tab.window_label == owner_window)
            .ok_or("That tab no longer exists")?;
        let local_index = tabs[..index]
            .iter()
            .filter(|tab| tab.window_label == owner_window)
            .count();
        closing_was_active = tabs[index].active;
        let closed = (!tabs[index].private).then(|| SessionTab::from(&tabs[index]));
        let mut recently_closed = state
            .recently_closed
            .lock()
            .map_err(|_| "Browser state is unavailable")?;
        if let Some(closed) = closed {
            remember_closed_tab(&mut recently_closed, closed);
        }
        tabs.remove(index);
        if closing_was_active {
            if let Some(tab) = tabs
                .iter_mut()
                .filter(|tab| tab.window_label == owner_window)
                .nth(local_index)
            {
                tab.active = true;
            } else if let Some(tab) = tabs
                .iter_mut()
                .rev()
                .find(|tab| tab.window_label == owner_window)
            {
                tab.active = true;
            }
        }
    }
    let split_cleared = {
        let mut splits = state
            .split_tabs
            .lock()
            .map_err(|_| "Browser state is unavailable")?;
        if splits
            .get(&owner_window)
            .is_some_and(|layout| layout.contains(&tab_id))
        {
            splits.remove(&owner_window);
            true
        } else {
            false
        }
    };
    if split_cleared {
        let _ = app.emit_to(&owner_window, SPLIT_EVENT, Option::<SplitLayout>::None);
    }
    if let Some(page) = app.get_webview(&page_label(&tab_id)) {
        let _ = page.close();
    }
    if state
        .data
        .lock()
        .map_err(|_| "Browser state is unavailable")?
        .iter()
        .all(|tab| tab.window_label != owner_window)
    {
        return create_tab(webview, app, state, Some(false));
    }
    persist_session(&state)?;
    position_tabs(&app, &state)?;
    let tabs = state
        .data
        .lock()
        .map_err(|_| "Browser state is unavailable")?;
    emit_snapshot(&app, &tabs);
    Ok(snapshot_for_window(&tabs, &owner_window))
}

#[tauri::command(async)]
fn reopen_closed_tab(
    webview: tauri::Webview,
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserState>,
) -> Result<BrowserSnapshot, String> {
    if !is_trusted_browser_ui(webview.label()) {
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
    let owner_window = browser_window_for_ui(webview.label()).to_string();
    let bounds = window_bounds(&state, &owner_window)?;
    let number = state.next_id.fetch_add(1, Ordering::Relaxed) + 1;
    let id = format!("tab-{number}");
    create_page_webview(&app, &state, &id, url, bounds, false, &owner_window)?;
    {
        let mut tabs = state
            .data
            .lock()
            .map_err(|_| "Browser state is unavailable")?;
        for tab in tabs
            .iter_mut()
            .filter(|tab| tab.window_label == owner_window)
        {
            tab.active = false;
        }
        let mut tab = TabState::new_in_window(id, restored.url, true, false, owner_window.clone());
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
    Ok(snapshot_for_window(&tabs, &owner_window))
}

fn get_page(app: &tauri::AppHandle, tab_id: &str) -> Result<tauri::Webview, String> {
    app.get_webview(&page_label(tab_id))
        .ok_or_else(|| "Website view is unavailable".into())
}

fn get_page_for_window(
    app: &tauri::AppHandle,
    state: &BrowserState,
    ui_label: &str,
    tab_id: &str,
) -> Result<tauri::Webview, String> {
    let owner_window = browser_window_for_ui(ui_label);
    let belongs_to_window = state
        .data
        .lock()
        .map_err(|_| "Browser state is unavailable")?
        .iter()
        .any(|tab| tab.id == tab_id && tab.window_label == owner_window);
    if !belongs_to_window {
        return Err("That tab does not belong to this browser window".into());
    }
    get_page(app, tab_id)
}

#[tauri::command]
fn navigate(
    webview: tauri::Webview,
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserState>,
    tab_id: String,
    url: String,
) -> Result<(), String> {
    if !is_trusted_browser_ui(webview.label()) {
        return Err("Navigation is only available from the trusted browser UI".into());
    }
    let parsed = allowed_navigation_url(&url)?;
    let owner_window = browser_window_for_ui(webview.label()).to_string();
    let page = get_page_for_window(&app, &state, webview.label(), &tab_id)?;
    {
        let mut tabs = state
            .data
            .lock()
            .map_err(|_| "Browser state is unavailable")?;
        let tab = tabs
            .iter_mut()
            .find(|tab| tab.id == tab_id && tab.window_label == owner_window)
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
    if !is_trusted_browser_ui(webview.label()) {
        return Err("Navigation is only available from the trusted browser UI".into());
    }
    let page = get_page_for_window(&app, &state, webview.label(), &tab_id)?;
    let mut tabs = state
        .data
        .lock()
        .map_err(|_| "Browser state is unavailable")?;
    let tab = tabs
        .iter_mut()
        .find(|tab| tab.id == tab_id && tab.window_label == browser_window_for_ui(webview.label()))
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
    if !is_trusted_browser_ui(webview.label()) {
        return Err("Navigation is only available from the trusted browser UI".into());
    }
    let page = get_page_for_window(&app, &state, webview.label(), &tab_id)?;
    let mut tabs = state
        .data
        .lock()
        .map_err(|_| "Browser state is unavailable")?;
    let tab = tabs
        .iter_mut()
        .find(|tab| tab.id == tab_id && tab.window_label == browser_window_for_ui(webview.label()))
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
fn reload(
    webview: tauri::Webview,
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserState>,
    tab_id: String,
) -> Result<(), String> {
    if !is_trusted_browser_ui(webview.label()) {
        return Err("Navigation is only available from the trusted browser UI".into());
    }
    get_page_for_window(&app, &state, webview.label(), &tab_id)?
        .reload()
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn stop_loading(
    webview: tauri::Webview,
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserState>,
    tab_id: String,
) -> Result<(), String> {
    if !is_trusted_browser_ui(webview.label()) {
        return Err("Navigation is only available from the trusted browser UI".into());
    }
    get_page_for_window(&app, &state, webview.label(), &tab_id)?
        .eval("window.stop()")
        .map_err(|e| e.to_string())?;
    let mut tabs = state
        .data
        .lock()
        .map_err(|_| "Browser state is unavailable")?;
    if let Some(tab) = tabs
        .iter_mut()
        .find(|tab| tab.id == tab_id && tab.window_label == browser_window_for_ui(webview.label()))
    {
        tab.loading = false;
    }
    emit_snapshot(&app, &tabs);
    drop(tabs);
    persist_session(&state)?;
    Ok(())
}

/// Distance between the shell WebView's CSS viewport origin and the window content origin.
/// AppKit reports it as the WebView's top safe-area inset: the titlebar height in windowed
/// mode and zero in full screen.
#[cfg(target_os = "macos")]
fn titlebar_inset(webview: &tauri::Webview) -> Result<f64, String> {
    let (sender, receiver) = std::sync::mpsc::channel();
    webview
        .with_webview(move |platform| {
            let view = unsafe { &*(platform.inner() as *mut objc2_app_kit::NSView) };
            let _ = sender.send(view.safeAreaInsets().top);
        })
        .map_err(|error| error.to_string())?;
    receiver.recv().map_err(|error| error.to_string())
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
    if !is_trusted_browser_ui(webview.label()) {
        return Err("View bounds are only available to the trusted browser UI".into());
    }
    if ![x, y, width, height].iter().all(|value| value.is_finite()) || width < 1.0 || height < 1.0 {
        return Err("Invalid website view bounds".into());
    }
    #[cfg(target_os = "macos")]
    let bounds = {
        // Child WebViews use the window content origin, offset from the main
        // WebView's CSS viewport on macOS by the native titlebar inset. Extend
        // the height by the same inset so the child still reaches the bottom.
        let inset = titlebar_inset(&webview)?;
        ViewBounds {
            x,
            y: y + inset,
            width,
            height: height + inset,
        }
    };
    #[cfg(not(target_os = "macos"))]
    let bounds = ViewBounds {
        x,
        y,
        width,
        height,
    };
    state
        .window_bounds
        .lock()
        .map_err(|_| "Browser bounds are unavailable")?
        .insert(browser_window_for_ui(webview.label()).to_string(), bounds);
    position_tabs(&app, &state)
}

#[tauri::command]
fn set_settings_open(
    webview: tauri::Webview,
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserState>,
    open: bool,
) -> Result<(), String> {
    if !is_trusted_browser_ui(webview.label()) {
        return Err("Settings are only available to the trusted browser UI".into());
    }
    let mut open_windows = state
        .settings_open
        .lock()
        .map_err(|_| "Browser state unavailable")?;
    if open {
        open_windows.insert(browser_window_for_ui(webview.label()).to_string());
    } else {
        open_windows.remove(browser_window_for_ui(webview.label()));
    }
    drop(open_windows);
    position_tabs(&app, &state)
}

#[tauri::command]
fn set_tab_dragging(
    webview: tauri::Webview,
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserState>,
    dragging: bool,
    tab_id: Option<String>,
    target_tab_id: Option<String>,
    cancelled: Option<bool>,
) -> Result<(), String> {
    if !is_trusted_browser_ui(webview.label()) {
        return Err("Tab drag layout is only available to browser windows".into());
    }
    let owner_window = browser_window_for_ui(webview.label()).to_string();
    let (source_id, target_id) = if dragging {
        let tabs = state
            .data
            .lock()
            .map_err(|_| "Browser state is unavailable")?;
        let active_id = tabs
            .iter()
            .find(|tab| tab.window_label == owner_window && tab.active)
            .map(|tab| tab.id.clone());
        let target_id = target_tab_id
            .or(active_id)
            .ok_or("The browser window has no active tab")?;
        if !tabs
            .iter()
            .any(|tab| tab.id == target_id && tab.window_label == owner_window)
        {
            return Err("The tab drag target does not belong to this browser window".into());
        }
        if let Some(source_id) = tab_id.as_deref() {
            if !tabs
                .iter()
                .any(|tab| tab.id == source_id && tab.window_label == owner_window)
            {
                return Err("The dragged tab does not belong to this browser window".into());
            }
        }
        drop(tabs);
        *state
            .tab_drag_source
            .lock()
            .map_err(|_| "Browser state is unavailable")? = tab_id.clone();
        *state
            .tab_drag_target
            .lock()
            .map_err(|_| "Browser state is unavailable")? = Some(target_id.clone());
        (tab_id, Some(target_id))
    } else {
        let source_id = state
            .tab_drag_source
            .lock()
            .map_err(|_| "Browser state is unavailable")?
            .take();
        let target_id = state
            .tab_drag_target
            .lock()
            .map_err(|_| "Browser state is unavailable")?
            .take();
        (source_id, target_id)
    };
    *state
        .tab_dragging
        .lock()
        .map_err(|_| "Browser state is unavailable")? = dragging.then(|| owner_window.clone());

    #[cfg(target_os = "macos")]
    {
        use objc2::MainThreadMarker;
        use objc2_app_kit::NSView;
        if dragging {
            if let Some(target_id) = target_id.as_ref() {
                if let Some(page) = app.get_webview(&page_label(target_id)) {
                    let (sender, receiver) = std::sync::mpsc::channel();
                    page.with_webview(move |platform| {
                        let attached = MainThreadMarker::new().is_some_and(|mtm| unsafe {
                            let native = &*(platform.inner() as *mut NSView);
                            platforms::tab_drag_overlay::show(native, mtm)
                        });
                        let _ = sender.send(attached);
                    })
                    .map_err(|error| error.to_string())?;
                    if !receiver.recv().map_err(|error| error.to_string())? {
                        return Err("Could not attach the native tab drag overlay".into());
                    }
                }
            }
        } else {
            let mut completed_target = None;
            if let Some(target_id) = target_id.as_ref() {
                if let Some(page) = app.get_webview(&page_label(target_id)) {
                    let (sender, receiver) = std::sync::mpsc::channel();
                    let cancelled = cancelled.unwrap_or(false);
                    page.with_webview(move |_| {
                        let target = if MainThreadMarker::new().is_some() {
                            unsafe { platforms::tab_drag_overlay::hide(cancelled) }
                        } else {
                            None
                        };
                        let _ = sender.send(target);
                    })
                    .map_err(|error| error.to_string())?;
                    completed_target = receiver.recv().map_err(|error| error.to_string())?;
                }
            }
            if let (Some(target), Some(tab_id), Some(target_tab_id)) =
                (completed_target, source_id, target_id)
            {
                let _ = app.emit_to(
                    &owner_window,
                    "browser://tab-drag-drop",
                    serde_json::json!({
                        "tabId": tab_id,
                        "targetTabId": target_tab_id,
                        "target": target.as_str(),
                    }),
                );
            }
        }
    }
    position_tabs(&app, &state)
}

/// Toggle the web inspector of the window's active page.
#[tauri::command]
fn toggle_devtools(
    webview: tauri::Webview,
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserState>,
) -> Result<(), String> {
    if !is_trusted_browser_ui(webview.label()) {
        return Err("Developer tools are only available to browser windows".into());
    }
    let owner_window = browser_window_for_ui(webview.label()).to_string();
    let tab_id = state
        .data
        .lock()
        .map_err(|_| "Browser state is unavailable")?
        .iter()
        .find(|tab| tab.window_label == owner_window && tab.active)
        .map(|tab| tab.id.clone())
        .ok_or("The browser window has no active tab")?;
    let page = app
        .get_webview(&page_label(&tab_id))
        .ok_or("The active tab has no page to inspect")?;
    if page.is_devtools_open() {
        page.close_devtools();
    } else {
        page.open_devtools();
    }
    Ok(())
}

#[tauri::command]
fn get_split_tabs(
    webview: tauri::Webview,
    state: tauri::State<'_, BrowserState>,
) -> Result<Option<SplitLayout>, String> {
    if !is_trusted_browser_ui(webview.label()) {
        return Err("Split layout is only available to browser windows".into());
    }
    let owner = browser_window_for_ui(webview.label());
    let split = state
        .split_tabs
        .lock()
        .map_err(|_| "Browser state is unavailable")?
        .get(owner)
        .cloned();
    let split = split.filter(|layout| {
        state
            .data
            .lock()
            .map(|tabs| {
                tabs.iter().any(|tab| {
                    tab.id == layout.first_tab_id
                        && tab.window_label == browser_window_for_ui(webview.label())
                }) && tabs.iter().any(|tab| {
                    tab.id == layout.second_tab_id
                        && tab.window_label == browser_window_for_ui(webview.label())
                })
            })
            .unwrap_or(false)
    });
    Ok(split)
}

#[tauri::command]
fn split_tab(
    webview: tauri::Webview,
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserState>,
    tab_id: String,
    target_tab_id: String,
    side: String,
) -> Result<(), String> {
    if !is_trusted_browser_ui(webview.label())
        || !matches!(side.as_str(), "left" | "right" | "top" | "bottom")
    {
        return Err("Invalid split target".into());
    }
    let owner_window = browser_window_for_ui(webview.label());
    let tabs = state
        .data
        .lock()
        .map_err(|_| "Browser state is unavailable")?;
    let target_id = tabs
        .iter()
        .find(|tab| tab.id == target_tab_id && tab.window_label == owner_window)
        .map(|tab| (tab.id.clone(), tab.url.is_empty()))
        .ok_or("The split target does not belong to this browser window")?;
    let target = tabs
        .iter()
        .find(|tab| tab.id == tab_id && tab.window_label == owner_window)
        .ok_or("Choose a different tab in this window")?;
    if target_id.0 == tab_id || (target_id.1 && target.url.is_empty()) {
        return Err("A split requires at least one loaded page".into());
    }
    let target_id = target_id.0;
    let split = if matches!(side.as_str(), "left" | "top") {
        SplitLayout {
            first_tab_id: tab_id,
            second_tab_id: target_id,
            first_pane_percent: 50,
            orientation: if matches!(side.as_str(), "left" | "right") {
                SplitOrientation::Horizontal
            } else {
                SplitOrientation::Vertical
            },
        }
    } else {
        SplitLayout {
            first_tab_id: target_id,
            second_tab_id: tab_id,
            first_pane_percent: 50,
            orientation: if matches!(side.as_str(), "left" | "right") {
                SplitOrientation::Horizontal
            } else {
                SplitOrientation::Vertical
            },
        }
    };
    drop(tabs);
    state
        .split_tabs
        .lock()
        .map_err(|_| "Browser state is unavailable")?
        .insert(owner_window.to_string(), split.clone());
    let _ = app.emit_to(owner_window, SPLIT_EVENT, Some(split));
    position_tabs(&app, &state)
}

#[tauri::command]
fn clear_tab_split(
    webview: tauri::Webview,
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserState>,
) -> Result<(), String> {
    if !is_trusted_browser_ui(webview.label()) {
        return Err("Split layout is only available to browser windows".into());
    }
    state
        .split_tabs
        .lock()
        .map_err(|_| "Browser state is unavailable")?
        .remove(browser_window_for_ui(webview.label()));
    let _ = app.emit_to(
        browser_window_for_ui(webview.label()),
        SPLIT_EVENT,
        Option::<SplitLayout>::None,
    );
    position_tabs(&app, &state)
}

#[tauri::command]
fn resize_tab_split(
    webview: tauri::Webview,
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserState>,
    first_pane_percent: u8,
) -> Result<(), String> {
    if !is_trusted_browser_ui(webview.label()) || !(20..=80).contains(&first_pane_percent) {
        return Err("Invalid split divider position".into());
    }
    let owner = browser_window_for_ui(webview.label()).to_string();
    let updated = {
        let mut splits = state
            .split_tabs
            .lock()
            .map_err(|_| "Browser state is unavailable")?;
        let Some(layout) = splits.get_mut(&owner) else {
            return Err("There is no active split".into());
        };
        layout.first_pane_percent = first_pane_percent;
        layout.clone()
    };
    let _ = app.emit_to(&owner, SPLIT_EVENT, Some(updated));
    position_tabs(&app, &state)
}

#[tauri::command(async)]
fn move_tab_to_new_window(
    webview: tauri::Webview,
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserState>,
    tab_id: String,
) -> Result<String, String> {
    if !is_trusted_browser_ui(webview.label()) {
        return Err("Tabs can only be moved from a browser window".into());
    }
    let source_window = browser_window_for_ui(webview.label()).to_string();
    let mut tab = state
        .data
        .lock()
        .map_err(|_| "Browser state is unavailable")?
        .iter()
        .find(|tab| tab.id == tab_id && tab.window_label == source_window)
        .cloned()
        .ok_or("That tab no longer exists in this window")?;
    if tab.url.is_empty() {
        return Err("Load a page in this tab before moving it to a new window".into());
    }

    let window_number = state.next_id.fetch_add(1, Ordering::Relaxed) + 1;
    let destination = format!("browser-window-{window_number}");
    let browser_window =
        tauri::WebviewWindowBuilder::new(&app, &destination, WebviewUrl::App("index.html".into()))
            .title(if tab.title.is_empty() {
                "Unky"
            } else {
                &tab.title
            })
            .inner_size(1200.0, 800.0)
            .build()
            .map_err(|error| format!("Could not open a new browser window: {error}"))?;
    let close_app = app.clone();
    let close_state = state.inner().clone();
    let close_label = destination.clone();
    browser_window.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Destroyed) {
            close_browser_window_tabs(&close_app, &close_state, &close_label);
        }
    });

    let previous_page = app.get_webview(&page_label(&tab_id));
    if let Some(page) = previous_page {
        page.close().map_err(|error| {
            format!("Could not detach the tab from its current window: {error}")
        })?;
    }
    tab.window_label = destination.clone();
    tab.active = true;
    {
        let mut tabs = state
            .data
            .lock()
            .map_err(|_| "Browser state is unavailable")?;
        for existing in tabs
            .iter_mut()
            .filter(|item| item.window_label == source_window)
        {
            existing.active = false;
        }
        if let Some(existing) = tabs.iter_mut().find(|item| item.id == tab_id) {
            *existing = tab.clone();
        } else {
            return Err("The tab closed while it was being moved".into());
        }
        if let Some(source_active) = tabs
            .iter_mut()
            .find(|item| item.window_label == source_window)
        {
            source_active.active = true;
        }
    }

    let bounds = window_bounds(&state, &destination)?;
    let parsed = allowed_navigation_url(&tab.url)?;
    if let Err(error) = create_page_webview(
        &app,
        &state,
        &tab_id,
        parsed,
        bounds,
        tab.private,
        &destination,
    ) {
        if let Ok(mut tabs) = state.data.lock() {
            if let Some(existing) = tabs.iter_mut().find(|item| item.id == tab_id) {
                existing.window_label = source_window.clone();
            }
        }
        if let Ok(source_bounds) = window_bounds(&state, &source_window) {
            if let Ok(source_url) = allowed_navigation_url(&tab.url) {
                let _ = create_page_webview(
                    &app,
                    &state,
                    &tab_id,
                    source_url,
                    source_bounds,
                    tab.private,
                    &source_window,
                );
            }
        }
        return Err(format!(
            "Could not attach the tab to the new window: {error}"
        ));
    }
    if let Some(page) = app.get_webview(&page_label(&tab_id)) {
        page.set_zoom(tab.zoom).map_err(|error| error.to_string())?;
    }
    {
        let mut splits = state
            .split_tabs
            .lock()
            .map_err(|_| "Browser state is unavailable")?;
        if splits
            .get(&source_window)
            .is_some_and(|layout| layout.contains(&tab_id))
        {
            splits.remove(&source_window);
            let _ = app.emit_to(&source_window, SPLIT_EVENT, Option::<SplitLayout>::None);
        }
    }
    emit_snapshot(
        &app,
        &state
            .data
            .lock()
            .map_err(|_| "Browser state is unavailable")?,
    );
    persist_session(&state)?;
    position_tabs(&app, &state)?;
    Ok(destination)
}

fn adjust_active_zoom(
    app: &tauri::AppHandle,
    state: &BrowserState,
    action: &str,
    window_label: &str,
) -> Result<(), String> {
    let mut tabs = state.data.lock().map_err(|_| "Browser state unavailable")?;
    let tab = tabs
        .iter_mut()
        .find(|tab| tab.active && tab.window_label == window_label)
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

#[cfg(target_os = "macos")]
fn native_child_frame(page: tauri::Webview) -> Result<(objc2_foundation::NSRect, usize), String> {
    use objc2_app_kit::NSView;

    let (sender, receiver) = std::sync::mpsc::channel();
    page.with_webview(move |platform| {
        let native = unsafe { &*(platform.inner() as *mut NSView) };
        let frame = native.frame();
        let parent = unsafe { native.superview() };
        let parent_id = parent
            .as_deref()
            .map_or(0, |parent| parent as *const NSView as usize);
        let _ = sender.send((
            [
                frame.origin.x,
                frame.origin.y,
                frame.size.width,
                frame.size.height,
            ],
            parent_id,
        ));
    })
    .map_err(|error| error.to_string())?;
    let (frame, parent_id) = receiver.recv().map_err(|error| error.to_string())?;
    Ok((
        objc2_foundation::NSRect::new(
            objc2_foundation::NSPoint::new(frame[0], frame[1]),
            objc2_foundation::NSSize::new(frame[2], frame[3]),
        ),
        parent_id,
    ))
}

fn position_tabs(app: &tauri::AppHandle, state: &BrowserState) -> Result<(), String> {
    let split_tabs = state
        .split_tabs
        .lock()
        .map_err(|_| "Browser state is unavailable")?
        .clone();
    let settings_open = state
        .settings_open
        .lock()
        .map_err(|_| "Browser state is unavailable")?;
    let tabs = state
        .data
        .lock()
        .map_err(|_| "Browser state is unavailable")?;
    for tab in tabs.iter() {
        if let Some(page) = app.get_webview(&page_label(&tab.id)) {
            let split = split_tabs.get(&tab.window_label);
            let bounds = window_bounds(state, &tab.window_label)?;
            let split_is_active = split.is_some_and(|layout| {
                tabs.iter().any(|active_tab| {
                    active_tab.window_label == tab.window_label
                        && active_tab.active
                        && layout.contains(&active_tab.id)
                })
            });
            let split_position = split.filter(|_| split_is_active).and_then(|layout| {
                if tab.id == layout.first_tab_id {
                    Some((layout.orientation, false))
                } else if tab.id == layout.second_tab_id {
                    Some((layout.orientation, true))
                } else {
                    None
                }
            });
            let is_visible = !settings_open.contains(&tab.window_label)
                && (split_position.is_some() || tab.active)
                && !tab.url.is_empty();
            let (position, size) = if let Some((orientation, is_second)) =
                split_position.filter(|_| !tab.url.is_empty())
            {
                let gutter = 6.0;
                let first_percent =
                    split.map_or(50.0, |layout| layout.first_pane_percent as f64 / 100.0);
                match orientation {
                    SplitOrientation::Horizontal => {
                        let usable_width = (bounds.width - gutter).max(1.0);
                        let first_width = usable_width * first_percent;
                        let second_width = usable_width - first_width;
                        let pane_width = if is_second { second_width } else { first_width };
                        let x = if is_second {
                            bounds.x + first_width + gutter
                        } else {
                            bounds.x
                        };
                        (
                            tauri::LogicalPosition::new(x, bounds.y),
                            tauri::LogicalSize::new(pane_width.max(1.0), bounds.height),
                        )
                    }
                    SplitOrientation::Vertical => {
                        let usable_height = (bounds.height - gutter).max(1.0);
                        let first_height = usable_height * first_percent;
                        let second_height = usable_height - first_height;
                        let pane_height = if is_second {
                            second_height
                        } else {
                            first_height
                        };
                        let y = if is_second {
                            bounds.y + first_height + gutter
                        } else {
                            bounds.y
                        };
                        (
                            tauri::LogicalPosition::new(bounds.x, y),
                            tauri::LogicalSize::new(bounds.width, pane_height.max(1.0)),
                        )
                    }
                }
            } else if is_visible {
                (
                    tauri::LogicalPosition::new(bounds.x, bounds.y),
                    tauri::LogicalSize::new(bounds.width, bounds.height),
                )
            } else {
                (
                    tauri::LogicalPosition::new(20000.0, 20000.0),
                    tauri::LogicalSize::new(bounds.width.max(1.0), bounds.height.max(1.0)),
                )
            };
            page.set_position(position).map_err(|e| e.to_string())?;
            page.set_size(size).map_err(|e| e.to_string())?;
        }
    }
    drop(tabs);
    drop(settings_open);
    #[cfg(target_os = "macos")]
    {
        use objc2::MainThreadMarker;
        use objc2_app_kit::NSView;
        let overlay_state = split_tabs.values().find_map(|layout| {
            let tabs = state.data.lock().ok()?;
            let owner = tabs
                .iter()
                .find(|tab| tab.id == layout.first_tab_id)?
                .window_label
                .clone();
            let active = tabs
                .iter()
                .find(|tab| tab.window_label == owner && tab.active)?;
            if !layout.contains(&active.id) || state.settings_open.lock().ok()?.contains(&owner) {
                return None;
            }
            Some((owner, layout.clone(), active.id == layout.first_tab_id))
        });
        if let Some((owner, layout, active_first)) = overlay_state {
            if let (Some(page), Some(second_page)) = (
                app.get_webview(&page_label(&layout.first_tab_id)),
                app.get_webview(&page_label(&layout.second_tab_id)),
            ) {
                let (second_frame, second_parent_id) = native_child_frame(second_page)?;
                let horizontal = layout.orientation == SplitOrientation::Horizontal;
                let percent = layout.first_pane_percent;
                let changed_app = app.clone();
                let changed_owner = owner.clone();
                let on_change = Arc::new(move |new_percent| {
                    let _ = changed_app.emit_to(&changed_owner, SPLIT_RESIZE_EVENT, new_percent);
                });
                page.with_webview(move |platform| {
                    if let Some(mtm) = MainThreadMarker::new() {
                        let native = unsafe { &*(platform.inner() as *mut NSView) };
                        let parent_id = unsafe { native.superview() }
                            .as_deref()
                            .map_or(0, |parent| parent as *const NSView as usize);
                        if parent_id == second_parent_id {
                            unsafe {
                                platforms::split_overlay::update(
                                    native,
                                    second_frame,
                                    horizontal,
                                    percent,
                                    active_first,
                                    on_change,
                                    mtm,
                                );
                            }
                        }
                    }
                })
                .map_err(|error| error.to_string())?;
            }
        } else {
            app.run_on_main_thread(|| unsafe { platforms::split_overlay::hide() })
                .map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        allowed_navigation_url, parse_launch_args, persist_session, read_session,
        validated_session_tab,
    };
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
    fn command_line_launch_uses_the_same_web_url_validation_as_navigation() {
        let request =
            parse_launch_args(["mybrowser", "example.com", "--private"].map(str::to_string))
                .unwrap()
                .unwrap();
        assert_eq!(request.url, "https://example.com/");
        assert!(request.private);
        assert!(parse_launch_args(["mybrowser", "file:///tmp/item"].map(str::to_string)).is_err());
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
    let initial_launch_request = parse_launch_args(std::env::args());
    let builder =
        tauri::Builder::default()
            .plugin(tauri_plugin_dialog::init())
            .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            match parse_launch_args(args) {
                Ok(request) => {
                    let window_label =
                        focused_browser_window_label(app).unwrap_or_else(|| "main".to_string());
                    #[cfg(not(all(debug_assertions, feature = "desktop-test")))]
                    if let Some(window) = app.get_window(&window_label) {
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                    if let Some(request) = request {
                        let _ = app.emit_to(&window_label, LAUNCH_REQUEST_EVENT, request);
                    }
                }
                Err(error) => eprintln!("Could not handle mybrowser arguments: {error}"),
            }
        }));
    #[cfg(all(debug_assertions, feature = "desktop-test"))]
    let builder = builder.plugin(tauri_plugin_wdio_webdriver::init());
    #[cfg(all(debug_assertions, feature = "desktop-test"))]
    let builder = builder.plugin(tauri_plugin_wdio::init());
    let builder = builder.manage(BrowserState::default()).setup(move |app| {
        #[cfg(all(debug_assertions, feature = "desktop-test"))]
        tauri::WebviewWindowBuilder::new(app, "wdio-host", WebviewUrl::App("index.html".into()))
            .title("Unky WebDriver")
            .inner_size(1200.0, 800.0)
            .visible(false)
            .build()?;
        let state = app.state::<BrowserState>();
        if let Ok(Some(request)) = initial_launch_request.clone() {
            *state
                .launch_request
                .lock()
                .expect("launch request lock poisoned") = Some(request);
        }
        let session_path = app.path().app_data_dir()?.join("session.json");
        #[cfg(debug_assertions)]
        let session_path = std::env::var_os("MY_BROWSER_PROFILE_DIR")
            .map(PathBuf::from)
            .map(|path| path.join("session.json"))
            .unwrap_or(session_path);
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
        let filter_path = session_path.with_file_name("filtering.json");
        *state
            .filtering_file
            .lock()
            .expect("filter settings path lock poisoned") = Some(filter_path.clone());
        let filter_settings = FilterSettings::load(&filter_path).map_err(std::io::Error::other)?;
        if !filter_path.exists() {
            filter_settings
                .persist(&filter_path)
                .map_err(std::io::Error::other)?;
        }
        *state
            .filtering
            .lock()
            .expect("filter settings lock poisoned") = Some(filter_settings);
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
        let bounds = window_bounds(&state, "main").expect("browser bounds available");
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        {
            use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};
            let settings = MenuItemBuilder::with_id("open-settings", "Settings…")
                .accelerator("CmdOrCtrl+,")
                .build(app)?;
            #[cfg(target_os = "macos")]
            let about = MenuItemBuilder::with_id("show-about", "About Unky")
                .build(app)?;
            #[cfg(target_os = "macos")]
            let app_menu = SubmenuBuilder::new(app, "Unky")
                .item(&about)
                .separator()
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
            let new_private_tab =
                MenuItemBuilder::with_id("shortcut-new-private-tab", "New Private Tab")
                    .accelerator("CmdOrCtrl+Shift+N")
                    .build(app)?;
            #[cfg(target_os = "macos")]
            let open_in_browser =
                MenuItemBuilder::with_id("shortcut-open-in-browser", "Open in Another Browser…")
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
            let previous_tab = MenuItemBuilder::with_id("shortcut-previous-tab", "Previous Tab")
                .accelerator("Ctrl+Shift+Tab")
                .build(app)?;
            #[cfg(not(target_os = "macos"))]
            let next_tab_page = MenuItemBuilder::with_id("shortcut-next-tab-page", "Next Tab")
                .accelerator("Ctrl+PageDown")
                .build(app)?;
            #[cfg(not(target_os = "macos"))]
            let previous_tab_page =
                MenuItemBuilder::with_id("shortcut-previous-tab-page", "Previous Tab")
                    .accelerator("Ctrl+PageUp")
                    .build(app)?;
            #[cfg(target_os = "macos")]
            let next_tab_mac = MenuItemBuilder::with_id("shortcut-next-tab-mac", "Next Tab (Chrome)")
                .accelerator("CmdOrCtrl+Alt+Right")
                .build(app)?;
            #[cfg(target_os = "macos")]
            let previous_tab_mac =
                MenuItemBuilder::with_id("shortcut-previous-tab-mac", "Previous Tab (Chrome)")
                    .accelerator("CmdOrCtrl+Alt+Left")
                    .build(app)?;
            #[cfg(target_os = "macos")]
            let next_tab_safari =
                MenuItemBuilder::with_id("shortcut-next-tab-safari", "Next Tab (Safari)")
                    .accelerator("CmdOrCtrl+Shift+]")
                    .build(app)?;
            #[cfg(target_os = "macos")]
            let previous_tab_safari =
                MenuItemBuilder::with_id("shortcut-previous-tab-safari", "Previous Tab (Safari)")
                    .accelerator("CmdOrCtrl+Shift+[")
                    .build(app)?;
            let file_menu = SubmenuBuilder::new(app, "File")
                .item(&new_tab)
                .item(&new_private_tab);
            #[cfg(target_os = "macos")]
            let file_menu = file_menu.item(&open_in_browser);
            let file_menu = file_menu
                .item(&close_tab)
                .item(&reopen_closed_tab)
                .item(&next_tab)
                .item(&previous_tab);
            #[cfg(not(target_os = "macos"))]
            let file_menu = file_menu.item(&next_tab_page).item(&previous_tab_page);
            #[cfg(target_os = "macos")]
            let file_menu = file_menu.item(&next_tab_mac).item(&previous_tab_mac);
            #[cfg(target_os = "macos")]
            let file_menu = file_menu.item(&next_tab_safari).item(&previous_tab_safari);
            #[cfg(not(target_os = "macos"))]
            let file_menu = file_menu.separator().item(&settings).separator().quit();
            let file_menu = file_menu.build()?;
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
            let show_history =
                MenuItemBuilder::with_id("show-history", "Show History").build(app)?;
            let show_downloads =
                MenuItemBuilder::with_id("show-downloads", "Show Downloads").build(app)?;
            let find = MenuItemBuilder::with_id("shortcut-find", "Find in Page")
                .accelerator("CmdOrCtrl+F")
                .build(app)?;
            let reload = MenuItemBuilder::with_id("shortcut-reload", "Reload Page")
                .accelerator("CmdOrCtrl+R")
                .build(app)?;
            let go_back = MenuItemBuilder::with_id("shortcut-go-back", "Back")
                .accelerator(if cfg!(target_os = "macos") {
                    "CmdOrCtrl+["
                } else {
                    "Alt+Left"
                })
                .build(app)?;
            let go_forward = MenuItemBuilder::with_id("shortcut-go-forward", "Forward")
                .accelerator(if cfg!(target_os = "macos") {
                    "CmdOrCtrl+]"
                } else {
                    "Alt+Right"
                })
                .build(app)?;
            let view_menu = SubmenuBuilder::new(app, "View")
                .item(&show_history)
                .item(&show_downloads)
                .separator()
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
            let show_shortcuts = MenuItemBuilder::with_id("show-shortcuts", "Show Shortcuts")
                .build(app)?;
            let help_menu = SubmenuBuilder::new(app, "Help")
                .item(&show_shortcuts)
                .build()?;
            let menu = MenuBuilder::new(app);
            #[cfg(target_os = "macos")]
            let menu = menu.item(&app_menu);
            let menu = menu
                .item(&file_menu)
                .item(&edit_menu)
                .item(&view_menu)
                .item(&help_menu)
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
                create_page_webview(
                    app.handle(),
                    &state,
                    &saved.id,
                    parsed,
                    bounds,
                    false,
                    "main",
                )
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
                    false,
                    "main",
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
        #[cfg(all(debug_assertions, feature = "desktop-test"))]
        if let Some(profile) = std::env::var_os("MY_BROWSER_PROFILE_DIR").map(PathBuf::from) {
            let inventory = serde_json::json!({
                "windows": app.handle().windows().keys().collect::<Vec<_>>(),
                "webviews": app.handle().webviews().keys().collect::<Vec<_>>(),
                "webviewWindows": app.handle().webview_windows().keys().collect::<Vec<_>>(),
            });
            let _ = fs::write(
                profile.join("wdio-window-inventory.json"),
                serde_json::to_vec_pretty(&inventory).unwrap_or_default(),
            );
        }
        #[cfg(all(debug_assertions, feature = "desktop-test"))]
        if let Some(window) = app.get_window("main") {
            window.show()?;
            window.set_focus()?;
        }
        Ok(())
    });
    #[cfg(feature = "macos-session-test")]
    let builder = builder.invoke_handler(tauri::generate_handler![
        take_launch_request,
        get_browser_state,
        get_external_browsers,
        open_in_external_browser,
        clear_browsing_data,
        get_filter_settings,
        set_filtering_enabled,
        set_filter_site_exception,
        update_filter_list,
        set_tab_dragging,
        toggle_devtools,
        get_split_tabs,
        split_tab,
        clear_tab_split,
        resize_tab_split,
        move_tab_to_new_window,
        focus_browser_tab,
        get_history,
        get_downloads,
        find_in_page,
        get_tab_favicon,
        get_page_security_info,
        toggle_page_security_popover,
        update_page_security_popover,
        cycle_tab,
        reveal_download,
        open_link_in_new_tab,
        sync_page_url,
        create_tab,
        select_tab,
        reorder_tabs,
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
    #[cfg(all(not(feature = "macos-session-test"), feature = "desktop-test"))]
    let builder = builder.invoke_handler(tauri::generate_handler![
        take_launch_request,
        get_browser_state,
        get_external_browsers,
        open_in_external_browser,
        clear_browsing_data,
        get_filter_settings,
        set_filtering_enabled,
        set_filter_site_exception,
        update_filter_list,
        set_tab_dragging,
        toggle_devtools,
        get_split_tabs,
        split_tab,
        clear_tab_split,
        resize_tab_split,
        move_tab_to_new_window,
        focus_browser_tab,
        get_history,
        get_downloads,
        find_in_page,
        get_tab_favicon,
        get_page_security_info,
        toggle_page_security_popover,
        update_page_security_popover,
        cycle_tab,
        reveal_download,
        open_link_in_new_tab,
        sync_page_url,
        create_tab,
        select_tab,
        reorder_tabs,
        close_tab,
        navigate,
        go_back,
        go_forward,
        reload,
        stop_loading,
        set_settings_open,
        set_view_bounds,
        reopen_closed_tab,
        desktop_test_inspect_page,
        desktop_test_inspect_tab_drag_overlay,
        desktop_test_browser_ui,
        desktop_test_request_new_window
    ]);
    #[cfg(all(not(feature = "macos-session-test"), not(feature = "desktop-test")))]
    let builder = builder.invoke_handler(tauri::generate_handler![
        take_launch_request,
        get_browser_state,
        get_external_browsers,
        open_in_external_browser,
        clear_browsing_data,
        get_filter_settings,
        set_filtering_enabled,
        set_filter_site_exception,
        update_filter_list,
        set_tab_dragging,
        toggle_devtools,
        get_split_tabs,
        split_tab,
        clear_tab_split,
        resize_tab_split,
        move_tab_to_new_window,
        focus_browser_tab,
        get_history,
        get_downloads,
        find_in_page,
        get_tab_favicon,
        get_page_security_info,
        toggle_page_security_popover,
        update_page_security_popover,
        cycle_tab,
        reveal_download,
        open_link_in_new_tab,
        sync_page_url,
        create_tab,
        select_tab,
        reorder_tabs,
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
            let Some(window_label) = focused_browser_window_label(app) else {
                return;
            };
            if event.id().as_ref() == "open-settings" {
                let _ = app.emit_to(&window_label, OPEN_SETTINGS_EVENT, ());
            }
            if event.id().as_ref() == "show-about" {
                use tauri_plugin_dialog::DialogExt;
                let text = format!(
                    "Version {}\nBuild {}\nBuilt {}\nCommit {}",
                    env!("CARGO_PKG_VERSION"),
                    option_env!("BUILD_NUMBER").unwrap_or("local"),
                    option_env!("BUILD_TIMESTAMP").unwrap_or("unknown"),
                    option_env!("BUILD_COMMIT").unwrap_or("unknown")
                );
                app.dialog().message(text).title("About Unky").show(|_| {});
            }
            if event.id().as_ref() == "show-history" {
                let _ = app.emit_to(&window_label, SHOW_HISTORY_EVENT, ());
            }
            if event.id().as_ref() == "show-downloads" {
                let _ = app.emit_to(&window_label, SHOW_DOWNLOADS_EVENT, ());
            }
            if event.id().as_ref() == "show-shortcuts" {
                let _ = app.emit_to(&window_label, "browser://show-shortcuts", ());
            }
            let id = event.id().as_ref();
            if id.starts_with("shortcut-") {
                let _ = app.emit_to(
                    &window_label,
                    SHORTCUT_EVENT,
                    id.trim_start_matches("shortcut-"),
                );
            }
            if let Some(action) = ["zoom-in", "zoom-out", "zoom-reset"]
                .iter()
                .find(|id| event.id().as_ref() == **id)
            {
                if let Some(state) = app.try_state::<BrowserState>() {
                    let _ = adjust_active_zoom(app, &state, action, &window_label);
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running browser");
}
