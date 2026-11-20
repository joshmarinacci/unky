//! Apple-style Shift key equivalents for the native menu bar.
//!
//! muda stores `CmdOrCtrl+Shift+W` as the key equivalent `w` with the Command and Shift modifier
//! flags. AppKit does not match a real ⇧⌘W against that item: the key press reports `W`, so the
//! shortcut fell through to the web page (or, depending on the event, to the ⌘W item). Apple's
//! convention, which Safari uses, is the uppercase key equivalent `W` with only Command; the
//! uppercase letter implies Shift. This rewrites every such item once the menu bar is installed.

use objc2::MainThreadMarker;
use objc2_app_kit::{NSApplication, NSEventModifierFlags, NSMenu};
use objc2_foundation::NSString;

/// The Apple-style key equivalent for a lowercase letter that muda paired with the Shift flag.
pub fn apple_shift_key_equivalent(key: &str, shift: bool) -> Option<String> {
    let mut chars = key.chars();
    match (chars.next(), chars.next()) {
        (Some(letter), None) if shift && letter.is_ascii_lowercase() => {
            Some(letter.to_ascii_uppercase().to_string())
        }
        _ => None,
    }
}

fn normalize_menu(menu: &NSMenu) {
    for item in menu.itemArray().iter() {
        let mask = item.keyEquivalentModifierMask();
        let key = item.keyEquivalent().to_string();
        if let Some(uppercase) =
            apple_shift_key_equivalent(&key, mask.contains(NSEventModifierFlags::Shift))
        {
            item.setKeyEquivalent(&NSString::from_str(&uppercase));
            item.setKeyEquivalentModifierMask(mask.difference(NSEventModifierFlags::Shift));
        }
        if let Some(submenu) = item.submenu() {
            normalize_menu(&submenu);
        }
    }
}

/// Rewrite Shift+letter key equivalents in the app's main menu. Call on the main thread after
/// installing the menu bar.
pub fn normalize_shift_key_equivalents() {
    let Some(main_thread) = MainThreadMarker::new() else {
        eprintln!("Menu key equivalents can only be adjusted on the main thread");
        return;
    };
    if let Some(menu) = NSApplication::sharedApplication(main_thread).mainMenu() {
        normalize_menu(&menu);
    }
}
