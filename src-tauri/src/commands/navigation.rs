//! Navigation, find, favicon, and full-page screenshots.

use crate::*;

#[tauri::command]
pub(crate) async fn find_in_page(
    webview: tauri::Webview,
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserState>,
    tab_id: String,
    query: String,
    backwards: bool,
) -> Result<usize, String> {
    if !is_trusted_browser_ui(webview.label()) {
        return Err("Find is only available to the trusted browser UI".into());
    }
    let page = get_page_for_window(&app, &state, webview.label(), &tab_id)?;
    let (sender, receiver) = std::sync::mpsc::channel();
    page.eval_with_callback(find_script(&query, backwards), move |result| {
        let _ = sender.send(result);
    })
    .map_err(|error| error.to_string())?;
    let result = tauri::async_runtime::spawn_blocking(move || {
        receiver.recv().map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())??;
    serde_json::from_str(&result).map_err(|error| error.to_string())
}

/// A tab's HTML for View Source. `original` is false when the download failed and `source` is the
/// page's current DOM instead.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PageSource {
    url: String,
    source: String,
    original: bool,
}

/// The largest page View Source downloads or shows.
pub(crate) const PAGE_SOURCE_LIMIT: usize = 5 * 1024 * 1024;

/// View Source downloads only web pages again; other schemes use the live DOM.
pub(crate) fn should_download_source(url: &url::Url) -> bool {
    matches!(url.scheme(), "http" | "https")
}

/// Serializes the page's doctype and root element, for when the original can't be downloaded.
pub(crate) const PAGE_DOM_SOURCE_SCRIPT: &str = r#"(() => {
    const doctype = document.doctype ? new XMLSerializer().serializeToString(document.doctype) + '\n' : '';
    return doctype + (document.documentElement ? document.documentElement.outerHTML : '');
})()"#;

/// Download the page again, as Chrome's View Source does. The request carries no cookies, so a
/// signed-in page may differ from what the tab shows. The URL is the one the tab already loaded.
async fn download_page_source(url: &url::Url) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::limited(5))
        .user_agent(concat!(
            "Mozilla/5.0 (Macintosh) Unky/",
            env!("CARGO_PKG_VERSION")
        ))
        .build()
        .map_err(|error| error.to_string())?;
    let response = client
        .get(url.as_str())
        .send()
        .await
        .map_err(|error| error.to_string())?;
    if !response.status().is_success() {
        return Err(format!("the server answered {}", response.status()));
    }
    if response
        .content_length()
        .is_some_and(|length| length > PAGE_SOURCE_LIMIT as u64)
    {
        return Err("the page is too large".into());
    }
    let bytes = response.bytes().await.map_err(|error| error.to_string())?;
    if bytes.len() > PAGE_SOURCE_LIMIT {
        return Err("the page is too large".into());
    }
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

/// ⌥⌘U: the active page's HTML, downloaded again, or its live DOM when that fails.
#[tauri::command]
pub(crate) async fn get_page_source(
    webview: tauri::Webview,
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserState>,
    tab_id: String,
) -> Result<PageSource, String> {
    if !is_trusted_browser_ui(webview.label()) {
        return Err("View Source is only available to the trusted browser UI".into());
    }
    let page = get_page_for_window(&app, &state, webview.label(), &tab_id)?;
    let url = page.url().map_err(|error| error.to_string())?;
    if should_download_source(&url) {
        match download_page_source(&url).await {
            Ok(source) => {
                return Ok(PageSource {
                    url: url.to_string(),
                    source,
                    original: true,
                })
            }
            Err(error) => eprintln!("View Source download failed for {url}: {error}"),
        }
    }
    let (sender, receiver) = std::sync::mpsc::channel();
    page.eval_with_callback(PAGE_DOM_SOURCE_SCRIPT, move |result| {
        let _ = sender.send(result);
    })
    .map_err(|error| error.to_string())?;
    let result = tauri::async_runtime::spawn_blocking(move || {
        receiver.recv().map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())??;
    let mut source: String = serde_json::from_str(&result).map_err(|error| error.to_string())?;
    if source.len() > PAGE_SOURCE_LIMIT {
        let mut end = PAGE_SOURCE_LIMIT;
        while !source.is_char_boundary(end) {
            end -= 1;
        }
        source.truncate(end);
    }
    Ok(PageSource {
        url: url.to_string(),
        source,
        original: false,
    })
}

#[tauri::command]
pub(crate) async fn get_tab_favicon(
    webview: tauri::Webview,
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserState>,
    tab_id: String,
) -> Result<String, String> {
    if !is_trusted_browser_ui(webview.label()) {
        return Err("Favicons are only available to the trusted browser UI".into());
    }
    let page = get_page_for_window(&app, &state, webview.label(), &tab_id)?;
    let page_url = state
        .data
        .lock()
        .map_err(|_| "Browser state is unavailable")?
        .iter()
        .find(|tab| tab.id == tab_id)
        .map(|tab| tab.url.clone())
        .unwrap_or_default();
    let script = include_str!("../../page-scripts/favicon-url.js");
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
    let icon_url: String = serde_json::from_str(&result).map_err(|error| error.to_string())?;
    if icon_url.is_empty() || page_url.is_empty() {
        return Ok(icon_url);
    }
    let cached = database_lock(&state)?
        .as_ref()
        .ok_or_else(|| "Browser database is unavailable".to_string())?
        .favicon(&page_url)?;
    if cached
        .as_ref()
        .is_some_and(|cached| cached.icon_url == icon_url && cached.data_url.is_some())
    {
        return Ok(icon_url);
    }

    let mut mime_type = None;
    let mut data_url: Option<String> = None;
    if icon_url.starts_with("data:image/") && icon_url.len() <= 512 * 1024 {
        mime_type = icon_url
            .split_once(':')
            .and_then(|(_, remainder)| remainder.split([';', ',']).next())
            .map(str::to_string);
        data_url = Some(icon_url.clone());
    } else if let (Ok(page_url_parsed), Ok(icon_url_parsed)) =
        (url::Url::parse(&page_url), url::Url::parse(&icon_url))
    {
        // Only fetch same-origin icons in the native process. This avoids turning a
        // page-provided icon URL into a request to local network services.
        if matches!(icon_url_parsed.scheme(), "http" | "https")
            && page_url_parsed.origin() == icon_url_parsed.origin()
        {
            let client = reqwest::Client::builder()
                .timeout(Duration::from_secs(4))
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .map_err(|error| error.to_string())?;
            if let Ok(response) = client.get(&icon_url).send().await {
                let response_mime = response
                    .headers()
                    .get(reqwest::header::CONTENT_TYPE)
                    .and_then(|value| value.to_str().ok())
                    .and_then(|value| value.split(';').next())
                    .map(str::trim)
                    .filter(|value| value.starts_with("image/"))
                    .map(str::to_string);
                let size_allowed = response
                    .content_length()
                    .map(|length| length <= 512 * 1024)
                    .unwrap_or(true);
                if response.status().is_success() && size_allowed {
                    if let (Some(response_mime), Ok(bytes)) =
                        (response_mime, response.bytes().await)
                    {
                        if !bytes.is_empty() && bytes.len() <= 512 * 1024 {
                            use base64::Engine;
                            data_url = Some(format!(
                                "data:{response_mime};base64,{}",
                                base64::engine::general_purpose::STANDARD.encode(&bytes)
                            ));
                            mime_type = Some(response_mime);
                        }
                    }
                }
            }
        }
    }
    database_lock(&state)?
        .as_ref()
        .ok_or_else(|| "Browser database is unavailable".to_string())?
        .save_favicon(
            &page_url,
            &icon_url,
            mime_type.as_deref(),
            data_url.as_deref(),
        )?;
    if data_url.is_some() {
        if let Ok(history) = current_history(&state) {
            if let Ok(mut saved) = state.history.lock() {
                *saved = history.clone();
            }
            emit_history(&app, &history);
        }
        let _ = emit_bookmarks(&app, &state);
    } else {
        let _ = refresh_browser_menus(&app, &state);
    }
    Ok(icon_url)
}

#[tauri::command]
pub(crate) fn navigate(
    webview: tauri::Webview,
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserState>,
    tab_id: String,
    url: String,
) -> Result<(), String> {
    if !is_trusted_browser_ui(webview.label()) {
        return Err("Navigation is only available from the trusted browser UI".into());
    }
    let parsed = allowed_navigation_url(&url)?;
    let owner_window = browser_window_for_ui(webview.label()).to_string();
    let page = get_page_for_window(&app, &state, &owner_window, &tab_id)?;
    {
        let mut tabs = state
            .data
            .lock()
            .map_err(|_| "Browser state is unavailable")?;
        let tab = tabs
            .iter_mut()
            .find(|tab| tab.id == tab_id && tab.window_label == owner_window)
            .ok_or("That tab no longer exists")?;
        tab.url = parsed.to_string();
        tab.loading = true;
        emit_snapshot(&app, &tabs);
    }
    persist_session(&state)?;
    position_tabs(&app, &state)?;
    page.navigate(parsed).map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn go_back(
    webview: tauri::Webview,
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserState>,
    tab_id: String,
) -> Result<(), String> {
    if !is_trusted_browser_ui(webview.label()) {
        return Err("Navigation is only available from the trusted browser UI".into());
    }
    let page = get_page_for_window(&app, &state, webview.label(), &tab_id)?;
    let mut tabs = state
        .data
        .lock()
        .map_err(|_| "Browser state is unavailable")?;
    let tab = tabs
        .iter_mut()
        .find(|tab| tab.id == tab_id && tab.window_label == browser_window_for_ui(webview.label()))
        .ok_or("That tab no longer exists")?;
    if tab.move_history(false).is_some() {
        page.eval("history.back()").map_err(|e| e.to_string())?;
    }
    emit_snapshot(&app, &tabs);
    drop(tabs);
    persist_session(&state)?;
    Ok(())
}

#[tauri::command]
pub(crate) fn go_forward(
    webview: tauri::Webview,
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserState>,
    tab_id: String,
) -> Result<(), String> {
    if !is_trusted_browser_ui(webview.label()) {
        return Err("Navigation is only available from the trusted browser UI".into());
    }
    let page = get_page_for_window(&app, &state, webview.label(), &tab_id)?;
    let mut tabs = state
        .data
        .lock()
        .map_err(|_| "Browser state is unavailable")?;
    let tab = tabs
        .iter_mut()
        .find(|tab| tab.id == tab_id && tab.window_label == browser_window_for_ui(webview.label()))
        .ok_or("That tab no longer exists")?;
    if tab.move_history(true).is_some() {
        page.eval("history.forward()").map_err(|e| e.to_string())?;
    }
    emit_snapshot(&app, &tabs);
    drop(tabs);
    persist_session(&state)?;
    Ok(())
}

#[tauri::command]
pub(crate) fn reload(
    webview: tauri::Webview,
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserState>,
    tab_id: String,
) -> Result<(), String> {
    if !is_trusted_browser_ui(webview.label()) {
        return Err("Navigation is only available from the trusted browser UI".into());
    }
    get_page_for_window(&app, &state, webview.label(), &tab_id)?
        .reload()
        .map_err(|e| e.to_string())
}

/// ⇧⌘R / ⌥⌘R: reload without using cached responses. WKWebView revalidates every resource with
/// the server; other platforms fall back to a normal reload.
#[tauri::command]
pub(crate) fn reload_ignoring_cache(
    webview: tauri::Webview,
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserState>,
    tab_id: String,
) -> Result<(), String> {
    if !is_trusted_browser_ui(webview.label()) {
        return Err("Navigation is only available from the trusted browser UI".into());
    }
    let page = get_page_for_window(&app, &state, webview.label(), &tab_id)?;
    #[cfg(target_os = "macos")]
    {
        page.with_webview(|platform| {
            let web_view = unsafe { &*(platform.inner() as *mut objc2_web_kit::WKWebView) };
            unsafe { web_view.reloadFromOrigin() };
        })
        .map_err(|error| error.to_string())
    }
    #[cfg(not(target_os = "macos"))]
    {
        page.reload().map_err(|error| error.to_string())
    }
}

#[tauri::command]
pub(crate) async fn save_full_page_screenshot(
    webview: tauri::Webview,
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserState>,
    tab_id: String,
) -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    {
        if !is_trusted_browser_ui(webview.label()) {
            return Err(
                "Full-page screenshots are only available from the trusted browser UI".into(),
            );
        }
        save_full_page_screenshot_for_tab(&app, &state, webview.label(), &tab_id).await
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (webview, app, state, tab_id);
        Err("Full-page screenshots are currently available on macOS only".into())
    }
}

#[cfg(target_os = "macos")]
pub(crate) async fn save_full_page_screenshot_for_tab(
    app: &tauri::AppHandle,
    state: &BrowserState,
    ui_label: &str,
    tab_id: &str,
) -> Result<bool, String> {
    let page = get_page_for_window(app, state, ui_label, tab_id)?;
    let (title, source_url) = state
        .data
        .lock()
        .map_err(|_| "Browser state is unavailable")?
        .iter()
        .find(|tab| tab.id == tab_id)
        .map(|tab| (tab.title.clone(), tab.url.clone()))
        .unwrap_or_default();
    let stem: String = title
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || character == '-' || character == '_' {
                character
            } else {
                '-'
            }
        })
        .collect::<String>()
        .trim_matches('-')
        .chars()
        .take(80)
        .collect();
    let filename = format!("{}.png", if stem.is_empty() { "webpage" } else { &stem });
    let progress_app = app.clone();
    let progress_owner = ui_label.to_string();
    let png = platforms::macos::capture_full_page_png(page, move |completed, total| {
        let _ = progress_app.emit_to(
            &progress_owner,
            CAPTURE_PROGRESS_EVENT,
            serde_json::json!({ "completed": completed, "total": total }),
        );
    })
    .await?;

    use tauri_plugin_dialog::DialogExt;
    let (sender, receiver) = std::sync::mpsc::channel();
    app.dialog()
        .file()
        .add_filter("PNG image", &["png"])
        .set_file_name(filename)
        .save_file(move |path| {
            let _ = sender.send(path);
        });
    let selected = tauri::async_runtime::spawn_blocking(move || {
        receiver.recv_timeout(Duration::from_secs(300))
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())?;
    let Some(path) = selected else {
        return Ok(false);
    };
    let path = path.into_path().map_err(|error| error.to_string())?;
    std::fs::write(&path, png).map_err(|error| error.to_string())?;
    let filename = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("webpage.png")
        .to_string();
    let bytes_received = std::fs::metadata(&path)
        .map(|metadata| metadata.len())
        .unwrap_or(0);
    let number = state.next_download_id.fetch_add(1, Ordering::Relaxed) + 1;
    let entry = DownloadEntry {
        id: format!("download-{number}"),
        url: source_url,
        filename,
        path,
        status: DownloadStatus::Completed,
        bytes_received,
    };
    let downloads = {
        let mut items = state
            .downloads
            .lock()
            .map_err(|_| "Downloads are unavailable")?;
        items.insert(0, entry);
        items.clone()
    };
    let _ = app.emit_to(ui_label, DOWNLOADS_EVENT, downloads);
    Ok(true)
}

#[tauri::command]
pub(crate) fn stop_loading(
    webview: tauri::Webview,
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserState>,
    tab_id: String,
) -> Result<(), String> {
    if !is_trusted_browser_ui(webview.label()) {
        return Err("Navigation is only available from the trusted browser UI".into());
    }
    get_page_for_window(&app, &state, webview.label(), &tab_id)?
        .eval("window.stop()")
        .map_err(|e| e.to_string())?;
    let mut tabs = state
        .data
        .lock()
        .map_err(|_| "Browser state is unavailable")?;
    if let Some(tab) = tabs
        .iter_mut()
        .find(|tab| tab.id == tab_id && tab.window_label == browser_window_for_ui(webview.label()))
    {
        tab.loading = false;
    }
    emit_snapshot(&app, &tabs);
    drop(tabs);
    persist_session(&state)?;
    Ok(())
}
