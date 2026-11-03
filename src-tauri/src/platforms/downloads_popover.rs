//! Native downloads popovers above the website child WebViews.
use super::security_popover::{positioning_rect, AnchorRect};
use objc2::{
    define_class, msg_send, rc::Retained, sel, DefinedClass, MainThreadMarker, MainThreadOnly,
};
use objc2_app_kit::{
    NSButton, NSPopover, NSPopoverBehavior, NSTextField, NSView, NSViewController,
};
use objc2_foundation::{NSObject, NSObjectProtocol, NSPoint, NSRect, NSRectEdge, NSSize, NSString};
use std::{cell::RefCell, collections::HashMap, ffi::c_void, sync::Arc};

pub type Reveal = Arc<dyn Fn(String) + Send + Sync>;

#[derive(Clone, PartialEq)]
pub struct DownloadRow {
    pub id: String,
    pub filename: String,
    pub status: String,
    pub completed: bool,
}

struct RevealIvars {
    id: String,
    reveal: Reveal,
}
define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "UnkyRevealDownloadTarget"]
    #[ivars = RevealIvars]
    struct RevealTarget;
    unsafe impl NSObjectProtocol for RevealTarget {}
    impl RevealTarget {
        #[unsafe(method(reveal:))]
        fn reveal(&self, _sender: &NSButton) { (self.ivars().reveal)(self.ivars().id.clone()); }
    }
);

struct State {
    popover: Retained<NSPopover>,
    rows: Option<Vec<DownloadRow>>,
    targets: Vec<Retained<RevealTarget>>,
}
thread_local! {
    static POPOVERS: RefCell<HashMap<String, State>> = RefCell::new(HashMap::new());
}

pub unsafe fn remove(owner: &str) {
    POPOVERS.with(|slot| {
        if let Some(state) = slot.borrow_mut().remove(owner) {
            state.popover.close();
        }
    });
}

unsafe fn label(root: &NSView, text: &str, x: f64, y: f64, width: f64, mtm: MainThreadMarker) {
    let field = NSTextField::labelWithString(&NSString::from_str(text), mtm);
    field.setFrame(NSRect::new(NSPoint::new(x, y), NSSize::new(width, 22.0)));
    field.setToolTip(Some(&NSString::from_str(text)));
    root.addSubview(&field);
}

unsafe fn refresh(
    state: &mut State,
    rows: Vec<DownloadRow>,
    reveal: Reveal,
    mtm: MainThreadMarker,
) {
    if state.rows.as_ref() == Some(&rows) {
        return;
    }
    let height = 60.0 + (rows.len().max(1) as f64 * 56.0);
    let root = NSView::initWithFrame(
        NSView::alloc(mtm),
        NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(380.0, height)),
    );
    let mut targets = Vec::new();
    label(&root, "Downloads", 18.0, height - 36.0, 344.0, mtm);
    if rows.is_empty() {
        label(
            &root,
            "No recent downloads",
            18.0,
            height - 80.0,
            344.0,
            mtm,
        );
    }
    for (index, row) in rows.iter().enumerate() {
        let y = height - 68.0 - index as f64 * 56.0;
        label(&root, &row.filename, 18.0, y, 344.0, mtm);
        label(&root, &row.status, 18.0, y - 23.0, 224.0, mtm);
        if row.completed {
            let allocated = RevealTarget::alloc(mtm).set_ivars(RevealIvars {
                id: row.id.clone(),
                reveal: reveal.clone(),
            });
            let target: Retained<RevealTarget> = msg_send![super(allocated), init];
            let button = NSButton::buttonWithTitle_target_action(
                &NSString::from_str("Show in Finder"),
                Some(&target),
                Some(sel!(reveal:)),
                mtm,
            );
            button.setFrame(NSRect::new(
                NSPoint::new(246.0, y - 25.0),
                NSSize::new(118.0, 26.0),
            ));
            root.addSubview(&button);
            targets.push(target);
        }
    }
    let controller = NSViewController::init(NSViewController::alloc(mtm));
    controller.setView(&root);
    state.popover.setContentViewController(Some(&controller));
    state.popover.setContentSize(NSSize::new(380.0, height));
    state.rows = Some(rows);
    state.targets = targets;
}

/// `update` never opens a dismissed popover. Each browser window owns its instance.
pub unsafe fn control(
    main_view: *mut c_void,
    owner: &str,
    action: &str,
    anchor: AnchorRect,
    inset: f64,
    rows: Vec<DownloadRow>,
    reveal: Reveal,
) -> bool {
    let Some(mtm) = MainThreadMarker::new() else {
        return false;
    };
    POPOVERS.with(|slot| {
        let mut popovers = slot.borrow_mut();
        if action == "close" {
            if let Some(state) = popovers.get(owner) {
                state.popover.close();
            }
            return false;
        }
        if action == "update"
            && !popovers
                .get(owner)
                .is_some_and(|state| state.popover.isShown())
        {
            return false;
        }
        let state = popovers.entry(owner.to_string()).or_insert_with(|| {
            let popover = NSPopover::init(NSPopover::alloc(mtm));
            popover.setBehavior(NSPopoverBehavior::Transient);
            State {
                popover,
                rows: None,
                targets: Vec::new(),
            }
        });
        if action == "toggle" && state.popover.isShown() {
            state.popover.close();
            return false;
        }
        refresh(state, rows, reveal, mtm);
        if action != "update" {
            let view = &*(main_view as *mut NSView);
            let edge = if view.isFlipped() {
                NSRectEdge::MaxY
            } else {
                NSRectEdge::MinY
            };
            state.popover.showRelativeToRect_ofView_preferredEdge(
                positioning_rect(view, anchor, inset),
                view,
                edge,
            );
        }
        state.popover.isShown()
    })
}
