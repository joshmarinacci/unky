//! Native split divider and active-pane outline above the website WebViews.

use objc2::{define_class, msg_send, rc::Retained, DefinedClass, MainThreadMarker, MainThreadOnly};
use objc2_app_kit::{NSBezierPath, NSColor, NSEvent, NSView};
use objc2_foundation::{NSObjectProtocol, NSPoint, NSRect, NSSize};
use std::{cell::RefCell, sync::Arc};

type RatioChanged = Arc<dyn Fn(u8) + Send + Sync>;

struct OverlayIvars {
    horizontal: RefCell<bool>,
    first_percent: RefCell<u8>,
    active_first: RefCell<bool>,
    first_pane: RefCell<NSRect>,
    second_pane: RefCell<NSRect>,
    on_change: RefCell<Option<RatioChanged>>,
}

impl Default for OverlayIvars {
    fn default() -> Self {
        Self {
            horizontal: RefCell::new(true),
            first_percent: RefCell::new(50),
            active_first: RefCell::new(true),
            first_pane: RefCell::new(NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(0.0, 0.0))),
            second_pane: RefCell::new(NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(0.0, 0.0))),
            on_change: RefCell::new(None),
        }
    }
}

define_class!(
    #[unsafe(super(NSView))]
    #[thread_kind = MainThreadOnly]
    #[name = "MyBrowserSplitOverlay"]
    #[ivars = OverlayIvars]
    struct SplitOverlay;

    impl SplitOverlay {
        #[unsafe(method(isFlipped))]
        fn is_flipped(&self) -> bool { true }

        #[unsafe(method(drawRect:))]
        fn draw_rect(&self, _dirty: NSRect) {
            let horizontal = *self.ivars().horizontal.borrow();
            let active_first = *self.ivars().active_first.borrow();
            let first = *self.ivars().first_pane.borrow();
            let second = *self.ivars().second_pane.borrow();
            let center = split_center(first, second, horizontal);
            let area = pane_union(first, second);
            for (rect, active) in [(first, active_first), (second, !active_first)] {
                let inset = 1.5;
                let outline_rect = NSRect::new(
                    NSPoint::new(rect.origin.x + inset, rect.origin.y + inset),
                    NSSize::new((rect.size.width - inset * 2.0).max(0.0), (rect.size.height - inset * 2.0).max(0.0)),
                );
                let outline = NSBezierPath::bezierPathWithRoundedRect_xRadius_yRadius(outline_rect, 8.0, 8.0);
                outline.setLineWidth(if active { 3.0 } else { 1.0 });
                if active {
                    NSColor::colorWithSRGBRed_green_blue_alpha(1.0, 0.50, 0.24, 0.92).setStroke();
                } else {
                    NSColor::colorWithSRGBRed_green_blue_alpha(1.0, 0.50, 0.24, 0.20).setStroke();
                }
                outline.stroke();
            }
            let handle_rect = if horizontal {
                NSRect::new(NSPoint::new(center - 7.0, area.origin.y + area.size.height / 2.0 - 28.0), NSSize::new(14.0, 56.0))
            } else {
                NSRect::new(NSPoint::new(area.origin.x + area.size.width / 2.0 - 28.0, center - 7.0), NSSize::new(56.0, 14.0))
            };
            let handle = NSBezierPath::bezierPathWithRoundedRect_xRadius_yRadius(handle_rect, 7.0, 7.0);
            NSColor::colorWithSRGBRed_green_blue_alpha(1.0, 0.55, 0.29, 0.95).setFill();
            handle.fill();
        }

        #[unsafe(method(hitTest:))]
        fn hit_test(&self, point: NSPoint) -> *mut NSView {
            let parent = unsafe { self.superview() };
            let p = self.convertPoint_fromView(point, parent.as_deref());
            let horizontal = *self.ivars().horizontal.borrow();
            let center = split_center(*self.ivars().first_pane.borrow(), *self.ivars().second_pane.borrow(), horizontal);
            let coordinate = if *self.ivars().horizontal.borrow() { p.x } else { p.y };
            if (coordinate - center).abs() <= 15.0 {
                self as *const Self as *mut NSView
            } else {
                std::ptr::null_mut()
            }
        }

        #[unsafe(method(mouseDown:))]
        fn mouse_down(&self, _event: &NSEvent) {}

        #[unsafe(method(mouseDragged:))]
        fn mouse_dragged(&self, event: &NSEvent) {
            let point = self.convertPoint_fromView(event.locationInWindow(), None);
            let horizontal = *self.ivars().horizontal.borrow();
            let first = *self.ivars().first_pane.borrow();
            let second = *self.ivars().second_pane.borrow();
            let area = pane_union(first, second);
            let start = if horizontal { area.origin.x } else { area.origin.y };
            let extent = (if horizontal { area.size.width } else { area.size.height }) - 6.0;
            if extent <= 1.0 { return; }
            let coordinate = if horizontal { point.x } else { point.y };
            let percent = (((coordinate - start - 3.0) / extent * 100.0).round() as i16).clamp(20, 80) as u8;
            if percent != *self.ivars().first_percent.borrow() {
                *self.ivars().first_percent.borrow_mut() = percent;
                self.setNeedsDisplay(true);
                if let Some(callback) = self.ivars().on_change.borrow().as_ref() { callback(percent); }
            }
        }

        #[unsafe(method(mouseUp:))]
        fn mouse_up(&self, _event: &NSEvent) {
            if let Some(callback) = self.ivars().on_change.borrow().as_ref() {
                callback(*self.ivars().first_percent.borrow());
            }
        }
    }

    unsafe impl NSObjectProtocol for SplitOverlay {}
);

thread_local! {
    static OVERLAY: RefCell<Option<Retained<SplitOverlay>>> = const { RefCell::new(None) };
}

fn split_center(first: NSRect, second: NSRect, horizontal: bool) -> f64 {
    if horizontal {
        (first.origin.x + first.size.width + second.origin.x) / 2.0
    } else {
        (first.origin.y + first.size.height + second.origin.y) / 2.0
    }
}

fn pane_union(first: NSRect, second: NSRect) -> NSRect {
    let left = first.origin.x.min(second.origin.x);
    let top = first.origin.y.min(second.origin.y);
    let right = (first.origin.x + first.size.width).max(second.origin.x + second.size.width);
    let bottom = (first.origin.y + first.size.height).max(second.origin.y + second.size.height);
    NSRect::new(
        NSPoint::new(left, top),
        NSSize::new(right - left, bottom - top),
    )
}

/// Keep a native divider aligned with the browser content and its two child WebViews.
pub unsafe fn update(
    view: &NSView,
    second_frame: NSRect,
    horizontal: bool,
    first_percent: u8,
    active_first: bool,
    on_change: RatioChanged,
    mtm: MainThreadMarker,
) {
    let Some(parent) = view.superview() else {
        return;
    };
    let frame = parent.bounds();
    OVERLAY.with(|slot| {
        let mut slot = slot.borrow_mut();
        if slot
            .as_ref()
            .is_some_and(|overlay| overlay.superview().is_none())
        {
            *slot = None;
        }
        if slot.is_none() {
            let object = SplitOverlay::alloc(mtm).set_ivars(OverlayIvars::default());
            let overlay: Retained<SplitOverlay> = msg_send![super(object), initWithFrame: frame];
            parent.addSubview(&overlay);
            *slot = Some(overlay);
        }
        if let Some(overlay) = slot.as_ref() {
            let first_frame = view.frame();
            let first_pane = overlay.convertRect_fromView(first_frame, Some(&parent));
            let second_pane = overlay.convertRect_fromView(second_frame, Some(&parent));
            *overlay.ivars().horizontal.borrow_mut() = horizontal;
            *overlay.ivars().first_percent.borrow_mut() = first_percent.clamp(20, 80);
            *overlay.ivars().active_first.borrow_mut() = active_first;
            *overlay.ivars().first_pane.borrow_mut() = first_pane;
            *overlay.ivars().second_pane.borrow_mut() = second_pane;
            *overlay.ivars().on_change.borrow_mut() = Some(on_change);
            overlay.setFrame(frame);
            overlay.setNeedsDisplay(true);
        }
    });
}

pub unsafe fn hide() {
    OVERLAY.with(|slot| {
        if let Some(overlay) = slot.borrow_mut().take() {
            overlay.removeFromSuperview();
        }
    });
}
