//! Website child WebView creation and layout.

use crate::*;

pub(crate) fn open_url_in_new_tab(
    app: &tauri::AppHandle,
    state: &BrowserState,
    input: &str,
    private: bool,
    owner_window: &str,
    background: bool,
) -> Result<String, String> {
    let parsed = allowed_navigation_url(input)?;
    let number = state.next_id.fetch_add(1, Ordering::Relaxed) + 1;
    let id = format!("tab-{number}");
    let bounds = window_bounds(state, owner_window)?;
    create_page_webview_with_focus(
        app,
        state,
        &id,
        parsed.clone(),
        bounds,
        private,
        owner_window,
        !background,
    )?;
    let mut tabs = state
        .data
        .lock()
        .map_err(|_| "Browser state is unavailable")?;
    for tab in tabs
        .iter_mut()
        .filter(|tab| tab.window_label == owner_window)
    {
        if !background {
            tab.active = false;
        }
    }
    let mut tab = TabState::new_in_window(
        id,
        parsed.to_string(),
        !background,
        private,
        owner_window.to_string(),
    );
    if private {
        tab.record_navigation(parsed.to_string());
    }
    tabs.push(tab);
    emit_snapshot(app, &tabs);
    drop(tabs);
    if !background {
        state
            .split_tabs
            .lock()
            .map_err(|_| "Browser state is unavailable")?
            .remove(owner_window);
        let _ = app.emit_to(owner_window, SPLIT_EVENT, Option::<SplitLayout>::None);
    }
    persist_session(state)?;
    position_tabs(app, state)?;
    Ok(format!("tab-{number}"))
}

pub(crate) fn route_webview_new_window_request(
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
    open_url_in_new_tab(app, state, url, private, &owner_window, false)?;
    Ok(owner_window)
}

pub(crate) fn create_page_webview(
    app: &tauri::AppHandle,
    state: &BrowserState,
    id: &str,
    url: url::Url,
    bounds: ViewBounds,
    private: bool,
    owner_window: &str,
) -> Result<(), String> {
    create_page_webview_with_focus(app, state, id, url, bounds, private, owner_window, true)
}

pub(crate) fn create_page_webview_with_focus(
    app: &tauri::AppHandle,
    state: &BrowserState,
    id: &str,
    url: url::Url,
    bounds: ViewBounds,
    private: bool,
    owner_window: &str,
    focus: bool,
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
    let custom_context_menu_enabled = state
        .page_context_menu_enabled
        .load(std::sync::atomic::Ordering::Acquire);
    let builder = tauri::webview::WebviewBuilder::new(label, WebviewUrl::External(initial_url))
        .incognito(private)
        .focused(focus)
        .initialization_script(include_str!("../page-scripts/error-capture.js"))
        .initialization_script(include_str!("../page-scripts/focus-tracking.js"))
        .initialization_script(&format!(
            "window.__UNKY_CUSTOM_CONTEXT_MENU_ENABLED__ = {custom_context_menu_enabled};"
        ))
        .initialization_script(
            &include_str!("../page-scripts/context-menu.js")
                // Menu labels include tab folder names. Only desktop tests read them from
                // the page DOM, so release builds never write them where the page can see.
                .replace(
                    "EXPOSE_MENU_ITEMS",
                    if cfg!(all(debug_assertions, feature = "desktop-test")) {
                        "true"
                    } else {
                        "false"
                    },
                ),
        )
        .initialization_script(include_str!("../page-scripts/new-tab-links.js"))
        .initialization_script(include_str!("../page-scripts/history-sync.js"))
        .on_navigation({
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
                // WKWebView invokes this policy callback for subframe loads too.
                // A third-party iframe URL must not replace the browser tab's URL;
                // the page-load callback below tracks top-level navigation.
                true
            }
        })
        .on_page_load(move |webview, payload| {
            if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
                let custom_context_menu_enabled = event_app
                    .state::<BrowserState>()
                    .page_context_menu_enabled
                    .load(std::sync::atomic::Ordering::Acquire);
                let _ = webview.eval(&format!(
                    "window.__UNKY_CUSTOM_CONTEXT_MENU_ENABLED__ = {custom_context_menu_enabled};"
                ));
            }
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
    #[cfg(target_os = "linux")]
    {
        platforms::linux::host_page_over_ui(app, &page_label(id))?;
        platforms::linux::install_user_activation_hooks(app, &page_label(id))?;
    }
    Ok(())
}

/// Distance between the shell WebView's CSS viewport origin and the window content origin.
/// AppKit reports it as the WebView's top safe-area inset: the titlebar height in windowed
/// mode and zero in full screen.
#[cfg(target_os = "macos")]
pub(crate) fn titlebar_inset(webview: &tauri::Webview) -> Result<f64, String> {
    let (sender, receiver) = std::sync::mpsc::channel();
    webview
        .with_webview(move |platform| {
            let view = unsafe { &*(platform.inner() as *mut objc2_app_kit::NSView) };
            let _ = sender.send(view.safeAreaInsets().top);
        })
        .map_err(|error| error.to_string())?;
    receiver.recv().map_err(|error| error.to_string())
}

pub(crate) fn adjust_active_zoom(
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
pub(crate) fn native_child_frame(
    page: tauri::Webview,
) -> Result<(objc2_foundation::NSRect, usize), String> {
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

pub(crate) fn position_tabs(app: &tauri::AppHandle, state: &BrowserState) -> Result<(), String> {
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
            // Linux ignores child WebView bounds; place the page in its GTK overlay instead.
            #[cfg(target_os = "linux")]
            platforms::linux::place_page(&page, position, size, is_visible)?;
            #[cfg(not(target_os = "linux"))]
            {
                page.set_position(position).map_err(|e| e.to_string())?;
                page.set_size(size).map_err(|e| e.to_string())?;
            }
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
