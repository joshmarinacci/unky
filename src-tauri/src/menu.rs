//! Native app menu: tab-position submenu, bookmarks menu, and menu events.

use crate::*;

pub(crate) const TAB_POSITION_MENU_OPTIONS: [(&str, &str); 4] = [
    ("left", "Left"),
    ("right", "Right"),
    ("top", "Top"),
    ("bottom", "Bottom"),
];

#[derive(Default)]
pub(crate) struct TabPositionMenuState {
    pub(crate) by_window: Mutex<HashMap<String, String>>,
}

pub(crate) fn tab_position_submenu(
    app: &tauri::AppHandle,
) -> Option<tauri::menu::Submenu<tauri::Wry>> {
    let menu = app.menu()?;
    let tauri::menu::MenuItemKind::Submenu(view_menu) = menu.get("view-menu")? else {
        return None;
    };
    let tauri::menu::MenuItemKind::Submenu(position_menu) = view_menu.get("tab-position-menu")?
    else {
        return None;
    };
    Some(position_menu)
}

pub(crate) fn set_tab_position_menu_checks(
    app: &tauri::AppHandle,
    position: &str,
) -> Result<(), String> {
    let Some(menu) = tab_position_submenu(app) else {
        return Ok(());
    };
    for (option, _) in TAB_POSITION_MENU_OPTIONS {
        let id = format!("tab-position-{option}");
        if let Some(tauri::menu::MenuItemKind::Check(item)) = menu.get(&id) {
            item.set_checked(option == position)
                .map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

pub(crate) fn remember_tab_position(
    app: &tauri::AppHandle,
    window_label: &str,
    position: &str,
) -> Result<(), String> {
    if !TAB_POSITION_MENU_OPTIONS
        .iter()
        .any(|(option, _)| *option == position)
    {
        return Err("Unsupported tab position".into());
    }
    app.state::<TabPositionMenuState>()
        .by_window
        .lock()
        .map_err(|_| "Tab position menu state is unavailable".to_string())?
        .insert(window_label.to_string(), position.to_string());
    let focused = focused_browser_window_label(app);
    if focused.as_deref() == Some(window_label) || focused.is_none() {
        set_tab_position_menu_checks(app, position)?;
    }
    Ok(())
}

pub(crate) fn choose_tab_position_from_menu(
    app: &tauri::AppHandle,
    window_label: &str,
    position: &str,
) -> Result<(), String> {
    remember_tab_position(app, window_label, position)?;
    // The app menu is shared by every browser window, so restore the exclusive check state
    // even though the clicked native checkbox toggled itself first.
    set_tab_position_menu_checks(app, position)?;
    app.emit_to(
        window_label,
        TAB_POSITION_MENU_EVENT,
        serde_json::json!({
            "windowLabel": window_label,
            "position": position,
        }),
    )
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) fn sync_tab_position_menu(
    webview: tauri::Webview,
    app: tauri::AppHandle,
    position: String,
) -> Result<(), String> {
    if !is_trusted_browser_ui(webview.label()) {
        return Err("Tab position can only be changed from the trusted browser UI".into());
    }
    if webview.label() == "wdio-host" {
        return Ok(());
    }
    remember_tab_position(&app, webview.label(), &position)
}

pub(crate) fn refresh_browser_menus(
    app: &tauri::AppHandle,
    state: &BrowserState,
) -> Result<(), String> {
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        let (bookmarks, recent_history) = {
            let database = database_lock(state)?;
            let database = database
                .as_ref()
                .ok_or_else(|| "Browser database is unavailable".to_string())?;
            (
                database.load_bookmarks()?,
                database.recent_distinct_history(10)?,
            )
        };
        let Some(menu) = app.menu() else {
            return Ok(());
        };
        let Some(tauri::menu::MenuItemKind::Submenu(bookmarks_menu)) = menu.get("bookmarks-menu")
        else {
            return Ok(());
        };
        let Some(tauri::menu::MenuItemKind::Submenu(history_menu)) = menu.get("history-menu")
        else {
            return Ok(());
        };
        for index in (0..bookmarks_menu
            .items()
            .map_err(|error| error.to_string())?
            .len())
            .rev()
        {
            bookmarks_menu
                .remove_at(index)
                .map_err(|error| error.to_string())?;
        }
        append_bookmark_menu_items(app, &bookmarks_menu, &bookmarks)?;
        if !bookmarks.is_empty() {
            bookmarks_menu
                .append(
                    &tauri::menu::PredefinedMenuItem::separator(app)
                        .map_err(|error| error.to_string())?,
                )
                .map_err(|error| error.to_string())?;
        }
        bookmarks_menu
            .append(
                &tauri::menu::MenuItemBuilder::with_id("import-bookmarks", "Import Bookmarks…")
                    .build(app)
                    .map_err(|error| error.to_string())?,
            )
            .map_err(|error| error.to_string())?;
        bookmarks_menu
            .append(
                &tauri::menu::MenuItemBuilder::with_id("export-bookmarks", "Export Bookmarks…")
                    .build(app)
                    .map_err(|error| error.to_string())?,
            )
            .map_err(|error| error.to_string())?;

        let history_items = history_menu.items().map_err(|error| error.to_string())?;
        for index in (0..history_items.len()).rev() {
            history_menu
                .remove_at(index)
                .map_err(|error| error.to_string())?;
        }
        history_menu
            .append(
                &tauri::menu::MenuItemBuilder::with_id("history-show-all", "Show All History")
                    .build(app)
                    .map_err(|error| error.to_string())?,
            )
            .map_err(|error| error.to_string())?;
        history_menu
            .append(
                &tauri::menu::MenuItemBuilder::with_id("clear-history", "Clear History…")
                    .build(app)
                    .map_err(|error| error.to_string())?,
            )
            .map_err(|error| error.to_string())?;
        if !recent_history.is_empty() {
            history_menu
                .append(
                    &tauri::menu::PredefinedMenuItem::separator(app)
                        .map_err(|error| error.to_string())?,
                )
                .map_err(|error| error.to_string())?;
            for entry in recent_history {
                let title = if entry.title.trim().is_empty() {
                    entry.url.as_str()
                } else {
                    entry.title.as_str()
                };
                let item = tauri::menu::MenuItemBuilder::with_id(
                    format!("history-open-{}", entry.id),
                    title,
                )
                .build(app)
                .map_err(|error| error.to_string())?;
                history_menu
                    .append(&item)
                    .map_err(|error| error.to_string())?;
            }
        }
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let _ = (app, state);
    Ok(())
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
pub(crate) fn append_bookmark_menu_items(
    app: &tauri::AppHandle,
    menu: &tauri::menu::Submenu<tauri::Wry>,
    nodes: &[BookmarkNode],
) -> Result<(), String> {
    for node in nodes {
        match node {
            BookmarkNode::Bookmark { id, title, .. } => {
                let item =
                    tauri::menu::MenuItemBuilder::with_id(format!("bookmark-open-{id}"), title)
                        .build(app)
                        .map_err(|error| error.to_string())?;
                menu.append(&item).map_err(|error| error.to_string())?;
            }
            BookmarkNode::Folder {
                id,
                title,
                children,
            } => {
                let folder = tauri::menu::SubmenuBuilder::with_id(
                    app,
                    format!("bookmark-folder-{id}"),
                    title,
                )
                .build()
                .map_err(|error| error.to_string())?;
                append_bookmark_menu_items(app, &folder, children)?;
                menu.append(&folder).map_err(|error| error.to_string())?;
            }
        }
    }
    Ok(())
}

/// Route a native menu selection. Most actions go to the focused browser window.
pub(crate) fn handle_menu_event(app: &tauri::AppHandle, event: tauri::menu::MenuEvent) {
    #[cfg(target_os = "macos")]
    if event.id().as_ref() == "shortcut-capture-full-page" {
        let owner = focused_browser_window_label(app).unwrap_or_else(|| "main".to_string());
        let task_app = app.clone();
        let _ = app.emit_to(&owner, CAPTURE_STATUS_EVENT, "Capturing full page…");
        tauri::async_runtime::spawn(async move {
            let state = task_app.state::<BrowserState>();
            let active_tab_id = state.data.lock().ok().and_then(|tabs| {
                tabs.iter()
                    .find(|tab| tab.active && tab.window_label == owner)
                    .map(|tab| tab.id.clone())
            });
            let result = match active_tab_id {
                Some(tab_id) => {
                    save_full_page_screenshot_for_tab(&task_app, &state, &owner, &tab_id).await
                }
                None => Err("There is no active website tab to capture".into()),
            };
            match result {
                Ok(true) => {
                    let _ = task_app.emit_to(
                        &owner,
                        CAPTURE_STATUS_EVENT,
                        "Full page screenshot saved.",
                    );
                }
                Ok(false) => {
                    let _ = task_app.emit_to(&owner, CAPTURE_STATUS_EVENT, "Screenshot cancelled.");
                }
                Err(error) => {
                    let _ = task_app.emit_to(&owner, CAPTURE_STATUS_EVENT, error.clone());
                    use tauri_plugin_dialog::DialogExt;
                    task_app
                        .dialog()
                        .message(error)
                        .title("Full Page Screenshot")
                        .show(|_| {});
                }
            }
        });
        return;
    }
    let Some(window_label) = focused_browser_window_label(app) else {
        return;
    };
    if let Some(position) = event.id().as_ref().strip_prefix("tab-position-") {
        let _ = choose_tab_position_from_menu(app, &window_label, position);
        return;
    }
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
    if event.id().as_ref() == "show-history" || event.id().as_ref() == "history-show-all" {
        let _ = app.emit_to(&window_label, SHOW_HISTORY_EVENT, ());
    }
    if event.id().as_ref() == "clear-history" {
        let _ = app.emit_to(&window_label, CLEAR_HISTORY_REQUEST_EVENT, ());
    }
    if event.id().as_ref() == "import-bookmarks" {
        let _ = app.emit_to(&window_label, IMPORT_BOOKMARKS_EVENT, ());
    }
    if event.id().as_ref() == "export-bookmarks" {
        let _ = app.emit_to(&window_label, EXPORT_BOOKMARKS_EVENT, ());
    }
    let id = event.id().as_ref();
    if let Some(bookmark_id) = id.strip_prefix("bookmark-open-") {
        if let Some(state) = app.try_state::<BrowserState>() {
            if let Ok(database) = database_lock(&state) {
                if let Some(url) = database
                    .as_ref()
                    .and_then(|database| database.bookmark_url(bookmark_id).ok().flatten())
                {
                    let _ = app.emit_to(&window_label, OPEN_URL_FROM_MENU_EVENT, url);
                }
            }
        }
    }
    if let Some(history_id) = id
        .strip_prefix("history-open-")
        .and_then(|id| id.parse::<i64>().ok())
    {
        if let Some(state) = app.try_state::<BrowserState>() {
            if let Ok(database) = database_lock(&state) {
                if let Some(entry) = database
                    .as_ref()
                    .and_then(|database| database.history_entry(history_id).ok())
                {
                    let _ = app.emit_to(&window_label, OPEN_URL_FROM_MENU_EVENT, entry.url);
                }
            }
        }
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
}
