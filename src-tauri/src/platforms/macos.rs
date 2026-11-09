//! WKContentRuleList integration for production macOS filtering and its fixture test.

use block2::RcBlock;
use objc2::{rc::Retained, runtime::AnyObject, MainThreadMarker};
use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep};
use objc2_foundation::{NSData, NSError, NSString};
use objc2_web_kit::{
    WKContentRuleList, WKContentRuleListStore, WKUserContentController, WKWebView,
};
use std::{
    collections::{hash_map::DefaultHasher, HashMap},
    hash::{Hash, Hasher},
    sync::{Arc, Mutex, OnceLock},
    time::Duration,
};
use tauri::{AppHandle, Manager};

const MAX_CAPTURE_HEIGHT_CSS_PX: u32 = 30_000;
const MAX_CAPTURE_PIXELS: u64 = 100_000_000;

/// Capture a complete webpage by scrolling its real WKWebView and stitching native viewport
/// snapshots. The original scroll position is restored even when one of the captures fails.
pub async fn capture_full_page_png(
    page: tauri::Webview,
    mut on_progress: impl FnMut(u32, u32),
) -> Result<Vec<u8>, String> {
    let metrics = evaluate_page_json(&page, "JSON.stringify([window.innerWidth, Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0), window.innerHeight, window.scrollX, window.scrollY])").await?;
    let metrics: Vec<f64> = serde_json::from_str(&metrics)
        .map_err(|error| format!("could not read webpage dimensions: {error}"))?;
    if metrics.len() != 5
        || metrics
            .iter()
            .any(|value| !value.is_finite() || *value < 0.0)
    {
        return Err("the webpage returned invalid dimensions".into());
    }
    let width_css = metrics[0].ceil() as u32;
    let height_css = metrics[1].ceil() as u32;
    let viewport_css = metrics[2].floor().max(1.0) as u32;
    let original_x = metrics[3];
    let original_y = metrics[4];
    if width_css == 0 || height_css == 0 || height_css > MAX_CAPTURE_HEIGHT_CSS_PX {
        return Err(format!(
            "page height must be between 1 and {MAX_CAPTURE_HEIGHT_CSS_PX} CSS pixels to capture"
        ));
    }

    let original_alpha = set_webview_alpha(&page, 0.0).await?;
    let capture_id = format!("{}", std::process::id());

    let max_scroll_y = height_css.saturating_sub(viewport_css);
    let mut offsets = Vec::new();
    let mut next_y = 0_u32;
    loop {
        let capture_y = next_y.min(max_scroll_y);
        if offsets.last().copied() == Some(capture_y) {
            break;
        }
        offsets.push(capture_y);
        if capture_y == max_scroll_y {
            break;
        }
        next_y = capture_y.saturating_add(viewport_css);
    }
    let total = offsets.len() as u32;
    on_progress(0, total);

    let result = async {
        let mut chunks = Vec::new();
        for (index, target_y) in offsets.into_iter().enumerate() {
            evaluate_page_json(
                &page,
                &format!(
                    "window.scrollTo({{left: 0, top: {target_y}, behavior: 'instant'}}); 'ok'"
                ),
            )
            .await?;
            tokio_delay().await;
            chunks.push((target_y, capture_viewport_png(page.clone()).await?));
            on_progress(index as u32 + 1, total);
            if target_y == 0 {
                set_sticky_elements_hidden(&page, &capture_id, true).await?;
            }
        }
        stitch_png_chunks(chunks, width_css, height_css)
    }
    .await;

    let _ = evaluate_page_json(
        &page,
        &format!(
            "window.scrollTo({{left: {original_x}, top: {original_y}, behavior: 'instant'}}); 'ok'"
        ),
    )
    .await;
    let _ = set_sticky_elements_hidden(&page, &capture_id, false).await;
    let _ = set_webview_alpha(&page, original_alpha).await;
    result
}

async fn set_webview_alpha(page: &tauri::Webview, alpha: f64) -> Result<f64, String> {
    let (sender, receiver) = std::sync::mpsc::channel();
    page.with_webview(move |native| unsafe {
        let webview = &*(native.inner() as *mut WKWebView);
        let original = webview.alphaValue();
        webview.setAlphaValue(alpha);
        let _ = sender.send(original);
    })
    .map_err(|error| error.to_string())?;
    tauri::async_runtime::spawn_blocking(move || receiver.recv_timeout(Duration::from_secs(5)))
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())
}

async fn set_sticky_elements_hidden(
    page: &tauri::Webview,
    capture_id: &str,
    hidden: bool,
) -> Result<(), String> {
    let key = format!("data-unky-shot-{capture_id}");
    let script = if hidden {
        format!(
            "(() => {{ const key = '{key}'; const style = document.createElement('style'); style.dataset.unKyShot = '{capture_id}'; style.textContent = '[' + key + '=\"1\"] {{ visibility: hidden !important; }}'; document.documentElement.appendChild(style); for (const element of document.querySelectorAll('*')) {{ const position = getComputedStyle(element).position; if (position === 'fixed' || position === 'sticky') element.setAttribute(key, '1'); }} return 'ok'; }})()"
        )
    } else {
        format!(
            "(() => {{ const key = '{key}'; for (const element of document.querySelectorAll('[' + key + '=\"1\"]')) element.removeAttribute(key); document.querySelector('style[data-un-ky-shot=\"{capture_id}\"]')?.remove(); return 'ok'; }})()"
        )
    };
    evaluate_page_json(page, &script).await.map(|_| ())
}

async fn tokio_delay() {
    tauri::async_runtime::spawn_blocking(|| std::thread::sleep(Duration::from_millis(100)))
        .await
        .ok();
}

async fn evaluate_page_json(page: &tauri::Webview, script: &str) -> Result<String, String> {
    let script = script.to_string();
    let (sender, receiver) = std::sync::mpsc::channel();
    page.with_webview(move |native| unsafe {
        let webview = &*(native.inner() as *mut WKWebView);
        let script = NSString::from_str(&script);
        let completion = block2::RcBlock::new(move |value: *mut AnyObject, error: *mut NSError| {
            let value = if !error.is_null() {
                Err("WebKit could not read the webpage dimensions".to_string())
            } else if value.is_null() {
                Err("WebKit returned no webpage dimensions".to_string())
            } else {
                Ok((&*(value as *mut NSString)).to_string())
            };
            let _ = sender.send(value);
        });
        webview.evaluateJavaScript_completionHandler(&script, Some(&completion));
    })
    .map_err(|error| error.to_string())?;
    tauri::async_runtime::spawn_blocking(move || receiver.recv_timeout(Duration::from_secs(10)))
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())?
}

async fn capture_viewport_png(page: tauri::Webview) -> Result<Vec<u8>, String> {
    let (sender, receiver) = std::sync::mpsc::channel();
    page.with_webview(move |native| unsafe {
        let webview = &*(native.inner() as *mut WKWebView);
        let completion = block2::RcBlock::new(
            move |image: *mut objc2_app_kit::NSImage, error: *mut NSError| {
                let result = if !error.is_null() || image.is_null() {
                    Err("WebKit could not capture this part of the webpage".to_string())
                } else {
                    let tiff = (&*image).TIFFRepresentation();
                    tiff.and_then(|data| NSBitmapImageRep::imageRepWithData(&data))
                        .and_then(|rep| {
                            rep.representationUsingType_properties(
                                NSBitmapImageFileType::PNG,
                                &objc2_foundation::NSDictionary::new(),
                            )
                        })
                        .map(|data| nsdata_to_vec(&data))
                        .ok_or_else(|| {
                            "WebKit could not encode the webpage screenshot as PNG".to_string()
                        })
                };
                let _ = sender.send(result);
            },
        );
        webview.takeSnapshotWithConfiguration_completionHandler(None, &completion);
    })
    .map_err(|error| error.to_string())?;
    tauri::async_runtime::spawn_blocking(move || receiver.recv_timeout(Duration::from_secs(30)))
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())?
}

fn nsdata_to_vec(data: &NSData) -> Vec<u8> {
    let mut bytes = vec![0; data.length() as usize];
    if !bytes.is_empty() {
        unsafe {
            data.getBytes_length(
                std::ptr::NonNull::new_unchecked(bytes.as_mut_ptr().cast()),
                bytes.len() as _,
            )
        };
    }
    bytes
}

fn stitch_png_chunks(
    chunks: Vec<(u32, Vec<u8>)>,
    page_width_css: u32,
    page_height_css: u32,
) -> Result<Vec<u8>, String> {
    use image::{ImageFormat, RgbaImage};
    use std::io::Cursor;
    if chunks.is_empty() {
        return Err("the webpage produced no screenshot".into());
    }
    let decoded: Vec<(u32, RgbaImage)> = chunks
        .into_iter()
        .map(|(y, bytes)| {
            image::load_from_memory_with_format(&bytes, ImageFormat::Png)
                .map(|image| (y, image.into_rgba8()))
                .map_err(|error| format!("could not decode a webpage screenshot: {error}"))
        })
        .collect::<Result<_, _>>()?;
    let width = decoded[0].1.width();
    let scale = f64::from(width) / f64::from(page_width_css);
    let height = (page_height_css as f64 * scale).ceil() as u32;
    if u64::from(width) * u64::from(height) > MAX_CAPTURE_PIXELS {
        return Err("the webpage is too tall to capture as one PNG image".into());
    }
    let mut output = RgbaImage::new(width, height);
    for (y_css, chunk) in &decoded {
        if chunk.width() != width {
            return Err("the webpage changed width while it was being captured".into());
        }
        let y_out = (*y_css as f64 * scale).round() as u32;
        if y_out < height {
            image::imageops::replace(&mut output, chunk, 0, i64::from(y_out));
        }
    }
    let mut bytes = Cursor::new(Vec::new());
    image::DynamicImage::ImageRgba8(output)
        .write_to(&mut bytes, ImageFormat::Png)
        .map_err(|error| format!("could not encode full-page screenshot: {error}"))?;
    Ok(bytes.into_inner())
}

#[cfg(test)]
mod screenshot_tests {
    use super::stitch_png_chunks;
    use image::{ImageFormat, Rgba, RgbaImage};
    use std::io::Cursor;

    fn solid_png(width: u32, height: u32, color: Rgba<u8>) -> Vec<u8> {
        let image = RgbaImage::from_pixel(width, height, color);
        let mut bytes = Cursor::new(Vec::new());
        image::DynamicImage::ImageRgba8(image)
            .write_to(&mut bytes, ImageFormat::Png)
            .expect("fixture PNG should encode");
        bytes.into_inner()
    }

    #[test]
    fn stitches_viewports_at_document_positions_and_clips_the_last_overlap() {
        let red = Rgba([255, 0, 0, 255]);
        let green = Rgba([0, 255, 0, 255]);
        // Each screenshot is 4x4 pixels for a 2x2 CSS-pixel viewport (scale 2).
        // The second starts at CSS y=1, overlapping the first by half a viewport;
        // the document is only 3 CSS pixels tall, so the final image is 4x6.
        let png = stitch_png_chunks(
            vec![(0, solid_png(4, 4, red)), (1, solid_png(4, 4, green))],
            2,
            3,
        )
        .expect("viewport screenshots should stitch");
        let image = image::load_from_memory_with_format(&png, ImageFormat::Png)
            .expect("stitched PNG should decode")
            .into_rgba8();

        assert_eq!((image.width(), image.height()), (4, 6));
        assert_eq!(image.get_pixel(0, 0), &red);
        assert_eq!(image.get_pixel(0, 1), &red);
        assert_eq!(image.get_pixel(0, 2), &green);
        assert_eq!(image.get_pixel(0, 5), &green);
    }
}

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
