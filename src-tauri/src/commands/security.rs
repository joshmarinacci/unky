//! Page security info and its native popover.

use crate::*;

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PageSecurityInfo {
    origin: String,
    secure_https: bool,
    location: String,
    camera: String,
    microphone: String,
    playing_audio: bool,
}

#[tauri::command]
pub(crate) async fn get_page_security_info(
    webview: tauri::Webview,
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserState>,
    tab_id: String,
) -> Result<PageSecurityInfo, String> {
    if !is_trusted_browser_ui(webview.label()) {
        return Err("Security information is only available to the trusted browser UI".into());
    }
    let page = get_page_for_window(&app, &state, webview.label(), &tab_id)?;
    // Permissions.query() is asynchronous in WebKit, while eval_with_callback returns
    // immediately. Cache its result in the page and read that cache on subsequent polls.
    let script = include_str!("../../page-scripts/security-info.js");
    let (sender, receiver) = std::sync::mpsc::channel();
    page.eval_with_callback(script, move |result| {
        let _ = sender.send(result);
    })
    .map_err(|error| error.to_string())?;
    let result = tauri::async_runtime::spawn_blocking(move || {
        receiver.recv().map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())??;
    // WebKit's callback result encodes the string value as JSON, hence two parses.
    let encoded: String = serde_json::from_str(&result).map_err(|error| error.to_string())?;
    serde_json::from_str(&encoded).map_err(|error| error.to_string())
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SecurityPopoverAnchor {
    pub(crate) x: f64,
    pub(crate) y: f64,
    pub(crate) width: f64,
    pub(crate) height: f64,
}

#[cfg(target_os = "macos")]
pub(crate) fn security_popover_inputs(
    anchor: SecurityPopoverAnchor,
    info: PageSecurityInfo,
) -> (
    platforms::security_popover::AnchorRect,
    platforms::security_popover::SecurityInfo,
) {
    (
        platforms::security_popover::AnchorRect {
            x: anchor.x,
            y: anchor.y,
            width: anchor.width,
            height: anchor.height,
        },
        platforms::security_popover::SecurityInfo {
            origin: info.origin,
            secure_https: info.secure_https,
            location: info.location,
            camera: info.camera,
            microphone: info.microphone,
            playing_audio: info.playing_audio,
        },
    )
}

#[tauri::command]
pub(crate) async fn toggle_page_security_popover(
    webview: tauri::Webview,
    app: tauri::AppHandle,
    anchor: SecurityPopoverAnchor,
    info: PageSecurityInfo,
) -> Result<bool, String> {
    if !is_trusted_browser_ui(webview.label()) {
        return Err("Security popovers are only available to the trusted browser UI".into());
    }
    #[cfg(target_os = "macos")]
    {
        let main = app
            .get_webview("main")
            .ok_or("Browser window is unavailable")?;
        let (anchor, info) = security_popover_inputs(anchor, info);
        let inset = titlebar_inset(&main)?;
        let (sender, receiver) = std::sync::mpsc::channel();
        main.with_webview(move |platform| {
            let shown = unsafe {
                platforms::security_popover::toggle(platform.inner(), anchor, info, inset)
            };
            let _ = sender.send(shown);
        })
        .map_err(|error| error.to_string())?;
        return tauri::async_runtime::spawn_blocking(move || {
            receiver.recv().map_err(|error| error.to_string())
        })
        .await
        .map_err(|error| error.to_string())?;
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, anchor, info);
        Err("Native security popovers are currently available on macOS only".into())
    }
}

#[tauri::command]
pub(crate) async fn update_page_security_popover(
    webview: tauri::Webview,
    app: tauri::AppHandle,
    anchor: SecurityPopoverAnchor,
    info: PageSecurityInfo,
) -> Result<bool, String> {
    if !is_trusted_browser_ui(webview.label()) {
        return Err("Security popovers are only available to the trusted browser UI".into());
    }
    #[cfg(target_os = "macos")]
    {
        let main = app
            .get_webview("main")
            .ok_or("Browser window is unavailable")?;
        let (anchor, info) = security_popover_inputs(anchor, info);
        let inset = titlebar_inset(&main)?;
        let (sender, receiver) = std::sync::mpsc::channel();
        main.with_webview(move |platform| {
            let shown = unsafe {
                platforms::security_popover::update(platform.inner(), anchor, info, inset)
            };
            let _ = sender.send(shown);
        })
        .map_err(|error| error.to_string())?;
        return tauri::async_runtime::spawn_blocking(move || {
            receiver.recv().map_err(|error| error.to_string())
        })
        .await
        .map_err(|error| error.to_string())?;
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, anchor, info);
        Err("Native security popovers are currently available on macOS only".into())
    }
}
