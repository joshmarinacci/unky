//! Command-line launch requests.

use crate::*;

pub(crate) fn parse_launch_args(
    args: impl IntoIterator<Item = String>,
) -> Result<Option<browser::launch::LaunchRequest>, String> {
    browser::launch::parse_args(args)?
        .map(|mut request| {
            request.url = allowed_navigation_url(&request.url)?.to_string();
            Ok(request)
        })
        .transpose()
}

#[tauri::command]
pub(crate) fn take_launch_request(
    webview: tauri::Webview,
    state: tauri::State<'_, BrowserState>,
) -> Result<Option<browser::launch::LaunchRequest>, String> {
    if !is_trusted_browser_ui(webview.label()) {
        return Err("Launch arguments are only available to the trusted browser UI".into());
    }
    state
        .launch_request
        .lock()
        .map_err(|_| "Launch request is unavailable".to_string())
        .map(|mut request| request.take())
}
