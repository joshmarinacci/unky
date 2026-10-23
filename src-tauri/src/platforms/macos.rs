//! Narrow WKContentRuleList integration used only by the macOS interception test.

use block2::RcBlock;
use objc2::MainThreadMarker;
use objc2_foundation::{NSError, NSString};
use objc2_web_kit::{WKContentRuleList, WKContentRuleListStore, WKUserContentController};
use tauri::{AppHandle, Manager};

const FIXTURE_FILTERS: &str = "||localhost^$image,third-party\n";

pub fn install_interception_test(app: AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let mtm = MainThreadMarker::new()
        .ok_or("WKContentRuleListStore must be created on the main thread")?;
    let store = unsafe { WKContentRuleListStore::defaultStore(mtm) }
        .ok_or("WKContentRuleListStore default store unavailable")?;
    let identifier = NSString::from_str("macos-interception-fixture-v1");
    let report =
        blocker_core::compile_filter_list(FIXTURE_FILTERS).map_err(std::io::Error::other)?;
    blocker_core::validate_content_rules_json(&report.json).map_err(std::io::Error::other)?;
    if !report.rejected.is_empty() {
        eprintln!("macOS fixture filter rules rejected: {:?}", report.rejected);
    }
    eprintln!(
        "macOS fixture filters compiled: {} accepted, {} rejected",
        report.accepted,
        report.rejected.len()
    );
    let encoded_rules = NSString::from_str(&report.json);
    let completion = RcBlock::new(
        move |rule_list: *mut WKContentRuleList, error: *mut NSError| {
            if !error.is_null() || rule_list.is_null() {
                eprintln!("WKContentRuleList compilation failed: {error:p}");
                return;
            }

            // Send the native pointer as an integer so the closure passed to Tauri's
            // main-thread dispatcher satisfies its Send bound. The completion owns
            // a valid list here; adding it to WKUserContentController retains it.
            let rule_list_address = rule_list as usize;
            let app_for_main = app.clone();
            if let Err(err) = app.run_on_main_thread(move || {
                let Some(page) = app_for_main.get_webview("page") else {
                    eprintln!("website WebView disappeared before filter installation");
                    return;
                };
                let app_after_install = app_for_main.clone();
                if let Err(err) = page.with_webview(move |platform| unsafe {
                    let controller = &*(platform.controller() as *mut WKUserContentController);
                    controller.addContentRuleList(&*(rule_list_address as *mut WKContentRuleList));
                }) {
                    eprintln!("could not install WKContentRuleList: {err}");
                    return;
                }
                let fixture = url::Url::parse("http://127.0.0.1:4179/").unwrap();
                if let Some(page) = app_after_install.get_webview("page") {
                    if let Err(err) = page.navigate(fixture) {
                        eprintln!("could not navigate to interception fixture: {err}");
                    }
                }
            }) {
                eprintln!("could not schedule WKContentRuleList installation: {err}");
            }
        },
    );

    unsafe {
        store.compileContentRuleListForIdentifier_encodedContentRuleList_completionHandler(
            Some(&identifier),
            Some(&encoded_rules),
            Some(&completion),
        );
    }
    Ok(())
}
