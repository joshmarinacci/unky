//! History, bookmarks, and clearing browsing data.

use crate::*;

pub(crate) fn emit_history(app: &tauri::AppHandle, entries: &[HistoryEntry]) {
    for label in app
        .windows()
        .keys()
        .filter(|label| label.as_str() == "main" || label.starts_with("browser-window-"))
    {
        let _ = app.emit_to(label, HISTORY_EVENT, entries);
    }
}

pub(crate) fn database_lock(
    state: &BrowserState,
) -> Result<std::sync::MutexGuard<'_, Option<BrowserDatabase>>, String> {
    state
        .database
        .lock()
        .map_err(|_| "Browser database is unavailable".to_string())
}

pub(crate) fn emit_bookmarks(app: &tauri::AppHandle, state: &BrowserState) -> Result<(), String> {
    let bookmarks = database_lock(state)?
        .as_ref()
        .ok_or_else(|| "Browser database is unavailable".to_string())?
        .load_bookmarks()?;
    for label in app
        .windows()
        .keys()
        .filter(|label| label.as_str() == "main" || label.starts_with("browser-window-"))
    {
        let _ = app.emit_to(label, BOOKMARKS_EVENT, &bookmarks);
    }
    refresh_browser_menus(app, state)
}

pub(crate) fn current_history(state: &BrowserState) -> Result<Vec<HistoryEntry>, String> {
    database_lock(state)?
        .as_ref()
        .ok_or_else(|| "Browser database is unavailable".to_string())?
        .history(None, 10_000)
}

pub(crate) fn record_history_visit(
    app: &tauri::AppHandle,
    state: &BrowserState,
    url: String,
    title: String,
) {
    let visited_at = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or_default();
    let result = database_lock(state).and_then(|database| {
        database
            .as_ref()
            .ok_or_else(|| "Browser database is unavailable".to_string())?
            .record_visit(&url, &title, visited_at)
            .map(|_| ())
    });
    if let Err(error) = result {
        eprintln!("could not record browsing history: {error}");
        return;
    }
    if let Ok(snapshot) = current_history(state) {
        if let Ok(mut history) = state.history.lock() {
            *history = snapshot.clone();
        }
        emit_history(app, &snapshot);
        let _ = refresh_browser_menus(app, state);
    }
}

pub(crate) fn update_history_entry_title(
    app: &tauri::AppHandle,
    state: &BrowserState,
    url: &str,
    title: &str,
) {
    let result = database_lock(state).and_then(|database| {
        database
            .as_ref()
            .ok_or_else(|| "Browser database is unavailable".to_string())?
            .update_latest_visit_title(url, title)
    });
    if result.is_ok() {
        if let Ok(snapshot) = current_history(state) {
            if let Ok(mut history) = state.history.lock() {
                *history = snapshot.clone();
            }
            emit_history(app, &snapshot);
            let _ = refresh_browser_menus(app, state);
        }
    }
}

#[tauri::command]
pub(crate) fn clear_browsing_data(
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
    database_lock(&state)?
        .as_ref()
        .ok_or_else(|| "Browser database is unavailable".to_string())?
        .clear_history()?;
    state
        .history
        .lock()
        .map_err(|_| "History is unavailable")?
        .clear();
    emit_history(&app, &[]);
    refresh_browser_menus(&app, &state)?;
    Ok(())
}

#[tauri::command]
pub(crate) fn load_bookmarks(
    webview: tauri::Webview,
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserState>,
    legacy_bookmarks: Vec<BookmarkNode>,
) -> Result<Vec<BookmarkNode>, String> {
    if !is_trusted_browser_ui(webview.label()) {
        return Err("Bookmarks are only available to the trusted browser UI".into());
    }
    let bookmarks = database_lock(&state)?
        .as_mut()
        .ok_or_else(|| "Browser database is unavailable".to_string())?
        .migrate_bookmarks_once(&legacy_bookmarks)?;
    refresh_browser_menus(&app, &state)?;
    Ok(bookmarks)
}

#[tauri::command]
pub(crate) fn save_bookmarks(
    webview: tauri::Webview,
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserState>,
    bookmarks: Vec<BookmarkNode>,
) -> Result<(), String> {
    if !is_trusted_browser_ui(webview.label()) {
        return Err("Bookmarks can only be changed from the trusted browser UI".into());
    }
    database_lock(&state)?
        .as_mut()
        .ok_or_else(|| "Browser database is unavailable".to_string())?
        .save_bookmarks(&bookmarks)?;
    refresh_browser_menus(&app, &state)
}

#[tauri::command]
pub(crate) fn clear_history(
    webview: tauri::Webview,
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserState>,
) -> Result<(), String> {
    if !is_trusted_browser_ui(webview.label()) {
        return Err("History can only be cleared from the trusted browser UI".into());
    }
    database_lock(&state)?
        .as_ref()
        .ok_or_else(|| "Browser database is unavailable".to_string())?
        .clear_history()?;
    state
        .history
        .lock()
        .map_err(|_| "History is unavailable")?
        .clear();
    emit_history(&app, &[]);
    refresh_browser_menus(&app, &state)
}

#[tauri::command]
pub(crate) fn import_bookmarks_html(
    webview: tauri::Webview,
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserState>,
    path: String,
) -> Result<Vec<BookmarkNode>, String> {
    if !is_trusted_browser_ui(webview.label()) {
        return Err("Bookmarks can only be imported from the trusted browser UI".into());
    }
    let html = fs::read_to_string(path).map_err(|error| error.to_string())?;
    let bookmarks = database_lock(&state)?
        .as_mut()
        .ok_or_else(|| "Browser database is unavailable".to_string())?
        .import_bookmarks_html(&html)?;
    refresh_browser_menus(&app, &state)?;
    Ok(bookmarks)
}

#[tauri::command]
pub(crate) fn export_bookmarks_html(
    webview: tauri::Webview,
    state: tauri::State<'_, BrowserState>,
    path: String,
) -> Result<(), String> {
    if !is_trusted_browser_ui(webview.label()) {
        return Err("Bookmarks can only be exported from the trusted browser UI".into());
    }
    let html = database_lock(&state)?
        .as_ref()
        .ok_or_else(|| "Browser database is unavailable".to_string())?
        .export_bookmarks_html()?;
    fs::write(path, html).map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) fn get_history(
    webview: tauri::Webview,
    state: tauri::State<'_, BrowserState>,
) -> Result<Vec<HistoryEntry>, String> {
    if !is_trusted_browser_ui(webview.label()) {
        return Err("History is only available to the trusted browser UI".into());
    }
    database_lock(&state)?
        .as_ref()
        .ok_or_else(|| "Browser database is unavailable".to_string())?
        .history(None, 10_000)
}

#[tauri::command]
pub(crate) fn search_history(
    webview: tauri::Webview,
    state: tauri::State<'_, BrowserState>,
    query: String,
) -> Result<Vec<HistoryEntry>, String> {
    if !is_trusted_browser_ui(webview.label()) {
        return Err("History is only available to the trusted browser UI".into());
    }
    database_lock(&state)?
        .as_ref()
        .ok_or_else(|| "Browser database is unavailable".to_string())?
        .history(Some(&query), 10_000)
}
