//! Hooks for the macOS session integration test (`macos-session-test`).

use crate::*;

#[tauri::command]
pub(crate) fn session_test_phase(webview: tauri::Webview) -> Result<String, String> {
    if !is_trusted_browser_ui(webview.label()) {
        return Err("Session test controls are only available to the trusted browser UI".into());
    }
    std::env::var("MY_BROWSER_SESSION_TEST_PHASE")
        .map_err(|_| "Session test phase is not configured".into())
}

#[tauri::command]
pub(crate) fn report_session_test(
    webview: tauri::Webview,
    success: bool,
    details: String,
    snapshot: BrowserSnapshot,
) -> Result<(), String> {
    if !is_trusted_browser_ui(webview.label()) {
        return Err("Session test controls are only available to the trusted browser UI".into());
    }
    let report_path = std::env::var_os("MY_BROWSER_SESSION_TEST_REPORT")
        .map(PathBuf::from)
        .ok_or("Session test report path is not configured")?;
    let report =
        serde_json::json!({ "success": success, "details": details, "snapshot": snapshot });
    fs::write(
        report_path,
        serde_json::to_vec_pretty(&report).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) async fn session_test_open_new_tab(
    webview: tauri::Webview,
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserState>,
) -> Result<String, String> {
    if !is_trusted_browser_ui(webview.label()) {
        return Err("Session test controls are only available to the trusted browser UI".into());
    }
    let active_id = state
        .data
        .lock()
        .map_err(|_| "Browser state is unavailable")?
        .iter()
        .find(|tab| tab.active)
        .map(|tab| tab.id.clone())
        .ok_or("No active tab")?;
    let page = get_page(&app, &active_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        page.eval("document.getElementById('new-tab-link').click()")
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())??;
    tauri::async_runtime::spawn_blocking(|| thread::sleep(Duration::from_millis(400)))
        .await
        .map_err(|error| error.to_string())?;
    let page = get_page(&app, &active_id)?;
    let (sender, receiver) = std::sync::mpsc::channel();
    page.eval_with_callback(
        "JSON.stringify({hook:window.__MY_BROWSER_LINK_HOOK__===true,tauri:typeof window.__TAURI_INTERNALS__?.invoke,result:window.__MY_BROWSER_LINK_RESULT__||''})",
        move |result| { let _ = sender.send(result); },
    )
    .map_err(|error| error.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        receiver
            .recv_timeout(Duration::from_secs(2))
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub(crate) async fn session_test_start_download(
    webview: tauri::Webview,
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserState>,
) -> Result<(), String> {
    if !is_trusted_browser_ui(webview.label()) {
        return Err("Session test controls are only available to the trusted browser UI".into());
    }
    let active_id = state
        .data
        .lock()
        .map_err(|_| "Browser state is unavailable")?
        .iter()
        .find(|tab| tab.active)
        .map(|tab| tab.id.clone())
        .ok_or("No active tab")?;
    let page = get_page(&app, &active_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        page.eval("document.getElementById('download-link').click()")
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}
