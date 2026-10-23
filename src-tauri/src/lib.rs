mod browser;
use browser::tabs::{snapshot, BrowserSnapshot, BrowserState, TabState, ViewBounds};
use std::sync::{atomic::Ordering, MutexGuard};
use tauri::{Emitter, Manager, WebviewUrl};

#[cfg(all(target_os = "macos", feature = "macos-interception-test"))]
mod platforms;

const TAB_EVENT: &str = "browser://tabs-changed";
const OPEN_SETTINGS_EVENT: &str = "browser://open-settings";
const SHORTCUT_EVENT: &str = "browser://shortcut";

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
    let label = page_label(id);
    let builder = tauri::webview::WebviewBuilder::new(label, WebviewUrl::External(url))
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
                    emit_snapshot(&event_app, &tabs);
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
                        title
                    };
                    emit_snapshot(&title_app, &tabs);
                }
            }
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
    position_tabs(&app, &state)?;
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
    use super::allowed_navigation_url;

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
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(BrowserState::default())
        .setup(|app| {
            let state = app.state::<BrowserState>();
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
                let file_menu = SubmenuBuilder::new(app, "File")
                    .item(&new_tab)
                    .item(&close_tab)
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
                state
                    .data
                    .lock()
                    .expect("browser state lock poisoned")
                    .push(TabState::new(id, String::new(), true));
                position_tabs(app.handle(), &state).map_err(std::io::Error::other)?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_browser_state,
            create_tab,
            select_tab,
            close_tab,
            navigate,
            go_back,
            go_forward,
            reload,
            stop_loading,
            set_settings_open,
            set_view_bounds
        ])
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
