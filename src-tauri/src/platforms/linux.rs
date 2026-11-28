//! Linux (GTK / WebKitGTK) integration for website child WebViews.

use gtk::prelude::*;
use tauri::Manager;

/// Record real button and key presses on a website WebView so page commands can require a
/// native user gesture, as the AppKit event monitor does on macOS. GTK runs these handlers
/// before WebKitGTK's own, and they let every event continue to the page.
pub fn install_user_activation_hooks(app: &tauri::AppHandle, label: &str) -> Result<(), String> {
    let page = app
        .get_webview(label)
        .ok_or("The page WebView is unavailable")?;
    page.with_webview(|platform| {
        let view = platform.inner();
        view.connect_button_press_event(|_, _| {
            crate::browser::activation::record_native_gesture();
            gtk::glib::Propagation::Proceed
        });
        view.connect_key_press_event(|_, _| {
            crate::browser::activation::record_native_gesture();
            gtk::glib::Propagation::Proceed
        });
    })
    .map_err(|error| error.to_string())
}

/// Tauri packs every WebView of a window into the window's vertical `gtk::Box`, which stacks
/// them one under another and ignores their bounds (wry only honors bounds in a `gtk::Fixed`).
/// Move a new page WebView into a `gtk::Overlay` drawn over the browser UI instead, where
/// [`place_page`] can position it. Call once, right after the page WebView is added.
pub fn host_page_over_ui(app: &tauri::AppHandle, label: &str) -> Result<(), String> {
    let page = app
        .get_webview(label)
        .ok_or("The page WebView is unavailable")?;
    page.with_webview(|platform| {
        let view: gtk::Widget = platform.inner().upcast();
        let Some(vbox) = view
            .parent()
            .and_then(|parent| parent.downcast::<gtk::Box>().ok())
        else {
            return;
        };
        let overlay = vbox
            .children()
            .into_iter()
            .find_map(|child| child.downcast::<gtk::Overlay>().ok())
            .unwrap_or_else(|| wrap_ui_in_overlay(&vbox, &view));
        vbox.remove(&view);
        view.set_halign(gtk::Align::Start);
        view.set_valign(gtk::Align::Start);
        overlay.add_overlay(&view);
    })
    .map_err(|error| error.to_string())
}

/// On a window's first page the box holds just the browser UI WebView and that page. The UI
/// becomes the overlay's main child, so it still fills the window and follows its size.
fn wrap_ui_in_overlay(vbox: &gtk::Box, page: &gtk::Widget) -> gtk::Overlay {
    let overlay = gtk::Overlay::new();
    if let Some(ui) = vbox.children().into_iter().find(|child| child != page) {
        vbox.remove(&ui);
        overlay.add(&ui);
    }
    vbox.pack_start(&overlay, true, true, 0);
    overlay.show();
    overlay
}

/// Position a page hosted by [`host_page_over_ui`], or hide it. Overlay children do not add to
/// the window's minimum size, and GTK's logical pixels match Tauri's logical units.
pub fn place_page(
    page: &tauri::Webview,
    position: tauri::LogicalPosition<f64>,
    size: tauri::LogicalSize<f64>,
    visible: bool,
) -> Result<(), String> {
    page.with_webview(move |platform| {
        let view: gtk::Widget = platform.inner().upcast();
        if visible {
            view.set_margin_start(position.x.round() as i32);
            view.set_margin_top(position.y.round() as i32);
            view.set_size_request(size.width.round() as i32, size.height.round() as i32);
            view.show();
        } else {
            view.hide();
        }
    })
    .map_err(|error| error.to_string())
}
