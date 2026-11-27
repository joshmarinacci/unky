//! Commands website pages may call (gated by `authorize_page_action`).

use crate::*;

#[tauri::command]
pub(crate) fn get_external_browsers(
    webview: tauri::Webview,
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserState>,
) -> Result<Vec<browser::external::ExternalBrowser>, String> {
    if !is_trusted_browser_ui(webview.label()) && !webview.label().starts_with("page-") {
        return Err("Browser discovery is only available to the trusted browser UI".into());
    }
    // Pages may list browsers only for a context menu the user just opened.
    authorize_page_action(&app, &state, &webview, PageAction::MenuQuery)?;
    browser::external::installed_browsers(&app.config().identifier)
}

#[tauri::command]
pub(crate) async fn open_in_external_browser(
    webview: tauri::Webview,
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserState>,
    tab_id: Option<String>,
    browser_id: String,
    url: Option<String>,
) -> Result<(), String> {
    let page_tab_id = webview.label().strip_prefix("page-");
    let tab_id = tab_id
        .or_else(|| page_tab_id.map(str::to_string))
        .ok_or("The source tab could not be identified")?;
    {
        let tabs = state
            .data
            .lock()
            .map_err(|_| "Browser state is unavailable")?;
        if !tabs.iter().any(|tab| {
            tab.id == tab_id
                && ((is_trusted_browser_ui(webview.label())
                    && tab.window_label == browser_window_for_ui(webview.label()))
                    || page_tab_id == Some(tab.id.as_str()))
        }) {
            return Err("The requested tab does not belong to this browser window".into());
        }
    }
    authorize_page_action(&app, &state, &webview, PageAction::Open)?;
    // Read the actual WebView location, not editable address-bar text.
    let current_url = browser::external::current_page_url(&get_page(&app, &tab_id)?).await;
    let requested_url = url.as_deref().map(allowed_navigation_url).transpose()?;
    let browser = browser::external::installed_browsers(&app.config().identifier)?
        .into_iter()
        .find(|browser| browser.id == browser_id)
        .ok_or("That browser is no longer available; reopen the browser picker")?;
    let url = match requested_url {
        None => current_url?,
        Some(url) if page_tab_id.is_none() => url,
        Some(url) if current_url.as_ref().is_ok_and(|current| *current == url) => url,
        // A page asking to hand a different URL to another browser leaves Unky's private
        // mode and filtering, so the user confirms the exact URL and browser natively.
        Some(url) => {
            confirm_external_link(&app, &webview, &browser.name, &url).await?;
            url
        }
    };

    // Automated tests exercise discovery and validation without opening tabs in the user's browsers.
    #[cfg(all(debug_assertions, feature = "desktop-test"))]
    if std::env::var("UNKY_TEST_EXTERNAL_OPEN").as_deref() == Ok("1") {
        let profile = profile_dir_env().ok_or("Test profile is unavailable")?;
        let request =
            serde_json::json!({ "browserId": browser.id, "url": url.as_str(), "tabId": tab_id });
        fs::write(
            PathBuf::from(profile).join("external-open.json"),
            request.to_string(),
        )
        .map_err(|error| error.to_string())?;
        return Ok(());
    }

    tauri::async_runtime::spawn_blocking(move || browser::external::open(&browser, &url))
        .await
        .map_err(|error| error.to_string())?
}

/// Ask the user before a page hands a link to another browser.
pub(crate) async fn confirm_external_link(
    app: &tauri::AppHandle,
    webview: &tauri::Webview,
    browser_name: &str,
    url: &url::Url,
) -> Result<(), String> {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
    let (sender, receiver) = std::sync::mpsc::channel();
    let dialog = app
        .dialog()
        .message(format!(
            "This page wants to open a link in {browser_name}:\n\n{url}\n\n{browser_name} will use its own cookies and settings, not Unky's private mode or filtering."
        ))
        .title(format!("Open link in {browser_name}?"))
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            format!("Open in {browser_name}"),
            "Cancel".into(),
        ));
    let dialog = dialog.parent(&webview.window());
    dialog.show(move |confirmed| {
        let _ = sender.send(confirmed);
    });
    let confirmed = tauri::async_runtime::spawn_blocking(move || {
        receiver.recv_timeout(Duration::from_secs(300))
    })
    .await
    .map_err(|error| error.to_string())?
    .unwrap_or(false);
    if confirmed {
        Ok(())
    } else {
        Err("Opening the link in another browser was cancelled".into())
    }
}

// WebView creation must leave the IPC callback on Windows so WebView2 can pump messages.
#[tauri::command(async)]
pub(crate) fn open_link_in_new_tab(
    webview: tauri::Webview,
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserState>,
    url: String,
    background: Option<bool>,
    other_split: Option<bool>,
) -> Result<(), String> {
    let (private, owner_window) = link_source_context(&webview, &state)?;
    authorize_page_action(&app, &state, &webview, PageAction::Open)?;
    if other_split.unwrap_or(false) {
        let source_id = webview
            .label()
            .strip_prefix("page-")
            .ok_or("Open in other split is only available from a browser page")?;
        let target_id = {
            let splits = state
                .split_tabs
                .lock()
                .map_err(|_| "Split state is unavailable")?;
            let split = splits
                .get(&owner_window)
                .ok_or("This tab is not in a split view")?;
            split_partner_id(split, source_id)
                .map(str::to_string)
                .ok_or("This tab is not in a split view")?
        };
        let parsed = allowed_navigation_url(&url)?;
        let page = app
            .get_webview(&page_label(&target_id))
            .ok_or("The other split has no page")?;
        {
            let mut tabs = state
                .data
                .lock()
                .map_err(|_| "Browser state is unavailable")?;
            let tab = tabs
                .iter_mut()
                .find(|tab| tab.id == target_id && tab.window_label == owner_window)
                .ok_or("The other split tab no longer exists")?;
            tab.url = parsed.to_string();
            tab.loading = true;
            emit_snapshot(&app, &tabs);
        }
        persist_session(&state)?;
        position_tabs(&app, &state)?;
        return page.navigate(parsed).map_err(|error| error.to_string());
    }
    let tab_id = open_url_in_new_tab(
        &app,
        &state,
        &url,
        private,
        &owner_window,
        background.unwrap_or(false),
    )?;
    // The UI owns tab order (folders live only in its tree), so it places the tab next to its source.
    if let Some(source_id) = webview.label().strip_prefix("page-") {
        app.emit_to(&owner_window, LINK_TAB_OPENED_EVENT, (tab_id, source_id))
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

pub(crate) async fn tab_folders_for_window(
    app: &tauri::AppHandle,
    owner: &str,
) -> Result<Vec<TabFolderMenuEntry>, String> {
    let ui = app
        .get_webview(owner)
        .ok_or("The browser UI is unavailable")?;
    let (sender, receiver) = std::sync::mpsc::channel();
    ui.eval_with_callback(
        r#"JSON.stringify((function walk(nodes) {
          return (Array.isArray(nodes) ? nodes : []).flatMap(node => node?.type === 'folder' && typeof node.id === 'string'
            ? [{ id: node.id, title: String(node.title || 'Folder') }, ...walk(node.children)]
            : []);
        })(JSON.parse(localStorage.getItem('browser.tabTree') || '[]')))"#,
        move |result| { let _ = sender.send(result); },
    ).map_err(|error| error.to_string())?;
    let encoded = tauri::async_runtime::spawn_blocking(move || {
        receiver
            .recv_timeout(Duration::from_secs(3))
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())??;
    let value: serde_json::Value =
        serde_json::from_str(&encoded).map_err(|error| error.to_string())?;
    if let Some(json) = value.as_str() {
        serde_json::from_str(json).map_err(|error| error.to_string())
    } else {
        serde_json::from_value(value).map_err(|error| error.to_string())
    }
}

#[tauri::command(async)]
pub(crate) async fn get_tab_folders(
    webview: tauri::Webview,
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserState>,
) -> Result<Vec<TabFolderMenuEntry>, String> {
    let owner = link_source_context(&webview, &state)?.1;
    // Folder names are personal; pages see them only for a menu the user just opened.
    authorize_page_action(&app, &state, &webview, PageAction::MenuQuery)?;
    tab_folders_for_window(&app, &owner).await
}

#[tauri::command(async)]
pub(crate) async fn open_link_in_tab_folder(
    webview: tauri::Webview,
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserState>,
    url: String,
    folder_id: String,
) -> Result<(), String> {
    let (private, owner) = link_source_context(&webview, &state)?;
    authorize_page_action(&app, &state, &webview, PageAction::Open)?;
    let exists = tab_folders_for_window(&app, &owner)
        .await?
        .iter()
        .any(|folder| folder.id == folder_id);
    if !exists {
        return Err("That tab folder no longer exists".into());
    }
    // Opened in the background so the folder fills without leaving the current tab.
    let tab_id = open_url_in_new_tab(&app, &state, &url, private, &owner, true)?;
    app.emit_to(&owner, "browser://open-tab-in-folder", (tab_id, folder_id))
        .map_err(|error| error.to_string())
}

#[tauri::command(async)]
pub(crate) fn open_link_in_new_window(
    webview: tauri::Webview,
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserState>,
    url: String,
) -> Result<(), String> {
    let (private, _) = link_source_context(&webview, &state)?;
    let parsed = allowed_navigation_url(&url)?;
    authorize_page_action(&app, &state, &webview, PageAction::Open)?;
    let (browser_window, destination) = open_browser_window(&app, &state, "Unky")?;
    if let Err(error) =
        open_url_in_new_tab(&app, &state, parsed.as_str(), private, &destination, false)
    {
        let _ = browser_window.close();
        return Err(error);
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn focus_browser_tab(
    webview: tauri::Webview,
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserState>,
    pointer_down: bool,
) -> Result<(), String> {
    let tab_id = webview
        .label()
        .strip_prefix("page-")
        .ok_or("Only browser pages can request focus")?
        .to_string();
    // A background tab keeps running offscreen; it must not bring itself to the front.
    // Only a tab already on screen in the focused window (such as the other split
    // pane the user clicked) may become the active tab.
    let owner_window = page_tab_visible_owner(&state, &tab_id)?
        .ok_or("Only a tab that is on screen can take focus")?;
    if !browser_window_has_focus(&app, &owner_window) {
        return Err("Only a tab in the focused browser window can take focus".into());
    }
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
    if pointer_down {
        let _ = app.emit_to(&owner_window, PAGE_POINTER_DOWN_EVENT, ());
    }
    position_tabs(&app, &state)
}

#[tauri::command]
pub(crate) fn set_page_context_menu_enabled(
    webview: tauri::Webview,
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserState>,
    enabled: bool,
) -> Result<(), String> {
    if !is_trusted_browser_ui(webview.label()) {
        return Err(
            "Page context-menu settings are only available to the trusted browser UI".into(),
        );
    }
    state
        .page_context_menu_enabled
        .store(enabled, std::sync::atomic::Ordering::Release);
    let tabs = state
        .data
        .lock()
        .map_err(|_| "Browser state is unavailable")?;
    for tab in tabs.iter() {
        if let Some(page) = app.get_webview(&page_label(&tab.id)) {
            let _ = page.eval(&format!(
                "window.__UNKY_CUSTOM_CONTEXT_MENU_ENABLED__ = {enabled};"
            ));
        }
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn sync_page_url(
    webview: tauri::Webview,
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserState>,
    url: String,
    kind: String,
) -> Result<(), String> {
    let label = webview.label();
    let tab_id = label
        .strip_prefix("page-")
        .ok_or("Page URL updates are only available from browser pages")?;
    let current_url = webview.url().map_err(|error| error.to_string())?;
    let parsed_url = allowed_navigation_url(&url)?;
    if parsed_url.origin() != current_url.origin() {
        return Err("Page URL updates must stay on the current origin".into());
    }
    if !matches!(kind.as_str(), "push" | "replace" | "traverse") {
        return Err("Invalid page URL update type".into());
    }

    let mut tabs = state
        .data
        .lock()
        .map_err(|_| "Browser state is unavailable")?;
    let tab = tabs
        .iter_mut()
        .find(|tab| tab.id == tab_id)
        .ok_or("That tab no longer exists")?;
    if tab.url == parsed_url.as_str() {
        return Ok(());
    }
    if kind == "replace" {
        tab.replace_navigation(parsed_url.to_string());
    } else {
        tab.record_navigation(parsed_url.to_string());
    }
    emit_snapshot(&app, &tabs);
    drop(tabs);
    persist_session(&state)
}
