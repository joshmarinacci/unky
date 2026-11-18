//! Address-bar suggestion popup.

use crate::*;

#[derive(Clone, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AddressSuggestionRow {
    url: String,
    title: String,
    source: String,
}

#[tauri::command]
pub(crate) fn control_address_suggestions_popover(
    webview: tauri::Webview,
    app: tauri::AppHandle,
    action: String,
    anchor: SecurityPopoverAnchor,
    rows: Vec<AddressSuggestionRow>,
    selected_index: usize,
) -> Result<(), String> {
    if !is_trusted_browser_ui(webview.label()) {
        return Err("Address suggestions require the trusted browser UI".into());
    }
    if !matches!(action.as_str(), "show" | "close")
        || ![anchor.x, anchor.y, anchor.width, anchor.height]
            .iter()
            .all(|v| v.is_finite())
        || anchor.width <= 0.0
        || anchor.height <= 0.0
        || rows.len() > 8
        || rows
            .iter()
            .any(|row| allowed_navigation_url(&row.url).is_err())
    {
        return Err("Invalid address suggestions request".into());
    }
    let owner = browser_window_for_ui(webview.label());
    let label = format!("address-suggestions-{owner}");
    if action == "close" || rows.is_empty() {
        if let Some(popup) = app.get_webview_window(&label) {
            popup.close().map_err(|error| error.to_string())?;
        }
        return Ok(());
    }
    let owner_window = app
        .get_window(owner)
        .ok_or("Browser window is unavailable")?;
    let scale = owner_window
        .scale_factor()
        .map_err(|error| error.to_string())?;
    let origin = owner_window
        .inner_position()
        .map_err(|error| error.to_string())?;
    #[cfg(target_os = "macos")]
    let viewport_inset = titlebar_inset(&webview)?;
    #[cfg(not(target_os = "macos"))]
    let viewport_inset = 0.0;
    let width = anchor.width.clamp(320.0, 500.0);
    let height = 12.0 + rows.len() as f64 * 48.0;
    let position = tauri::PhysicalPosition::new(
        origin.x + (anchor.x * scale).round() as i32,
        origin.y + ((viewport_inset + anchor.y + anchor.height + 5.0) * scale).round() as i32,
    );
    let payload = serde_json::json!({ "rows": rows, "selectedIndex": selected_index });
    let popup = if let Some(popup) = app.get_webview_window(&label) {
        popup
    } else {
        let encoded: String =
            url::form_urlencoded::byte_serialize(payload.to_string().as_bytes()).collect();
        let page = format!("index.html?page=address-suggestions&owner={owner}&initial={encoded}");
        tauri::WebviewWindowBuilder::new(&app, &label, WebviewUrl::App(page.into()))
            .title("Address suggestions")
            .decorations(false)
            .transparent(true)
            .shadow(false)
            .resizable(false)
            .skip_taskbar(true)
            .always_on_top(true)
            .focusable(false)
            .focused(false)
            .visible(false)
            .inner_size(width, height)
            .build()
            .map_err(|error| error.to_string())?
    };
    popup
        .set_size(tauri::LogicalSize::new(width, height))
        .map_err(|error| error.to_string())?;
    popup
        .set_position(position)
        .map_err(|error| error.to_string())?;
    popup.show().map_err(|error| error.to_string())?;
    let _ = app.emit_to(&label, ADDRESS_SUGGESTIONS_EVENT, payload);
    Ok(())
}

#[tauri::command]
pub(crate) fn select_address_suggestion(
    webview: tauri::Webview,
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserState>,
    url: String,
) -> Result<(), String> {
    let owner = webview
        .label()
        .strip_prefix("address-suggestions-")
        .ok_or("Only the address suggestions popup can select a result")?;
    if owner != "main" && !owner.starts_with("browser-window-") {
        return Err("Invalid browser window".into());
    }
    let parsed = allowed_navigation_url(&url)?;
    let tab_id = state
        .data
        .lock()
        .map_err(|_| "Browser state is unavailable")?
        .iter()
        .find(|tab| tab.window_label == owner && tab.active)
        .map(|tab| tab.id.clone())
        .ok_or("No active tab is available")?;
    let page = get_page_for_window(&app, &state, owner, &tab_id)?;
    {
        let mut tabs = state
            .data
            .lock()
            .map_err(|_| "Browser state is unavailable")?;
        let tab = tabs
            .iter_mut()
            .find(|tab| tab.id == tab_id && tab.window_label == owner)
            .ok_or("That tab no longer exists")?;
        tab.url = parsed.to_string();
        tab.loading = true;
        emit_snapshot(&app, &tabs);
    }
    persist_session(&state)?;
    position_tabs(&app, &state)?;
    page.navigate(parsed).map_err(|error| error.to_string())?;
    if let Some(popup) = app.get_webview_window(webview.label()) {
        let _ = popup.close();
    }
    Ok(())
}
