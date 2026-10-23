mod browser;
use tauri::Manager;
#[cfg(all(target_os = "macos", feature = "macos-interception-test"))]
mod platforms;

fn allowed_navigation_url(url: &str) -> Result<url::Url, String> {
    let parsed = url::Url::parse(url).map_err(|_| "Enter a valid HTTP or HTTPS URL".to_string())?;
    if !matches!(parsed.scheme(), "http" | "https")
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
    {
        return Err("Only HTTP(S) URLs without embedded credentials are allowed".into());
    }
    Ok(parsed)
}

#[tauri::command]
fn navigate(webview: tauri::Webview, app: tauri::AppHandle, url: String) -> Result<(), String> {
    if webview.label() != "main" {
        return Err("Navigation is only available from the trusted browser UI".into());
    }
    let parsed = allowed_navigation_url(&url)?;
    let page = app
        .get_webview("page")
        .ok_or_else(|| "Website view is not available".to_string())?;
    page.navigate(parsed).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::allowed_navigation_url;

    #[test]
    fn navigation_accepts_http_and_https() {
        assert!(allowed_navigation_url("http://example.com/").is_ok());
        assert!(allowed_navigation_url("https://example.com/path").is_ok());
    }

    #[test]
    fn navigation_rejects_privileged_schemes_and_credentials() {
        assert!(allowed_navigation_url("javascript:alert(1)").is_err());
        assert!(allowed_navigation_url("file:///etc/passwd").is_err());
        assert!(allowed_navigation_url("https://user:pass@example.com/").is_err());
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            use tauri::{LogicalPosition, LogicalSize, WebviewUrl};
            let window = app.get_window("main").expect("main window configured");
            let start = url::Url::parse("http://127.0.0.1:4179/").unwrap();
            window.add_child(
                tauri::webview::WebviewBuilder::new(
                    "page",
                    WebviewUrl::External(
                        if cfg!(all(
                            target_os = "macos",
                            feature = "macos-interception-test"
                        )) {
                            url::Url::parse("about:blank").unwrap()
                        } else {
                            start
                        },
                    ),
                ),
                LogicalPosition::new(220.0, 64.0),
                LogicalSize::new(980.0, 736.0),
            )?;
            #[cfg(all(target_os = "macos", feature = "macos-interception-test"))]
            platforms::macos::install_interception_test(app.handle().clone())?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![navigate])
        .run(tauri::generate_context!())
        .expect("error while running browser");
}
