//! WKContentRuleList integration for production macOS filtering and its fixture test.

use block2::RcBlock;
use objc2::{rc::Retained, MainThreadMarker};
use objc2_foundation::{NSError, NSString};
use objc2_web_kit::{WKContentRuleList, WKContentRuleListStore, WKUserContentController};
use std::{
    collections::{hash_map::DefaultHasher, HashMap},
    hash::{Hash, Hasher},
    sync::{Arc, Mutex, OnceLock},
    time::Duration,
};
use tauri::{AppHandle, Manager};

type RuleListCompletion = Arc<Mutex<Option<Box<dyn FnOnce(Option<usize>) + Send>>>>;
static PENDING_RULE_LISTS: OnceLock<Mutex<HashMap<String, Vec<RuleListCompletion>>>> =
    OnceLock::new();

/// Wait for WebKit's native compiler before settings or downloaded rules replace the active file.
pub async fn validate_filter_rules(app: AppHandle, json: String) -> Result<(), String> {
    let (sender, receiver) = std::sync::mpsc::channel();
    let completion: RuleListCompletion = Arc::new(Mutex::new(Some(Box::new(move |address| {
        let _ = sender.send(address.is_some());
    }))));
    let app_for_compile = app.clone();
    app.run_on_main_thread(move || {
        load_or_compile_rule_list(&app_for_compile, json, completion);
    })
    .map_err(|error| error.to_string())?;
    let result = tauri::async_runtime::spawn_blocking(move || {
        receiver.recv_timeout(Duration::from_secs(60))
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| format!("Timed out waiting for WebKit filter compilation: {error}"))?;
    if result {
        Ok(())
    } else {
        Err("WebKit could not compile these filter rules; the current list was kept".into())
    }
}

fn finish_rule_list(app: &AppHandle, identifier: String, pointer: Option<usize>) {
    let Some(pending) = PENDING_RULE_LISTS.get() else {
        return;
    };
    let completions = pending
        .lock()
        .ok()
        .and_then(|mut items| items.remove(&identifier))
        .unwrap_or_default();
    if completions.is_empty() {
        return;
    }
    let retained_address = pointer
        .and_then(|address| unsafe {
            Retained::retain(address as *mut WKContentRuleList).map(Retained::into_raw)
        })
        .map(|address| address as usize);
    let app = app.clone();
    let _ = app.run_on_main_thread(move || {
        let _rule_list = retained_address
            .map(|address| unsafe { Retained::from_raw(address as *mut WKContentRuleList) });
        for completion in completions {
            if let Ok(mut completion) = completion.lock() {
                if let Some(completion) = completion.take() {
                    completion(retained_address);
                }
            }
        }
    });
}

fn load_or_compile_rule_list(app: &AppHandle, json: String, completion: RuleListCompletion) {
    let mut hasher = DefaultHasher::new();
    json.hash(&mut hasher);
    let identifier_text = format!("my-browser-filter-{:016x}", hasher.finish());
    let pending = PENDING_RULE_LISTS.get_or_init(|| Mutex::new(HashMap::new()));
    let should_start = if let Ok(mut items) = pending.lock() {
        if let Some(completions) = items.get_mut(&identifier_text) {
            completions.push(completion.clone());
            false
        } else {
            items.insert(identifier_text.clone(), vec![completion.clone()]);
            true
        }
    } else {
        false
    };
    if !should_start {
        return;
    }
    let Some(mtm) = MainThreadMarker::new() else {
        finish_rule_list(app, identifier_text, None);
        return;
    };
    let Some(store) = (unsafe { WKContentRuleListStore::defaultStore(mtm) }) else {
        finish_rule_list(app, identifier_text, None);
        return;
    };
    let identifier = NSString::from_str(&identifier_text);
    let app_for_lookup = app.clone();
    let identifier_for_compile = identifier_text.clone();
    let json_for_compile = json.clone();
    let lookup = RcBlock::new(
        move |rule_list: *mut WKContentRuleList, error: *mut NSError| {
            if error.is_null() && !rule_list.is_null() {
                finish_rule_list(
                    &app_for_lookup,
                    identifier_for_compile.clone(),
                    Some(rule_list as usize),
                );
                return;
            }
            let app_for_compile = app_for_lookup.clone();
            let identifier_for_main = identifier_for_compile.clone();
            let json_for_main = json_for_compile.clone();
            let app_for_main = app_for_compile.clone();
            let _ = app_for_compile.run_on_main_thread(move || {
            let Some(mtm) = MainThreadMarker::new() else {
                finish_rule_list(&app_for_main, identifier_for_main, None);
                return;
            };
            let Some(store) = (unsafe { WKContentRuleListStore::defaultStore(mtm) }) else {
                finish_rule_list(&app_for_main, identifier_for_main, None);
                return;
            };
            let app_for_result = app_for_main.clone();
            let identifier_for_result = identifier_for_main.clone();
            let identifier = NSString::from_str(&identifier_for_main);
            let encoded_rules = NSString::from_str(&json_for_main);
            let compile = RcBlock::new(
                move |compiled: *mut WKContentRuleList, compile_error: *mut NSError| {
                    if !compile_error.is_null() || compiled.is_null() {
                        eprintln!("WKContentRuleList compilation failed: {compile_error:p}");
                        finish_rule_list(&app_for_result, identifier_for_result.clone(), None);
                    } else {
                        finish_rule_list(
                            &app_for_result,
                            identifier_for_result.clone(),
                            Some(compiled as usize),
                        );
                    }
                },
            );
            unsafe {
                store.compileContentRuleListForIdentifier_encodedContentRuleList_completionHandler(
                    Some(&identifier),
                    Some(&encoded_rules),
                    Some(&compile),
                );
            }
        });
        },
    );
    unsafe {
        store
            .lookUpContentRuleListForIdentifier_completionHandler(Some(&identifier), Some(&lookup));
    }
}

/// Installs the compiled rules before allowing the first website navigation in a child view.
pub fn install_filter_for_page(
    app: AppHandle,
    page_label: String,
    json: String,
    pending_url: Arc<Mutex<Option<url::Url>>>,
    ready: Arc<std::sync::atomic::AtomicBool>,
) {
    let app_for_compile = app.clone();
    let app_for_install = app.clone();
    let page_for_install = page_label.clone();
    let ready_for_install = ready.clone();
    let completion: RuleListCompletion = Arc::new(Mutex::new(Some(Box::new(move |address| {
        if let Some(page) = app_for_install.get_webview(&page_for_install) {
            if let Some(address) = address {
                let installed = page.with_webview(move |platform| unsafe {
                    let controller = &*(platform.controller() as *mut WKUserContentController);
                    controller.addContentRuleList(&*(address as *mut WKContentRuleList));
                });
                if let Err(error) = installed {
                    eprintln!("could not install WKContentRuleList: {error}");
                }
            } else {
                eprintln!(
                    "could not compile the active WKContentRuleList; continuing without filtering"
                );
            }
            ready_for_install.store(true, std::sync::atomic::Ordering::Release);
            let queued = pending_url
                .lock()
                .ok()
                .and_then(|mut pending| pending.take());
            if let Some(url) = queued {
                if let Err(error) = page.navigate(url) {
                    eprintln!("could not start queued website navigation: {error}");
                }
            }
        }
    }))));
    if let Err(error) = app.run_on_main_thread(move || {
        load_or_compile_rule_list(&app_for_compile, json, completion);
    }) {
        eprintln!("could not schedule WebKit filter installation: {error}");
        ready.store(true, std::sync::atomic::Ordering::Release);
    }
}

/// Replaces the active filter list on every website view, then reloads the pages.
pub fn update_filter_on_all_pages(app: AppHandle, enabled: bool, json: String) {
    let app_for_compile = app.clone();
    let app_for_install = app.clone();
    let completion: RuleListCompletion = Arc::new(Mutex::new(Some(Box::new(move |address| {
        if enabled && address.is_none() {
            eprintln!(
                "keeping the current content rules because the replacement could not be compiled"
            );
            return;
        }
        for (label, page) in app_for_install.webviews() {
            if !label.starts_with("page-") {
                continue;
            }
            let installed = page.with_webview(move |platform| unsafe {
                let controller = &*(platform.controller() as *mut WKUserContentController);
                controller.removeAllContentRuleLists();
                if let Some(address) = address {
                    controller.addContentRuleList(&*(address as *mut WKContentRuleList));
                }
            });
            if let Err(error) = installed {
                eprintln!("could not update content rules for {label}: {error}");
            } else if let Err(error) = page.reload() {
                eprintln!("could not reload {label} after updating content rules: {error}");
            }
        }
    }))));
    if enabled {
        let _ = app.run_on_main_thread(move || {
            load_or_compile_rule_list(&app_for_compile, json, completion);
        });
    } else {
        let _ = app.run_on_main_thread(move || {
            if let Ok(mut completion) = completion.lock() {
                if let Some(completion) = completion.take() {
                    completion(None);
                }
            }
        });
    }
}

#[cfg(feature = "macos-interception-test")]
const FIXTURE_FILTERS: &str = "||localhost^$image,third-party\n";

#[cfg(feature = "macos-interception-test")]
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
