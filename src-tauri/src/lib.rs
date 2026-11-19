mod browser;
#[cfg(all(feature = "desktop-test", not(debug_assertions)))]
compile_error!("desktop-test is only supported in debug builds");
use browser::database::{BookmarkNode, BrowserDatabase};
use browser::filtering::{FilterSettings, FilterSettingsView};
use browser::tabs::{
    cycle_active_tab, download_filename, find_script, next_download_path, remember_closed_tab,
    snapshot, take_recently_closed, BrowserSnapshot, BrowserState, DownloadEntry, DownloadStatus,
    HistoryEntry, PersistedSession, SessionTab, SplitLayout, SplitOrientation, TabFolderMenuEntry,
    TabState, ViewBounds,
};
use std::sync::{atomic::Ordering, Arc, Mutex, MutexGuard};
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::PathBuf,
    process::Command,
    thread,
    time::Duration,
    time::SystemTime,
};
use tauri::{Emitter, Manager, WebviewUrl};

mod events;
mod platforms;
use events::*;
mod menu;
use menu::*;
mod windows;
use windows::*;
mod page_access;
use page_access::*;
mod webviews;
use webviews::*;
mod session;
use session::*;
mod setup;
use setup::*;
#[cfg(all(debug_assertions, feature = "desktop-test"))]
mod desktop_test;
#[cfg(all(debug_assertions, feature = "desktop-test"))]
use desktop_test::*;
#[cfg(feature = "macos-session-test")]
mod session_test;
#[cfg(feature = "macos-session-test")]
use session_test::*;
mod commands;
use commands::address_suggestions::*;
use commands::downloads::*;
use commands::filtering::*;
use commands::history::*;
use commands::launch::*;
use commands::navigation::*;
use commands::page::*;
use commands::security::*;
use commands::split::*;
use commands::tabs::*;
#[cfg(test)]
mod tests;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let initial_launch_request = parse_launch_args(std::env::args());
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_single_instance::init(
            |app, args, _cwd| match parse_launch_args(args) {
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
                Err(error) => eprintln!("Could not handle unky arguments: {error}"),
            },
        ));
    #[cfg(all(debug_assertions, feature = "desktop-test"))]
    let builder = builder.plugin(tauri_plugin_wdio_webdriver::init());
    #[cfg(all(debug_assertions, feature = "desktop-test"))]
    let builder = builder.plugin(tauri_plugin_wdio::init());
    let builder = builder.manage(TabPositionMenuState::default());
    let builder = builder
        .manage(BrowserState::default())
        .setup(move |app| setup_app(app, initial_launch_request));
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
        set_page_context_menu_enabled,
        sync_tab_position_menu,
        get_history,
        search_history,
        load_bookmarks,
        save_bookmarks,
        clear_history,
        import_bookmarks_html,
        export_bookmarks_html,
        get_downloads,
        find_in_page,
        get_tab_favicon,
        get_page_security_info,
        toggle_page_security_popover,
        update_page_security_popover,
        cycle_tab,
        reveal_download,
        control_downloads_popover,
        control_address_suggestions_popover,
        select_address_suggestion,
        open_link_in_new_tab,
        open_link_in_tab_folder,
        get_tab_folders,
        open_link_in_new_window,
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
        set_page_context_menu_enabled,
        sync_tab_position_menu,
        get_history,
        search_history,
        load_bookmarks,
        save_bookmarks,
        clear_history,
        import_bookmarks_html,
        export_bookmarks_html,
        get_downloads,
        find_in_page,
        get_tab_favicon,
        get_page_security_info,
        toggle_page_security_popover,
        update_page_security_popover,
        cycle_tab,
        reveal_download,
        control_downloads_popover,
        control_address_suggestions_popover,
        select_address_suggestion,
        open_link_in_new_tab,
        open_link_in_tab_folder,
        get_tab_folders,
        open_link_in_new_window,
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
        save_full_page_screenshot,
        desktop_test_inspect_page,
        desktop_test_inspect_tab_drag_overlay,
        desktop_test_show_tab_drag_feedback,
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
        set_page_context_menu_enabled,
        sync_tab_position_menu,
        get_history,
        search_history,
        load_bookmarks,
        save_bookmarks,
        clear_history,
        import_bookmarks_html,
        export_bookmarks_html,
        get_downloads,
        find_in_page,
        get_tab_favicon,
        get_page_security_info,
        toggle_page_security_popover,
        update_page_security_popover,
        cycle_tab,
        reveal_download,
        control_downloads_popover,
        control_address_suggestions_popover,
        select_address_suggestion,
        open_link_in_new_tab,
        open_link_in_tab_folder,
        get_tab_folders,
        open_link_in_new_window,
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
        save_full_page_screenshot
    ]);
    builder
        .on_window_event(|window, event| {
            let label = window.label();
            if label != "main" && !label.starts_with("browser-window-") {
                return;
            }
            let app = window.app_handle();
            if matches!(event, tauri::WindowEvent::Focused(true)) {
                let position = app
                    .state::<TabPositionMenuState>()
                    .by_window
                    .lock()
                    .ok()
                    .and_then(|positions| positions.get(label).cloned())
                    .unwrap_or_else(|| "left".to_string());
                let _ = set_tab_position_menu_checks(app, &position);
            }
            if matches!(event, tauri::WindowEvent::Destroyed) {
                if let Ok(mut positions) = app.state::<TabPositionMenuState>().by_window.lock() {
                    positions.remove(label);
                }
            }
        })
        .on_menu_event(handle_menu_event)
        .run(tauri::generate_context!())
        .expect("error while running browser");
}
