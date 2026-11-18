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
    #[cfg(debug_assertions)]
    let profile_database_path = std::env::var_os("MY_BROWSER_PROFILE_DIR")
        .map(PathBuf::from)
        .map(|path| path.join("browser.sqlite"));
    #[cfg(not(debug_assertions))]
    let profile_database_path: Option<PathBuf> = None;
    #[cfg(feature = "macos-session-test")]
    let session_test_database_path = std::env::var_os("MY_BROWSER_SESSION_TEST_PATH")
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
    let bounds = window_bounds(&state, "main").expect("browser bounds available");
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
        #[cfg(target_os = "macos")]
        let capture_full_page =
            MenuItemBuilder::with_id("shortcut-capture-full-page", "Save Full Page Screenshot…")
                .build(app)?;
        #[cfg(target_os = "macos")]
        let tabs_menu = SubmenuBuilder::new(app, "Tabs")
            .item(&capture_full_page)
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
        let focus_address = MenuItemBuilder::with_id("shortcut-focus-address", "Focus Address Bar")
            .accelerator("CmdOrCtrl+L")
            .build(app)?;
        let show_history = MenuItemBuilder::with_id("show-history", "Show History").build(app)?;
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
        let tab_position_menu = SubmenuBuilder::with_id(app, "tab-position-menu", "Tabs Position")
            .item(&tab_position_left)
            .item(&tab_position_right)
            .item(&tab_position_top)
            .item(&tab_position_bottom)
            .build()?;
        let view_menu = SubmenuBuilder::with_id(app, "view-menu", "View")
            .item(&show_history)
            .item(&show_downloads)
            .separator()
            .item(&tab_position_menu)
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
            .item(&history_menu)
            .item(&help_menu)
            .build()?;
        app.set_menu(menu)?;
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
}
