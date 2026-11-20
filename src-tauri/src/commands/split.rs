//! Tab dragging, split view, and moving tabs to new windows.

use crate::*;

#[tauri::command]
pub(crate) fn set_tab_dragging(
    webview: tauri::Webview,
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserState>,
    dragging: bool,
    tab_id: Option<String>,
    target_tab_id: Option<String>,
    drag_type: Option<String>,
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
                            let preview = if drag_type.as_deref() == Some("folder") {
                                platforms::tab_drag_overlay::DragPreviewKind::Folder
                            } else {
                                platforms::tab_drag_overlay::DragPreviewKind::Tab
                            };
                            platforms::tab_drag_overlay::show(native, mtm, preview)
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

#[tauri::command]
pub(crate) fn get_split_tabs(
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
pub(crate) fn split_tab(
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
pub(crate) fn clear_tab_split(
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
pub(crate) fn resize_tab_split(
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
pub(crate) fn move_tab_to_new_window(
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

    let title = if tab.title.is_empty() {
        "Unky"
    } else {
        &tab.title
    };
    let (_, destination) = open_browser_window(&app, &state, title)?;

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
