//! App startup: profile paths, session and history restore, menus, and windows.

use crate::*;

pub(crate) fn setup_app(
    app: &mut tauri::App,
    initial_launch_request: Result<Option<browser::launch::LaunchRequest>, String>,
) -> Result<(), Box<dyn std::error::Error>> {
    #[cfg(all(debug_assertions, feature = "desktop-test"))]
    tauri::WebviewWindowBuilder::new(app, "wdio-host", WebviewUrl::App("index.html".into()))
        .title("Unky WebDriver")
        .inner_size(1200.0, 800.0)
        .visible(false)
        .build()?;
    #[cfg(target_os = "macos")]
    platforms::macos::install_user_activation_monitor();
    let state = app.state::<BrowserState>();
    if let Ok(Some(request)) = initial_launch_request.clone() {
        *state
            .launch_request
            .lock()
            .expect("launch request lock poisoned") = Some(request);
    }
    let session_path = app.path().app_data_dir()?.join("session.json");
    #[cfg(debug_assertions)]
    let session_path = profile_dir_env()
        .map(PathBuf::from)
        .map(|path| path.join("session.json"))
        .unwrap_or(session_path);
    #[cfg(feature = "macos-session-test")]
    let session_path = std::env::var_os("UNKY_SESSION_TEST_PATH")
        .map(PathBuf::from)
        .unwrap_or(session_path);
    *state
        .session_file
        .lock()
        .expect("session path lock poisoned") = Some(session_path.clone());
    #[cfg(debug_assertions)]
    let profile_database_path = profile_dir_env()
        .map(PathBuf::from)
        .map(|path| path.join("browser.sqlite"));
    #[cfg(not(debug_assertions))]
    let profile_database_path: Option<PathBuf> = None;
    #[cfg(feature = "macos-session-test")]
    let session_test_database_path = std::env::var_os("UNKY_SESSION_TEST_PATH")
        .map(PathBuf::from)
        .and_then(|path| path.parent().map(|parent| parent.join("browser.sqlite")));
    #[cfg(not(feature = "macos-session-test"))]
    let session_test_database_path: Option<PathBuf> = None;
    let database_path = std::env::var_os("UNKY_DATABASE_PATH")
        .map(PathBuf::from)
        .or(session_test_database_path)
        .or(profile_database_path)
        .unwrap_or(app.path().app_data_dir()?.join("browser.sqlite"));
    let history_path = session_path.with_file_name("history.json");
    let mut database = BrowserDatabase::open(&database_path).map_err(std::io::Error::other)?;
    database
        .import_history_once(&read_legacy_history(&history_path))
        .map_err(std::io::Error::other)?;
    let history = database
        .history(None, 10_000)
        .map_err(std::io::Error::other)?;
    *state.database.lock().expect("database lock poisoned") = Some(database);
    *state.history.lock().expect("history lock poisoned") = history;
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
    let bounds = window_bounds(&state, "main").map_err(std::io::Error::other)?;
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        use tauri::menu::{CheckMenuItemBuilder, MenuBuilder, MenuItemBuilder, SubmenuBuilder};
        let settings = MenuItemBuilder::with_id("open-settings", "Settings…")
            .accelerator("CmdOrCtrl+,")
            .build(app)?;
        #[cfg(target_os = "macos")]
        let about = MenuItemBuilder::with_id("show-about", "About Unky").build(app)?;
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
        let new_window = MenuItemBuilder::with_id("shortcut-new-window", "New Window")
            .accelerator("CmdOrCtrl+N")
            .build(app)?;
        let close_window = MenuItemBuilder::with_id("shortcut-close-window", "Close Window")
            .accelerator("CmdOrCtrl+Shift+W")
            .build(app)?;
        let print = MenuItemBuilder::with_id("shortcut-print", "Print…")
            .accelerator("CmdOrCtrl+P")
            .build(app)?;
        let file_menu = SubmenuBuilder::new(app, "File")
            .item(&new_tab)
            .item(&new_window)
            .item(&new_private_tab);
        #[cfg(target_os = "macos")]
        let file_menu = file_menu.item(&open_in_browser);
        let file_menu = file_menu
            .item(&close_tab)
            .item(&close_window)
            .item(&reopen_closed_tab)
            .item(&next_tab)
            .item(&previous_tab);
        #[cfg(not(target_os = "macos"))]
        let file_menu = file_menu.item(&next_tab_page).item(&previous_tab_page);
        #[cfg(target_os = "macos")]
        let file_menu = file_menu.item(&next_tab_mac).item(&previous_tab_mac);
        #[cfg(target_os = "macos")]
        let file_menu = file_menu.item(&next_tab_safari).item(&previous_tab_safari);
        let file_menu = file_menu.separator().item(&print);
        #[cfg(not(target_os = "macos"))]
        let file_menu = file_menu.separator().item(&settings).separator().quit();
        let file_menu = file_menu.build()?;
        #[cfg(target_os = "macos")]
        let capture_full_page =
            MenuItemBuilder::with_id("shortcut-capture-full-page", "Save Full Page Screenshot…")
                .build(app)?;
        // ⌘1–⌘8 pick a tab by position and ⌘9 picks the last one, as in Safari and Chrome.
        // Windows handles Ctrl+1–9 in the UI key handler and the page-view table instead.
        #[cfg(target_os = "macos")]
        let mut select_tab_items = Vec::new();
        #[cfg(target_os = "macos")]
        for number in 1..=8 {
            select_tab_items.push(
                MenuItemBuilder::with_id(
                    format!("shortcut-select-tab-{number}"),
                    format!("Select Tab {number}"),
                )
                .accelerator(format!("CmdOrCtrl+{number}"))
                .build(app)?,
            );
        }
        #[cfg(target_os = "macos")]
        select_tab_items.push(
            MenuItemBuilder::with_id("shortcut-select-last-tab", "Select Last Tab")
                .accelerator("CmdOrCtrl+9")
                .build(app)?,
        );
        #[cfg(target_os = "macos")]
        let tabs_menu = {
            let mut tabs_menu = SubmenuBuilder::new(app, "Tabs")
                .item(&capture_full_page)
                .separator();
            for item in &select_tab_items {
                tabs_menu = tabs_menu.item(item);
            }
            tabs_menu.build()?
        };
        #[cfg(target_os = "macos")]
        let window_menu = SubmenuBuilder::new(app, "Window")
            .minimize()
            .maximize()
            .separator()
            .bring_all_to_front()
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
        // Plain ⌘= like Safari and Chrome: the key is labeled "+" but needs no Shift.
        let zoom_in = MenuItemBuilder::with_id("zoom-in", "Zoom In")
            .accelerator("CmdOrCtrl+=")
            .build(app)?;
        let zoom_out = MenuItemBuilder::with_id("zoom-out", "Zoom Out")
            .accelerator("CmdOrCtrl+-")
            .build(app)?;
        let actual_size = MenuItemBuilder::with_id("zoom-reset", "Actual Size")
            .accelerator("CmdOrCtrl+0")
            .build(app)?;
        let focus_address = MenuItemBuilder::with_id("shortcut-focus-address", "Focus Address Bar")
            .accelerator("CmdOrCtrl+L")
            .build(app)?;
        let show_history = MenuItemBuilder::with_id("show-history", "Show History").build(app)?;
        let show_downloads = MenuItemBuilder::with_id("show-downloads", "Show Downloads");
        // ⌥⌘L shows downloads in Safari and Chrome.
        #[cfg(target_os = "macos")]
        let show_downloads = show_downloads.accelerator("CmdOrCtrl+Alt+L");
        let show_downloads = show_downloads.build(app)?;
        let stop_loading = MenuItemBuilder::with_id("shortcut-stop-loading", "Stop")
            .accelerator("CmdOrCtrl+.")
            .build(app)?;
        let find = MenuItemBuilder::with_id("shortcut-find", "Find in Page")
            .accelerator("CmdOrCtrl+F")
            .build(app)?;
        let reload = MenuItemBuilder::with_id("shortcut-reload", "Reload Page")
            .accelerator("CmdOrCtrl+R")
            .build(app)?;
        let find_next = MenuItemBuilder::with_id("shortcut-find-next", "Find Next")
            .accelerator("CmdOrCtrl+G")
            .build(app)?;
        let find_previous = MenuItemBuilder::with_id("shortcut-find-previous", "Find Previous")
            .accelerator("CmdOrCtrl+Shift+G")
            .build(app)?;
        // Chrome uses ⇧⌘R and Safari ⌥⌘R; both reload without the cache.
        let reload_ignoring_cache =
            MenuItemBuilder::with_id("shortcut-reload-ignoring-cache", "Reload Ignoring Cache")
                .accelerator("CmdOrCtrl+Shift+R")
                .build(app)?;
        #[cfg(target_os = "macos")]
        let reload_ignoring_cache_safari = MenuItemBuilder::with_id(
            "shortcut-reload-ignoring-cache-safari",
            "Reload Ignoring Cache (Safari)",
        )
        .accelerator("CmdOrCtrl+Alt+R")
        .build(app)?;
        let toggle_sidebar =
            MenuItemBuilder::with_id("shortcut-toggle-sidebar", "Show/Hide Sidebar")
                .accelerator("CmdOrCtrl+Shift+L")
                .build(app)?;
        let view_source = MenuItemBuilder::with_id("shortcut-view-source", "View Source")
            .accelerator(if cfg!(target_os = "macos") {
                "CmdOrCtrl+Alt+U"
            } else {
                "Ctrl+U"
            })
            .build(app)?;
        let toggle_devtools = MenuItemBuilder::with_id("shortcut-toggle-devtools", "Web Inspector")
            .accelerator(if cfg!(target_os = "macos") {
                "CmdOrCtrl+Alt+I"
            } else {
                "Ctrl+Shift+I"
            })
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
        let tab_position_left = CheckMenuItemBuilder::with_id("tab-position-left", "Left")
            .checked(true)
            .build(app)?;
        let tab_position_right = CheckMenuItemBuilder::with_id("tab-position-right", "Right")
            .checked(false)
            .build(app)?;
        let tab_position_top = CheckMenuItemBuilder::with_id("tab-position-top", "Top")
            .checked(false)
            .build(app)?;
        let tab_position_bottom = CheckMenuItemBuilder::with_id("tab-position-bottom", "Bottom")
            .checked(false)
            .build(app)?;
        let mut theme_menu = SubmenuBuilder::with_id(app, "theme-menu", "Appearance");
        for (theme, label) in THEME_MENU_OPTIONS {
            let item = CheckMenuItemBuilder::with_id(format!("theme-{theme}"), label)
                .checked(theme == "system")
                .build(app)?;
            theme_menu = theme_menu.item(&item);
        }
        let theme_menu = theme_menu.build()?;
        let tab_position_menu = SubmenuBuilder::with_id(app, "tab-position-menu", "Tabs Position")
            .item(&tab_position_left)
            .item(&tab_position_right)
            .item(&tab_position_top)
            .item(&tab_position_bottom)
            .build()?;
        let view_menu = SubmenuBuilder::with_id(app, "view-menu", "View")
            .item(&show_history)
            .item(&show_downloads)
            .item(&toggle_sidebar)
            .separator()
            .item(&theme_menu)
            .item(&tab_position_menu)
            .separator()
            .item(&focus_address)
            .item(&find)
            .item(&find_next)
            .item(&find_previous)
            .item(&reload)
            .item(&reload_ignoring_cache);
        #[cfg(target_os = "macos")]
        let view_menu = view_menu.item(&reload_ignoring_cache_safari);
        let view_menu = view_menu
            .item(&stop_loading)
            .item(&go_back)
            .item(&go_forward)
            .separator()
            .item(&zoom_in)
            .item(&zoom_out)
            .separator()
            .item(&actual_size)
            .separator()
            .item(&view_source)
            .item(&toggle_devtools);
        #[cfg(target_os = "macos")]
        let view_menu = view_menu.separator().fullscreen();
        let view_menu = view_menu.build()?;
        let bookmarks_menu = SubmenuBuilder::with_id(app, "bookmarks-menu", "Bookmarks").build()?;
        let history_menu = SubmenuBuilder::with_id(app, "history-menu", "History").build()?;
        let show_shortcuts =
            MenuItemBuilder::with_id("show-shortcuts", "Show Shortcuts").build(app)?;
        let help_menu = SubmenuBuilder::new(app, "Help")
            .item(&show_shortcuts)
            .build()?;
        let menu = MenuBuilder::new(app);
        #[cfg(target_os = "macos")]
        let menu = menu.item(&app_menu);
        let menu = menu.item(&file_menu);
        #[cfg(target_os = "macos")]
        let menu = menu.item(&tabs_menu);
        let menu = menu
            .item(&edit_menu)
            .item(&view_menu)
            .item(&bookmarks_menu)
            .item(&history_menu);
        #[cfg(target_os = "macos")]
        let menu = menu.item(&window_menu);
        let menu = menu.item(&help_menu).build()?;
        app.set_menu(menu)?;
        #[cfg(target_os = "macos")]
        platforms::menu_keys::normalize_shift_key_equivalents();
        refresh_browser_menus(app.handle(), &state).map_err(std::io::Error::other)?;
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
                url::Url::parse("about:blank").expect("about:blank is a valid URL")
            } else {
                // `validated_session_tab` already accepted this URL; skip the tab rather than
                // stop startup if re-parsing its normalized form ever disagrees.
                match allowed_navigation_url(&saved.url) {
                    Ok(url) => url,
                    Err(error) => {
                        eprintln!("Skipping saved tab {}: {error}", saved.id);
                        continue;
                    }
                }
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
                url::Url::parse("about:blank").expect("about:blank is a valid URL"),
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
    if let Some(profile) = profile_dir_env().map(PathBuf::from) {
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
}
