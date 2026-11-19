//! Tab lifecycle, selection, ordering, and view bounds.

use crate::*;

#[tauri::command]
pub(crate) fn get_browser_state(
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
pub(crate) fn cycle_tab(
    webview: tauri::Webview,
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserState>,
    backwards: bool,
    ordered_tab_ids: Option<Vec<String>>,
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
    if let Some(ordered_ids) = ordered_tab_ids {
        let mut ordered = Vec::with_capacity(local.len());
        for id in ordered_ids {
            if let Some(index) = local.iter().position(|tab| tab.id == id) {
                if !ordered.iter().any(|tab: &TabState| tab.id == id) {
                    ordered.push(local[index].clone());
                }
            }
        }
        for tab in &local {
            if !ordered.iter().any(|existing| existing.id == tab.id) {
                ordered.push(tab.clone());
            }
        }
        local = ordered;
    }
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

#[tauri::command(async)]
pub(crate) fn create_tab(
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
    let blank = url::Url::parse("about:blank").expect("about:blank is a valid URL");
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
pub(crate) fn select_tab(
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
pub(crate) fn reorder_tabs(
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
pub(crate) fn close_tab(
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
        browser::activation::tracker().forget_tab(&tab_id);
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
pub(crate) fn reopen_closed_tab(
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
        url::Url::parse("about:blank").expect("about:blank is a valid URL")
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

#[tauri::command]
pub(crate) fn set_view_bounds(
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
pub(crate) fn set_settings_open(
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

/// Toggle the web inspector of the window's active page.
#[tauri::command]
pub(crate) fn toggle_devtools(
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
