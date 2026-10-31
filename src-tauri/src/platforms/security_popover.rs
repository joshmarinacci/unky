//! Native macOS security popover anchored to the browser toolbar.

use objc2::{MainThreadMarker, MainThreadOnly};
use objc2_app_kit::{NSPopover, NSPopoverBehavior, NSTextField, NSView, NSViewController};
use objc2_foundation::{NSPoint, NSRect, NSRectEdge, NSSize, NSString};
use objc2_web_kit::WKWebView;
use std::{cell::RefCell, ffi::c_void};

#[derive(Clone, Copy)]
pub struct AnchorRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Clone)]
pub struct SecurityInfo {
    pub origin: String,
    pub secure_https: bool,
    pub location: String,
    pub camera: String,
    pub microphone: String,
    pub playing_audio: bool,
}

struct PopoverState {
    popover: objc2::rc::Retained<NSPopover>,
    origin: objc2::rc::Retained<NSTextField>,
    connection: objc2::rc::Retained<NSTextField>,
    location: objc2::rc::Retained<NSTextField>,
    camera: objc2::rc::Retained<NSTextField>,
    microphone: objc2::rc::Retained<NSTextField>,
    audio: objc2::rc::Retained<NSTextField>,
}

thread_local! {
    static POPOVER: RefCell<Option<PopoverState>> = const { RefCell::new(None) };
}

unsafe fn make_label(
    text: &str,
    rect: NSRect,
    mtm: MainThreadMarker,
) -> objc2::rc::Retained<NSTextField> {
    let label = NSTextField::labelWithString(&NSString::from_str(text), mtm);
    label.setFrame(rect);
    label
}

unsafe fn create_popover(mtm: MainThreadMarker) -> PopoverState {
    let root = NSView::initWithFrame(
        NSView::alloc(mtm),
        NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(330.0, 300.0)),
    );
    let origin = make_label(
        "",
        NSRect::new(NSPoint::new(18.0, 258.0), NSSize::new(294.0, 20.0)),
        mtm,
    );
    let connection = make_label(
        "",
        NSRect::new(NSPoint::new(18.0, 196.0), NSSize::new(294.0, 22.0)),
        mtm,
    );
    let location = make_label(
        "",
        NSRect::new(NSPoint::new(18.0, 133.0), NSSize::new(294.0, 22.0)),
        mtm,
    );
    let camera = make_label(
        "",
        NSRect::new(NSPoint::new(18.0, 105.0), NSSize::new(294.0, 22.0)),
        mtm,
    );
    let microphone = make_label(
        "",
        NSRect::new(NSPoint::new(18.0, 77.0), NSSize::new(294.0, 22.0)),
        mtm,
    );
    let audio = make_label(
        "",
        NSRect::new(NSPoint::new(18.0, 27.0), NSSize::new(294.0, 22.0)),
        mtm,
    );
    let title = make_label(
        "Page security",
        NSRect::new(NSPoint::new(18.0, 270.0), NSSize::new(294.0, 22.0)),
        mtm,
    );
    let connection_heading = make_label(
        "CONNECTION",
        NSRect::new(NSPoint::new(18.0, 221.0), NSSize::new(294.0, 18.0)),
        mtm,
    );
    let permission_heading = make_label(
        "PERMISSIONS",
        NSRect::new(NSPoint::new(18.0, 158.0), NSSize::new(294.0, 18.0)),
        mtm,
    );
    let activity_heading = make_label(
        "ACTIVITY",
        NSRect::new(NSPoint::new(18.0, 52.0), NSSize::new(294.0, 18.0)),
        mtm,
    );
    for label in [
        &title,
        &connection_heading,
        &permission_heading,
        &activity_heading,
    ] {
        label.setFrameSize(NSSize::new(294.0, 20.0));
    }
    root.addSubview(&title);
    root.addSubview(&origin);
    root.addSubview(&connection_heading);
    root.addSubview(&connection);
    root.addSubview(&permission_heading);
    root.addSubview(&location);
    root.addSubview(&camera);
    root.addSubview(&microphone);
    root.addSubview(&activity_heading);
    root.addSubview(&audio);
    let controller = NSViewController::init(NSViewController::alloc(mtm));
    controller.setView(&root);
    let popover = NSPopover::init(NSPopover::alloc(mtm));
    popover.setBehavior(NSPopoverBehavior::Transient);
    popover.setContentSize(NSSize::new(330.0, 300.0));
    popover.setContentViewController(Some(&controller));
    PopoverState {
        popover,
        origin,
        connection,
        location,
        camera,
        microphone,
        audio,
    }
}

unsafe fn set_label(label: &NSTextField, value: &str) {
    label.setStringValue(&NSString::from_str(value));
}

unsafe fn update_labels(state: &PopoverState, info: &SecurityInfo) {
    set_label(&state.origin, &info.origin);
    set_label(
        &state.connection,
        if info.secure_https {
            "✓  Secure HTTPS connection"
        } else {
            "!  Not a validated HTTPS connection"
        },
    );
    set_label(
        &state.location,
        &format!("Location     {}", permission_label(&info.location)),
    );
    set_label(
        &state.camera,
        &format!("Camera       {}", permission_label(&info.camera)),
    );
    set_label(
        &state.microphone,
        &format!("Microphone   {}", permission_label(&info.microphone)),
    );
    set_label(
        &state.audio,
        &format!(
            "Audio        {}",
            if info.playing_audio {
                "Playing"
            } else {
                "Not playing"
            }
        ),
    );
}

fn permission_label(state: &str) -> &str {
    match state {
        "granted" => "Allowed",
        "denied" => "Blocked",
        "prompt" => "Ask first",
        "unsupported" => "Not reported",
        _ => "Checking…",
    }
}

unsafe fn positioning_rect(view: &NSView, anchor: AnchorRect, titlebar_inset: f64) -> NSRect {
    let height = view.bounds().size.height;
    // Tauri's main WKWebView viewport starts below macOS's unified titlebar inset,
    // which is zero in full screen.
    // DOM client rects use a top-left origin. WKWebView commonly exposes flipped
    // coordinates too, while a plain NSView uses AppKit's bottom-left origin.
    let y = if view.isFlipped() {
        anchor.y + titlebar_inset
    } else {
        height - anchor.y - anchor.height - titlebar_inset
    };
    NSRect::new(
        NSPoint::new(anchor.x, y),
        NSSize::new(anchor.width, anchor.height),
    )
}

/// Toggle and update the native popover. `main_view` is Tauri's primary WKWebView.
pub unsafe fn toggle(
    main_view: *mut c_void,
    anchor: AnchorRect,
    info: SecurityInfo,
    titlebar_inset: f64,
) -> bool {
    let Some(mtm) = MainThreadMarker::new() else {
        return false;
    };
    let view = &*(main_view as *mut NSView);
    POPOVER.with(|slot| {
        let mut slot = slot.borrow_mut();
        let state = slot.get_or_insert_with(|| create_popover(mtm));
        update_labels(state, &info);
        if state.popover.isShown() {
            state.popover.close();
            false
        } else {
            state.popover.showRelativeToRect_ofView_preferredEdge(
                positioning_rect(view, anchor, titlebar_inset),
                view,
                NSRectEdge::MinY,
            );
            state.popover.isShown()
        }
    })
}

/// Refresh visible popover values and report whether AppKit has kept it open.
pub unsafe fn update(
    main_view: *mut c_void,
    anchor: AnchorRect,
    info: SecurityInfo,
    titlebar_inset: f64,
) -> bool {
    let Some(mtm) = MainThreadMarker::new() else {
        return false;
    };
    let view = &*(main_view as *mut WKWebView as *mut NSView);
    POPOVER.with(|slot| {
        let mut slot = slot.borrow_mut();
        let Some(state) = slot.as_mut() else {
            return false;
        };
        update_labels(state, &info);
        if state.popover.isShown() {
            state.popover.showRelativeToRect_ofView_preferredEdge(
                positioning_rect(view, anchor, titlebar_inset),
                view,
                NSRectEdge::MinY,
            );
        }
        let _ = mtm;
        state.popover.isShown()
    })
}
