//! Native AppKit overlay used while dragging a browser tab over a website view.

use block2::{DynBlock, RcBlock};
use objc2::{define_class, msg_send, rc::Retained, DefinedClass, MainThreadMarker, MainThreadOnly};
use objc2_app_kit::{NSBezierPath, NSColor, NSEvent, NSView};
use objc2_foundation::{NSObjectProtocol, NSPoint, NSRect, NSSize, NSTimer};
use std::cell::{Cell, RefCell};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DropTarget {
    Left,
    Right,
    Top,
    Bottom,
    NewWindow,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DragPreviewKind {
    Tab,
    Folder,
}

impl DragPreviewKind {
    #[cfg(all(debug_assertions, feature = "desktop-test"))]
    fn as_str(self) -> &'static str {
        match self {
            Self::Tab => "tab",
            Self::Folder => "folder",
        }
    }
}

#[cfg(all(debug_assertions, feature = "desktop-test"))]
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OverlayDiagnostics {
    pub attached: bool,
    pub visible: bool,
    pub target: Option<&'static str>,
    pub preview: Option<&'static str>,
}

impl DropTarget {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Left => "left",
            Self::Right => "right",
            Self::Top => "top",
            Self::Bottom => "bottom",
            Self::NewWindow => "new-window",
        }
    }
}

struct OverlayIvars {
    target: Cell<Option<DropTarget>>,
    preview: Cell<DragPreviewKind>,
    pointer_x: Cell<f64>,
    pointer_y: Cell<f64>,
    pointer_inside: Cell<bool>,
    test_pointer_override: Cell<bool>,
}

impl Default for OverlayIvars {
    fn default() -> Self {
        Self {
            target: Cell::new(None),
            preview: Cell::new(DragPreviewKind::Tab),
            pointer_x: Cell::new(0.0),
            pointer_y: Cell::new(0.0),
            pointer_inside: Cell::new(false),
            test_pointer_override: Cell::new(false),
        }
    }
}

define_class!(
    #[unsafe(super(NSView))]
    #[thread_kind = MainThreadOnly]
    #[name = "MyBrowserTabDragOverlay"]
    #[ivars = OverlayIvars]
    struct TabDragOverlay;

    impl TabDragOverlay {
        #[unsafe(method(isFlipped))]
        fn is_flipped(&self) -> bool { true }

        // Pointer events must keep reaching the tab list that started the drag.
        #[unsafe(method(hitTest:))]
        fn hit_test(&self, _point: NSPoint) -> *mut NSView { std::ptr::null_mut() }

        #[unsafe(method(drawRect:))]
        fn draw_rect(&self, _dirty: NSRect) {
            let bounds = self.bounds();
            if let Some(target) = self.ivars().target.get() {
                let (x, y, width, height) = target_rect(target, bounds.size.width, bounds.size.height);
                let rect = NSRect::new(NSPoint::new(x, y), NSSize::new(width, height));
                let glow = NSBezierPath::bezierPathWithRoundedRect_xRadius_yRadius(rect, 18.0, 18.0);
                NSColor::colorWithSRGBRed_green_blue_alpha(0.98, 0.49, 0.22, 0.22).setFill();
                glow.fill();
                let halo = NSBezierPath::bezierPathWithRoundedRect_xRadius_yRadius(rect, 18.0, 18.0);
                halo.setLineWidth(13.0);
                NSColor::colorWithSRGBRed_green_blue_alpha(1.0, 0.54, 0.24, 0.30).setStroke();
                halo.stroke();
                let outline = NSBezierPath::bezierPathWithRoundedRect_xRadius_yRadius(rect, 18.0, 18.0);
                outline.setLineWidth(3.0);
                NSColor::colorWithSRGBRed_green_blue_alpha(1.0, 0.62, 0.30, 0.96).setStroke();
                outline.stroke();
                return;
            }
            if !self.ivars().pointer_inside.get() {
                return;
            }

            // Website pages are native child WebViews, so the React DragOverlay cannot
            // paint above them. Tabs use the established edge targets above; only an
            // invalid folder drop needs a page-side preview here.
            if self.ivars().preview.get() == DragPreviewKind::Tab {
                return;
            }
            let width = 260.0_f64.min((bounds.size.width - 24.0).max(1.0));
            let height = 160.0_f64.min((bounds.size.height - 24.0).max(1.0));
            let x = (self.ivars().pointer_x.get() - width / 2.0)
                .clamp(12.0, (bounds.size.width - width - 12.0).max(12.0));
            let y = (self.ivars().pointer_y.get() - height / 2.0)
                .clamp(12.0, (bounds.size.height - height - 12.0).max(12.0));
            let rect = NSRect::new(NSPoint::new(x, y), NSSize::new(width, height));
            let path = NSBezierPath::bezierPathWithRoundedRect_xRadius_yRadius(rect, 9.0, 9.0);
            let (fill, stroke) = (
                NSColor::colorWithSRGBRed_green_blue_alpha(0.996, 0.886, 0.886, 0.92),
                NSColor::colorWithSRGBRed_green_blue_alpha(0.863, 0.149, 0.149, 0.98),
            );
            fill.setFill();
            path.fill();
            let outline = NSBezierPath::bezierPathWithRoundedRect_xRadius_yRadius(rect, 9.0, 9.0);
            outline.setLineWidth(2.0);
            stroke.setStroke();
            outline.stroke();
        }
    }

    unsafe impl NSObjectProtocol for TabDragOverlay {}
);

thread_local! {
    static OVERLAY: RefCell<Option<Retained<TabDragOverlay>>> = const { RefCell::new(None) };
    static POINTER_TRACKER: RefCell<Option<Retained<NSTimer>>> = const { RefCell::new(None) };
}

fn target_rect(target: DropTarget, width: f64, height: f64) -> (f64, f64, f64, f64) {
    let inset = 12.0;
    match target {
        DropTarget::Left => (
            inset,
            inset,
            (width - inset * 2.0) / 2.0,
            height - inset * 2.0,
        ),
        DropTarget::Right => (
            width / 2.0,
            inset,
            (width - inset * 2.0) / 2.0,
            height - inset * 2.0,
        ),
        DropTarget::Top => (
            inset,
            inset,
            width - inset * 2.0,
            (height - inset * 2.0) / 2.0,
        ),
        DropTarget::Bottom => (
            inset,
            height / 2.0,
            width - inset * 2.0,
            (height - inset * 2.0) / 2.0,
        ),
        DropTarget::NewWindow => (width * 0.36, inset, width * 0.28, 48.0),
    }
}

/// Fraction of the page, measured from each edge, that counts as a split drop zone.
const EDGE_BAND: f64 = 0.25;

/// Map a pointer position to a drop target. The page center returns `None` so only a
/// deliberate move to an edge (or the new-window strip) can split or move a tab.
fn target_at(point: NSPoint, width: f64, height: f64) -> Option<DropTarget> {
    if point.y < 64.0 && point.x > width * 0.30 && point.x < width * 0.70 {
        return Some(DropTarget::NewWindow);
    }
    // Normalised distance to each edge; the nearest edge inside its band wins.
    let edges = [
        (point.x / width, DropTarget::Left),
        (1.0 - point.x / width, DropTarget::Right),
        (point.y / height, DropTarget::Top),
        (1.0 - point.y / height, DropTarget::Bottom),
    ];
    edges
        .into_iter()
        .filter(|(distance, _)| *distance < EDGE_BAND)
        .min_by(|a, b| a.0.total_cmp(&b.0))
        .map(|(_, target)| target)
}

fn update_target_from_pointer(view: &TabDragOverlay) {
    if view.ivars().test_pointer_override.get() {
        return;
    }
    let Some(window) = view.window() else {
        return;
    };
    let screen_point = NSEvent::mouseLocation();
    let window_point = window.convertPointFromScreen(screen_point);
    let point = view.convertPoint_fromView(window_point, None);
    let bounds = view.bounds();
    let is_inside = point.x >= 0.0
        && point.y >= 0.0
        && point.x <= bounds.size.width
        && point.y <= bounds.size.height;
    let target = if is_inside && view.ivars().preview.get() == DragPreviewKind::Tab {
        target_at(point, bounds.size.width, bounds.size.height)
    } else {
        None
    };
    let point_changed = (view.ivars().pointer_x.get() - point.x).abs() > 0.5
        || (view.ivars().pointer_y.get() - point.y).abs() > 0.5;
    if view.ivars().target.get() != target
        || view.ivars().pointer_inside.get() != is_inside
        || point_changed
    {
        view.ivars().target.set(target);
        view.ivars().pointer_x.set(point.x);
        view.ivars().pointer_y.set(point.y);
        view.ivars().pointer_inside.set(is_inside);
        view.setNeedsDisplay(true);
    }
}

fn start_pointer_tracker(overlay: &Retained<TabDragOverlay>) {
    let overlay_address = Retained::as_ptr(overlay) as usize;
    let block = RcBlock::new(move |_timer: std::ptr::NonNull<NSTimer>| {
        // The overlay remains retained in OVERLAY until hide() invalidates this timer.
        let view = unsafe { &*(overlay_address as *const TabDragOverlay) };
        update_target_from_pointer(view);
    });
    let block: &DynBlock<dyn Fn(std::ptr::NonNull<NSTimer>)> = &block;
    let timer =
        unsafe { NSTimer::scheduledTimerWithTimeInterval_repeats_block(0.025, true, block) };
    POINTER_TRACKER.with(|slot| *slot.borrow_mut() = Some(timer));
}

/// Display and register an overlay over the native website view.
pub unsafe fn show(view: &NSView, mtm: MainThreadMarker, preview: DragPreviewKind) -> bool {
    let Some(parent) = view.superview() else {
        return false;
    };
    let frame = view.frame();
    let target = TabDragOverlay::alloc(mtm).set_ivars(OverlayIvars::default());
    let overlay: Retained<TabDragOverlay> = msg_send![super(target), initWithFrame: frame];
    overlay.ivars().preview.set(preview);
    overlay.setAutoresizingMask(view.autoresizingMask());
    parent.addSubview(&overlay);
    overlay.setNeedsDisplay(true);
    OVERLAY.with(|slot| *slot.borrow_mut() = Some(overlay.clone()));
    start_pointer_tracker(&overlay);
    true
}

/// Remove the overlay and return the zone under the pointer when the drag ended over the page.
/// A cancelled drag, or one that ended over the sidebar or the page center, returns `None`.
pub unsafe fn hide(cancelled: bool) -> Option<DropTarget> {
    POINTER_TRACKER.with(|slot| {
        if let Some(timer) = slot.borrow_mut().take() {
            timer.invalidate();
        }
    });
    let mut dropped = None;
    OVERLAY.with(|slot| {
        if let Some(overlay) = slot.borrow_mut().take() {
            if !cancelled {
                // Re-read the pointer so a drop is not decided by a stale timer tick.
                update_target_from_pointer(&overlay);
                dropped = overlay.ivars().target.get();
            }
            overlay.removeFromSuperview();
        }
    });
    dropped
}

/// Show deterministic page feedback for desktop-test screenshots.
#[cfg(all(debug_assertions, feature = "desktop-test"))]
pub unsafe fn show_test_drag_feedback() -> bool {
    OVERLAY.with(|slot| {
        let overlay = slot.borrow();
        let Some(overlay) = overlay.as_ref() else {
            return false;
        };
        let bounds = overlay.bounds();
        let is_tab = overlay.ivars().preview.get() == DragPreviewKind::Tab;
        overlay.ivars().target.set(is_tab.then_some(DropTarget::Left));
        overlay
            .ivars()
            .pointer_x
            .set(if is_tab { 1.0 } else { bounds.size.width / 2.0 });
        overlay.ivars().pointer_y.set(bounds.size.height / 2.0);
        overlay.ivars().pointer_inside.set(true);
        overlay.ivars().test_pointer_override.set(true);
        overlay.setNeedsDisplay(true);
        true
    })
}

/// Return native overlay state for the debug desktop regression test.
#[cfg(all(debug_assertions, feature = "desktop-test"))]
pub unsafe fn diagnostics() -> OverlayDiagnostics {
    OVERLAY.with(|slot| {
        let overlay = slot.borrow();
        let Some(overlay) = overlay.as_ref() else {
            return OverlayDiagnostics {
                attached: false,
                visible: false,
                target: None,
                preview: None,
            };
        };
        OverlayDiagnostics {
            attached: overlay.superview().is_some(),
            visible: !overlay.isHiddenOrHasHiddenAncestor(),
            target: overlay.ivars().target.get().map(DropTarget::as_str),
            preview: overlay
                .ivars()
                .pointer_inside
                .get()
                .then(|| overlay.ivars().preview.get().as_str()),
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(x: f64, y: f64) -> Option<DropTarget> {
        target_at(NSPoint::new(x, y), 1000.0, 800.0)
    }

    #[test]
    fn center_of_page_is_not_a_drop_target() {
        assert_eq!(at(500.0, 400.0), None);
        assert_eq!(at(300.0, 300.0), None);
    }

    #[test]
    fn edge_bands_select_the_nearest_edge() {
        assert_eq!(at(100.0, 400.0), Some(DropTarget::Left));
        assert_eq!(at(900.0, 400.0), Some(DropTarget::Right));
        assert_eq!(at(500.0, 700.0), Some(DropTarget::Bottom));
        assert_eq!(at(500.0, 150.0), Some(DropTarget::Top));
        // Corner closer to the left edge than the top edge.
        assert_eq!(at(20.0, 150.0), Some(DropTarget::Left));
    }

    #[test]
    fn new_window_strip_wins_at_top_center() {
        assert_eq!(at(500.0, 30.0), Some(DropTarget::NewWindow));
        assert_eq!(at(20.0, 30.0), Some(DropTarget::Left));
    }
}
