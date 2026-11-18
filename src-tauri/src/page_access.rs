//! URL validation and the native-gesture gate for page-callable commands.

use crate::*;

pub(crate) fn allowed_navigation_url(input: &str) -> Result<url::Url, String> {
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

/// What a website page is asking to do, which sets how much proof of user intent it needs.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum PageAction {
    /// Read data for a menu the user just opened (tab folders, installed browsers).
    MenuQuery,
    /// Open a tab, window, other split, or external browser. Spends the gesture.
    Open,
}

/// Website pages can call their granted commands from any script, so a page-reported
/// click proves nothing. Require that the calling tab is on screen, its window has
/// focus, and the platform saw real input within the last second. Calls from the
/// trusted browser UI are not gated.
pub(crate) fn authorize_page_action(
    app: &tauri::AppHandle,
    state: &BrowserState,
    webview: &tauri::Webview,
    action: PageAction,
) -> Result<(), String> {
    use browser::activation;
    let Some(tab_id) = webview.label().strip_prefix("page-") else {
        return Ok(());
    };
    let owner = page_tab_visible_owner(state, tab_id)?
        .ok_or("This action is only available from a tab that is on screen")?;
    if !browser_window_has_focus(app, &owner) {
        return Err("This action is only available in the focused browser window".into());
    }
    if !activation::page_has_gesture() {
        return Err("This action needs a click or key press on the page".into());
    }
    let (bucket, limit) = match action {
        PageAction::MenuQuery => ("query", activation::PAGE_QUERY_LIMIT),
        PageAction::Open => ("open", activation::PAGE_OPEN_LIMIT),
    };
    if !activation::page_rate_allows(bucket, tab_id, limit) {
        return Err("This page is opening too much too quickly; try again shortly".into());
    }
    if action == PageAction::Open && !activation::page_consume_gesture() {
        return Err("This action needs a click or key press on the page".into());
    }
    Ok(())
}

/// The owning window label when the tab is visible: active, or half of the split
/// that holds its window's active tab, with Settings closed.
pub(crate) fn page_tab_visible_owner(
    state: &BrowserState,
    tab_id: &str,
) -> Result<Option<String>, String> {
    let splits = state
        .split_tabs
        .lock()
        .map_err(|_| "Split state is unavailable")?;
    let settings_open = state
        .settings_open
        .lock()
        .map_err(|_| "Browser state is unavailable")?;
    let tabs = state
        .data
        .lock()
        .map_err(|_| "Browser state is unavailable")?;
    let Some(tab) = tabs.iter().find(|tab| tab.id == tab_id) else {
        return Ok(None);
    };
    let visible = browser::tabs::is_tab_visible(
        &tabs,
        splits.get(&tab.window_label),
        settings_open.contains(&tab.window_label),
        tab_id,
    );
    Ok(visible.then(|| tab.window_label.clone()))
}

pub(crate) fn browser_window_has_focus(app: &tauri::AppHandle, window_label: &str) -> bool {
    #[cfg(all(debug_assertions, feature = "desktop-test"))]
    if desktop_test_gesture_is_live() {
        return true;
    }
    app.get_window(window_label)
        .and_then(|window| window.is_focused().ok())
        .unwrap_or(false)
}

pub(crate) fn link_source_context(
    webview: &tauri::Webview,
    state: &BrowserState,
) -> Result<(bool, String), String> {
    let tabs = state
        .data
        .lock()
        .map_err(|_| "Browser state is unavailable")?;
    if is_trusted_browser_ui(webview.label()) {
        let owner = browser_window_for_ui(webview.label());
        let private = tabs
            .iter()
            .find(|tab| tab.window_label == owner && tab.active)
            .is_some_and(|tab| tab.private);
        return Ok((private, owner.to_string()));
    }
    tabs.iter()
        .find(|tab| page_label(&tab.id) == webview.label())
        .map(|tab| (tab.private, tab.window_label.clone()))
        .ok_or_else(|| {
            "Links can only be opened from a browser page or the trusted browser UI".into()
        })
}

pub(crate) fn split_partner_id<'a>(split: &'a SplitLayout, source_id: &str) -> Option<&'a str> {
    if split.first_tab_id == source_id {
        Some(&split.second_tab_id)
    } else if split.second_tab_id == source_id {
        Some(&split.first_tab_id)
    } else {
        None
    }
}
