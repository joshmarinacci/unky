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
