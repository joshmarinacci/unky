use tauri::{Emitter, Manager};
use webview2_com::{
    AcceleratorKeyPressedEventHandler,
    Microsoft::Web::WebView2::Win32::{
        COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN, COREWEBVIEW2_KEY_EVENT_KIND_SYSTEM_KEY_DOWN,
    },
};
use windows::Win32::UI::Input::KeyboardAndMouse::{GetKeyState, VK_CONTROL, VK_MENU, VK_SHIFT};

// Child WebView2 controllers consume accelerators before the native window menu.
// Handle only browser commands; leave editing and website input to WebView2.
fn shortcut(key: u32, ctrl: bool, shift: bool, alt: bool) -> Option<&'static str> {
    match (key, ctrl, shift, alt) {
        (0x54, true, false, false) => Some("new-tab"),
        (0x54, true, true, false) => Some("reopen-closed-tab"),
        (0x4e, true, true, false) => Some("new-private-tab"),
        (0x57, true, false, false) => Some("close-tab"),
        (0x4c, true, false, false) => Some("focus-address"),
        (0x46, true, false, false) => Some("find"),
        (0x52, true, false, false) | (0x74, false, false, false) => Some("reload"),
        (0x09, true, false, false) => Some("next-tab"),
        (0x09, true, true, false) => Some("previous-tab"),
        (0x22, true, false, false) => Some("next-tab"),
        (0x21, true, false, false) => Some("previous-tab"),
        (0x25, false, false, true) => Some("go-back"),
        (0x27, false, false, true) => Some("go-forward"),
        (0xbb, true, _, false) | (0x6b, true, false, false) => Some("zoom-in"),
        (0xbd, true, false, false) | (0x6d, true, false, false) => Some("zoom-out"),
        (0x30, true, false, false) | (0x60, true, false, false) => Some("zoom-reset"),
        (0xbc, true, false, false) => Some("settings"),
        _ => None,
    }
}

pub fn install_shortcuts(
    app: &tauri::AppHandle,
    page_label: &str,
    owner_window: &str,
) -> Result<(), String> {
    let page = app
        .get_webview(page_label)
        .ok_or("Website view is unavailable")?;
    let app = app.clone();
    let owner_window = owner_window.to_string();
    page.with_webview(move |native| unsafe {
        let handler = AcceleratorKeyPressedEventHandler::create(Box::new(move |_, args| {
            let Some(args) = args else { return Ok(()) };
            let mut kind = COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN;
            args.KeyEventKind(&mut kind)?;
            if kind != COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN
                && kind != COREWEBVIEW2_KEY_EVENT_KIND_SYSTEM_KEY_DOWN
            {
                return Ok(());
            }
            let mut key = 0;
            args.VirtualKey(&mut key)?;
            let Some(action) = shortcut(
                key,
                GetKeyState(VK_CONTROL.0 as i32) < 0,
                GetKeyState(VK_SHIFT.0 as i32) < 0,
                GetKeyState(VK_MENU.0 as i32) < 0,
            ) else {
                return Ok(());
            };
            args.SetHandled(true)?;
            let app = app.clone();
            let owner = owner_window.clone();
            // Return from the WebView2 callback before issuing native view operations.
            tauri::async_runtime::spawn_blocking(move || {
                if action.starts_with("zoom-") {
                    let state = app.state::<crate::BrowserState>();
                    let _ = crate::adjust_active_zoom(&app, &state, action, &owner);
                } else {
                    if matches!(
                        action,
                        "focus-address" | "find" | "new-tab" | "new-private-tab" | "settings"
                    ) {
                        if let Some(ui) = app.get_webview(&owner) {
                            let _ = ui.set_focus();
                        }
                    }
                    if action == "settings" {
                        let _ = app.emit_to(&owner, crate::OPEN_SETTINGS_EVENT, ());
                    } else {
                        let _ = app.emit_to(&owner, crate::SHORTCUT_EVENT, action);
                    }
                }
            });
            Ok(())
        }));
        let mut token = 0;
        if let Err(error) = native
            .controller()
            .add_AcceleratorKeyPressed(&handler, &mut token)
        {
            eprintln!("Could not install Windows browser shortcuts: {error}");
        }
    })
    .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::shortcut;

    #[test]
    fn browser_shortcuts_preserve_editing_and_unrelated_modifiers() {
        assert_eq!(shortcut(0x54, true, false, false), Some("new-tab"));
        assert_eq!(shortcut(0x54, true, true, false), Some("reopen-closed-tab"));
        assert_eq!(shortcut(0x09, true, true, false), Some("previous-tab"));
        assert_eq!(shortcut(0x25, false, false, true), Some("go-back"));
        for key in [0x43, 0x56, 0x58, 0x41, 0x5a] {
            assert_eq!(shortcut(key, true, false, false), None);
        }
        assert_eq!(shortcut(0x54, false, false, false), None);
        assert_eq!(shortcut(0x54, true, false, true), None);
    }
}
