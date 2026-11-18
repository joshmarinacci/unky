//! Browser window labels, bounds, page lookup, and tab snapshots.

use crate::*;

pub(crate) fn page_label(id: &str) -> String {
    format!("page-{id}")
}

pub(crate) fn is_trusted_browser_ui(label: &str) -> bool {
    label == "main"
        || label.starts_with("browser-window-")
        || (cfg!(all(debug_assertions, feature = "desktop-test")) && label == "wdio-host")
}

pub(crate) fn focused_browser_window_label(app: &tauri::AppHandle) -> Option<String> {
    app.windows().into_iter().find_map(|(label, window)| {
        let is_browser_window = label == "main" || label.starts_with("browser-window-");
        (is_browser_window && window.is_focused().unwrap_or(false)).then_some(label)
    })
}

pub(crate) fn browser_window_for_ui(label: &str) -> &str {
    if label == "wdio-host" {
        "main"
    } else {
        label
    }
}

pub(crate) fn emit_snapshot(app: &tauri::AppHandle, data: &MutexGuard<'_, Vec<TabState>>) {
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

pub(crate) fn snapshot_for_window(tabs: &[TabState], window_label: &str) -> BrowserSnapshot {
    let window_label = browser_window_for_ui(window_label);
    let local: Vec<_> = tabs
        .iter()
        .filter(|tab| tab.window_label == window_label)
        .cloned()
        .collect();
    snapshot(&local)
}

pub(crate) fn window_bounds(
    state: &BrowserState,
    window_label: &str,
) -> Result<ViewBounds, String> {
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

pub(crate) fn close_browser_window_tabs(
    app: &tauri::AppHandle,
    state: &BrowserState,
    window_label: &str,
) {
    if let Some(popup) = app.get_webview_window(&format!("address-suggestions-{window_label}")) {
        let _ = popup.close();
    }
    #[cfg(target_os = "macos")]
    {
        let owner = window_label.to_string();
        let _ =
            app.run_on_main_thread(move || unsafe { platforms::downloads_popover::remove(&owner) });
    }
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

pub(crate) fn get_page(app: &tauri::AppHandle, tab_id: &str) -> Result<tauri::Webview, String> {
    app.get_webview(&page_label(tab_id))
        .ok_or_else(|| "Website view is unavailable".into())
}

pub(crate) fn get_page_for_window(
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
