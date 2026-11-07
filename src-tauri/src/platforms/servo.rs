//! Development-only experiment for rendering Servo inside a Tauri child WebView.
//!
//! The WKWebView remains as the geometry and lifecycle host. Servo's OpenGL
//! surface is attached as a native subview so this prototype can measure the
//! hardest first integration boundary: painting into Unky's actual page area.

use euclid::Scale;
use raw_window_handle::{
    AppKitDisplayHandle, AppKitWindowHandle, DisplayHandle, RawDisplayHandle, RawWindowHandle,
    WindowHandle,
};
use servo::{
    EventLoopWaker, RenderingContext, Servo, ServoBuilder, WebView, WebViewBuilder,
    WebViewDelegate, WindowRenderingContext,
};
use std::{
    cell::{Cell, RefCell},
    collections::HashMap,
    ffi::c_void,
    ptr::NonNull,
    rc::Rc,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};
use tauri::{AppHandle, PhysicalSize, Webview};
use url::Url;

use objc2::{rc::Retained, MainThreadMarker, MainThreadOnly};
use objc2_app_kit::{NSAutoresizingMaskOptions, NSView};

thread_local! {
    static ENGINE: RefCell<Option<Rc<Servo>>> = const { RefCell::new(None) };
    static ENGINE_INIT_FAILED: Cell<bool> = const { Cell::new(false) };
    static HOSTS: RefCell<HashMap<String, Rc<ServoHost>>> = RefCell::new(HashMap::new());
}

fn trace(message: &str) {
    use std::io::Write;
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open("/private/tmp/unky-servo-spike.log")
    {
        let _ = writeln!(file, "{message}");
    }
}

struct ServoHost {
    webview: WebView,
    context: Rc<WindowRenderingContext>,
    _native_view: Retained<NSView>,
    first_frame_presented: AtomicBool,
}

struct ServoDelegate {
    app: AppHandle,
    host_id: String,
}

impl WebViewDelegate for ServoDelegate {
    fn notify_new_frame_ready(&self, _: WebView) {
        let app = self.app.clone();
        let host_id = self.host_id.clone();
        // Tauri runs main-thread tasks inline when called from the main thread.
        // Defer via its runtime so paint happens after Servo finishes spinning.
        tauri::async_runtime::spawn(async move {
            let _ = app.run_on_main_thread(move || paint_host(&host_id));
        });
    }
}

#[derive(Clone)]
struct TauriServoWaker {
    app: AppHandle,
    queued: Arc<AtomicBool>,
    requested: Arc<AtomicBool>,
}

impl TauriServoWaker {
    fn wake_main_thread(&self) {
        self.requested.store(true, Ordering::Release);
        if self.queued.swap(true, Ordering::AcqRel) {
            return;
        }
        let waker = self.clone();
        let app = self.app.clone();
        let queued = self.queued.clone();
        tauri::async_runtime::spawn(async move {
            let result = app.run_on_main_thread(move || {
                for _ in 0..16 {
                    if !waker.requested.swap(false, Ordering::AcqRel) {
                        break;
                    }
                    spin_engine();
                }
                waker.queued.store(false, Ordering::Release);
                if waker.requested.load(Ordering::Acquire) {
                    waker.wake_main_thread();
                }
            });
            if result.is_err() {
                queued.store(false, Ordering::Release);
            }
        });
    }
}

impl EventLoopWaker for TauriServoWaker {
    fn clone_box(&self) -> Box<dyn EventLoopWaker> {
        Box::new(self.clone())
    }

    fn wake(&self) {
        self.wake_main_thread();
    }
}

/// Attach an experimental Servo renderer to the actual native page view.
/// Called only by the debug-only `servo-in-tauri-spike` Cargo feature.
pub fn attach(app: AppHandle, page: Webview, host_id: String, url: Url) {
    trace(&format!("attach requested: {host_id} {url}"));
    let waker = TauriServoWaker {
        app: app.clone(),
        queued: Arc::new(AtomicBool::new(false)),
        requested: Arc::new(AtomicBool::new(false)),
    };
    let resize_waker = waker.clone();
    page.window().on_window_event(move |event| {
        if matches!(
            event,
            tauri::WindowEvent::Resized(_) | tauri::WindowEvent::ScaleFactorChanged { .. }
        ) {
            resize_waker.wake_main_thread();
        }
    });

    let result = page.with_webview(move |platform| {
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| unsafe {
            attach_native_view(platform.inner(), host_id, url, waker)
        }));
        match result {
            Ok(Ok(())) => {}
            Ok(Err(error)) => {
                eprintln!("Servo-in-Tauri spike could not attach: {error}");
                trace(&format!("attach error: {error}"));
            }
            Err(panic) => {
                let message = panic
                    .downcast_ref::<String>()
                    .map(String::as_str)
                    .or_else(|| panic.downcast_ref::<&str>().copied())
                    .unwrap_or("unknown panic");
                eprintln!("Servo-in-Tauri spike panicked during attach: {message}");
                trace(&format!("attach panic: {message}"));
            }
        }
    });
    if let Err(error) = result {
        eprintln!("Servo-in-Tauri spike could not access the native page view: {error}");
        trace(&format!("webview access error: {error}"));
    }
}

/// Release a Servo host when Unky closes or reparents its containing tab.
pub fn detach(app: &AppHandle, host_id: &str) {
    let host_id = host_id.to_string();
    let _ = app.run_on_main_thread(move || {
        HOSTS.with(|hosts| {
            if let Some(host) = hosts.borrow_mut().remove(&host_id) {
                host._native_view.removeFromSuperview();
            }
        });
    });
}

unsafe fn attach_native_view(
    webkit_view: *mut c_void,
    host_id: String,
    mut url: Url,
    waker: TauriServoWaker,
) -> Result<(), String> {
    let mtm =
        MainThreadMarker::new().ok_or("Servo view creation requires the macOS main thread")?;
    let parent = unsafe { &*(webkit_view as *mut NSView) };
    let bounds = parent.bounds();
    let native_view = NSView::initWithFrame(NSView::alloc(mtm), bounds);
    native_view.setAutoresizingMask(
        NSAutoresizingMaskOptions::ViewWidthSizable | NSAutoresizingMaskOptions::ViewHeightSizable,
    );
    parent.addSubview(&native_view);

    let view_pointer = NonNull::from(&*native_view).cast::<c_void>();
    let display_raw = RawDisplayHandle::AppKit(AppKitDisplayHandle::new());
    let window_raw = RawWindowHandle::AppKit(AppKitWindowHandle::new(view_pointer));
    let display = unsafe { DisplayHandle::borrow_raw(display_raw) };
    let window = unsafe { WindowHandle::borrow_raw(window_raw) };
    let scale = parent
        .window()
        .map_or(1.0, |window| window.backingScaleFactor() as f32);
    let size = view_size(&native_view, scale);
    let context = Rc::new(
        WindowRenderingContext::new(display, window, size).map_err(|error| {
            format!("Could not create Servo's native rendering context: {error:?}")
        })?,
    );
    context.make_current().map_err(|error| {
        format!("Could not activate Servo's native rendering context: {error:?}")
    })?;

    let servo = ENGINE.with(|engine| engine.borrow().clone());
    let servo = if let Some(servo) = servo {
        servo
    } else {
        if ENGINE_INIT_FAILED.with(Cell::get) {
            return Err("Servo engine initialization failed earlier".to_string());
        }
        // Leave this set if Servo panics; SpiderMonkey and servo-config cannot
        // safely be initialized a second time in this process.
        ENGINE_INIT_FAILED.with(|failed| failed.set(true));
        let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
        let servo = Rc::new(
            ServoBuilder::default()
                .event_loop_waker(Box::new(waker.clone()))
                .build(),
        );
        ENGINE.with(|engine| *engine.borrow_mut() = Some(servo.clone()));
        ENGINE_INIT_FAILED.with(|failed| failed.set(false));
        servo
    };
    // The localhost lab paints a badge only in Servo's copy, while the
    // WKWebView underneath receives the original URL.
    if url.host_str() == Some("127.0.0.1") && url.path() == "/index.html" {
        url.query_pairs_mut().append_pair("servo-probe", "1");
    }
    let delegate = Rc::new(ServoDelegate {
        app: waker.app.clone(),
        host_id: host_id.clone(),
    });
    let webview = WebViewBuilder::new(&servo, context.clone())
        .url(url)
        .hidpi_scale_factor(Scale::new(scale))
        .delegate(delegate)
        .build();

    let host = Rc::new(ServoHost {
        webview,
        context,
        _native_view: native_view,
        first_frame_presented: AtomicBool::new(false),
    });
    HOSTS.with(|hosts| {
        hosts.borrow_mut().insert(host_id.clone(), host);
    });
    eprintln!("Servo-in-Tauri spike attached host {host_id}");
    trace(&format!("attached host: {host_id}"));
    spin_engine();
    Ok(())
}

fn paint_host(host_id: &str) {
    let host = HOSTS.with(|hosts| hosts.borrow().get(host_id).cloned());
    let Some(host) = host else { return };
    if host.context.make_current().is_ok() {
        host.webview.paint();
        host.context.present();
        if !host.first_frame_presented.swap(true, Ordering::AcqRel) {
            eprintln!("Servo-in-Tauri spike presented its first frame");
            trace(&format!("first frame presented: {host_id}"));
        }
    }
}

fn view_size(view: &NSView, scale: f32) -> PhysicalSize<u32> {
    let bounds = view.bounds();
    PhysicalSize::new(
        (bounds.size.width * scale as f64).round().max(1.0) as u32,
        (bounds.size.height * scale as f64).round().max(1.0) as u32,
    )
}

fn spin_engine() {
    let servo = ENGINE.with(|engine| engine.borrow().clone());
    let Some(servo) = servo else {
        return;
    };
    servo.spin_event_loop();
    let hosts = HOSTS.with(|hosts| hosts.borrow().values().cloned().collect::<Vec<_>>());
    for host in hosts {
        let scale = host
            ._native_view
            .window()
            .map_or(1.0, |window| window.backingScaleFactor() as f32);
        let size = view_size(&host._native_view, scale);
        if host.context.size() != size {
            host.context.resize(size);
            host.webview.resize(size);
        }
    }
}
