//! OS-registered browsers and validated URL handoff. No shell or caller-supplied paths.

use serde::Serialize;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalBrowser {
    pub id: String,
    pub name: String,
    #[serde(skip)]
    pub application_path: String,
}

pub fn page_url(input: &str) -> Result<url::Url, String> {
    let url = url::Url::parse(input).map_err(|_| "Open a web page first")?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(
            "Only HTTP(S) pages without embedded credentials can be opened in another browser"
                .into(),
        );
    }
    Ok(url)
}

#[cfg(target_os = "macos")]
pub async fn current_page_url(page: &tauri::Webview) -> Result<url::Url, String> {
    let (sender, receiver) = std::sync::mpsc::channel();
    page.with_webview(move |native| {
        // Wry's url() unwraps WKWebView.URL, which can be nil before the first load.
        let view = unsafe { &*(native.inner() as *mut objc2_web_kit::WKWebView) };
        let location = unsafe { view.URL() }
            .and_then(|url| url.absoluteString())
            .map(|url| url.to_string());
        let _ = sender.send(location);
    })
    .map_err(|error| error.to_string())?;
    let location = tauri::async_runtime::spawn_blocking(move || {
        receiver
            .recv_timeout(std::time::Duration::from_secs(5))
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())??;
    page_url(&location.ok_or("Open a web page first")?)
}

#[cfg(not(target_os = "macos"))]
pub async fn current_page_url(page: &tauri::Webview) -> Result<url::Url, String> {
    page_url(page.url().map_err(|error| error.to_string())?.as_str())
}

#[cfg(target_os = "macos")]
fn handles_html(bundle: &objc2_foundation::NSBundle) -> bool {
    use objc2::runtime::AnyObject;
    use objc2_foundation::{NSArray, NSDictionary, NSString};
    let Some(types) = bundle
        .objectForInfoDictionaryKey(&NSString::from_str("CFBundleDocumentTypes"))
        .and_then(|value| value.downcast::<NSArray<AnyObject>>().ok())
    else {
        return false;
    };
    types.iter().any(|document| {
        let Some(document) = document.downcast_ref::<NSDictionary>() else {
            return false;
        };
        [
            ("LSItemContentTypes", &["public.html", "public.xhtml"][..]),
            ("CFBundleTypeExtensions", &["html", "htm", "xhtml"][..]),
            (
                "CFBundleTypeMIMETypes",
                &["text/html", "application/xhtml+xml"][..],
            ),
        ]
        .iter()
        .any(|(key, accepted)| {
            document
                .objectForKey(&NSString::from_str(key))
                .and_then(|value| value.downcast::<NSArray<AnyObject>>().ok())
                .is_some_and(|values| {
                    values.iter().any(|value| {
                        value
                            .downcast_ref::<NSString>()
                            .is_some_and(|value| accepted.contains(&value.to_string().as_str()))
                    })
                })
        })
    })
}

#[cfg(target_os = "macos")]
pub fn installed_browsers(own_id: &str) -> Result<Vec<ExternalBrowser>, String> {
    use objc2_app_kit::NSWorkspace;
    use objc2_foundation::{NSBundle, NSString, NSURL};

    let workspace = NSWorkspace::sharedWorkspace();
    let probe = NSURL::URLWithString(&NSString::from_str("https://example.com"))
        .ok_or("Could not query installed browsers")?;
    let mut browsers = Vec::new();
    for application in workspace.URLsForApplicationsToOpenURL(&probe) {
        let Some(bundle) = NSBundle::bundleWithURL(&application) else {
            continue;
        };
        if !handles_html(&bundle) {
            continue;
        }
        let Some(id) = bundle.bundleIdentifier().map(|id| id.to_string()) else {
            continue;
        };
        if id == own_id
            || browsers
                .iter()
                .any(|browser: &ExternalBrowser| browser.id == id)
        {
            continue;
        }
        let Some(path) = application.path().map(|path| path.to_string()) else {
            continue;
        };
        if !std::path::Path::new(&path).is_dir() {
            continue;
        }
        let name = ["CFBundleDisplayName", "CFBundleName"]
            .iter()
            .find_map(|key| {
                bundle
                    .objectForInfoDictionaryKey(&NSString::from_str(key))
                    .and_then(|value| value.downcast::<NSString>().ok())
                    .map(|value| value.to_string())
            })
            .unwrap_or_else(|| id.clone());
        browsers.push(ExternalBrowser {
            id,
            name,
            application_path: path,
        });
    }
    browsers.sort_by_key(|browser| browser.name.to_lowercase());
    Ok(browsers)
}

#[cfg(not(target_os = "macos"))]
pub fn installed_browsers(_own_id: &str) -> Result<Vec<ExternalBrowser>, String> {
    Err("Choosing another browser is currently supported on macOS only".into())
}

#[cfg(target_os = "macos")]
pub fn open(browser: &ExternalBrowser, url: &url::Url) -> Result<(), String> {
    let output = std::process::Command::new("/usr/bin/open")
        .args(["-a", &browser.application_path, "--", url.as_str()])
        .output()
        .map_err(|error| format!("Could not open {}: {error}", browser.name))?;
    if !output.status.success() {
        return Err(format!(
            "Could not open {}: {}",
            browser.name,
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(())
}

#[cfg(not(target_os = "macos"))]
pub fn open(_browser: &ExternalBrowser, _url: &url::Url) -> Result<(), String> {
    Err("Choosing another browser is currently supported on macOS only".into())
}

#[cfg(test)]
mod tests {
    use super::page_url;

    #[test]
    fn handoff_preserves_the_page_address_and_rejects_non_web_input() {
        let input = "https://example.com/a%20b?q=one&next=%2Ftwo#section";
        assert_eq!(page_url(input).unwrap().as_str(), input);
        for input in [
            "",
            "example.com",
            "search term",
            "about:blank",
            "file:///tmp/page.html",
            "javascript:alert(1)",
            "https://user:password@example.com",
            "--args",
        ] {
            assert!(page_url(input).is_err(), "must reject {input}");
        }
    }
}
