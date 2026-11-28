//! Native user-activation tracking for commands that website pages can invoke.
//!
//! Website child WebViews can call their granted Tauri commands directly from page
//! JavaScript, so a page-reported click proves nothing. Instead, the platform layer
//! records real input events here (an AppKit local event monitor on macOS, GTK
//! button and key handlers on each page WebView on Linux, the system's last-input
//! tick on Windows), and page commands check that a recent,
//! unconsumed gesture exists before they open tabs, windows, or other browsers.

use std::collections::{HashMap, VecDeque};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

/// How long a native gesture authorizes page actions, like a transient activation.
pub const GESTURE_LIFETIME: Duration = Duration::from_secs(1);
/// Tabs, windows, and external-browser launches one page may start per window.
pub const PAGE_OPEN_LIMIT: usize = 5;
/// Context-menu lookups (tab folders, installed browsers) one page may make per window.
pub const PAGE_QUERY_LIMIT: usize = 10;
pub const PAGE_RATE_WINDOW: Duration = Duration::from_secs(10);

/// Whether this platform reports native input. Elsewhere gesture checks pass and only
/// the rate limits apply.
pub const NATIVE_GESTURES: bool = cfg!(any(
    target_os = "macos",
    target_os = "windows",
    target_os = "linux"
));

#[derive(Default)]
struct Inner {
    /// The newest native input: a platform-specific ID and when it was first seen.
    last: Option<(u64, Instant)>,
    /// The input ID already spent on an open action.
    consumed: Option<u64>,
    buckets: HashMap<String, VecDeque<Instant>>,
}

#[derive(Default)]
pub struct ActivationTracker {
    inner: Mutex<Inner>,
}

impl ActivationTracker {
    /// Record native input. Re-recording the same ID keeps its first timestamp.
    pub fn record(&self, id: u64, at: Instant) {
        if let Ok(mut inner) = self.inner.lock() {
            if inner.last.is_none_or(|(last_id, _)| last_id != id) {
                inner.last = Some((id, at));
            }
        }
    }

    fn live_gesture(inner: &Inner, now: Instant) -> Option<u64> {
        let (id, at) = inner.last?;
        (inner.consumed != Some(id) && now.saturating_duration_since(at) <= GESTURE_LIFETIME)
            .then_some(id)
    }

    /// True when recent native input has not been spent yet. A poisoned lock denies.
    pub fn has_gesture(&self, now: Instant) -> bool {
        self.inner
            .lock()
            .is_ok_and(|inner| Self::live_gesture(&inner, now).is_some())
    }

    /// Spend the current gesture so one click cannot authorize several opens.
    pub fn consume_gesture(&self, now: Instant) -> bool {
        let Ok(mut inner) = self.inner.lock() else {
            return false;
        };
        match Self::live_gesture(&inner, now) {
            Some(id) => {
                inner.consumed = Some(id);
                true
            }
            None => false,
        }
    }

    /// Sliding-window rate limit keyed by action and source tab.
    pub fn allow(&self, key: &str, limit: usize, window: Duration, now: Instant) -> bool {
        let Ok(mut inner) = self.inner.lock() else {
            return false;
        };
        let bucket = inner.buckets.entry(key.to_string()).or_default();
        while bucket
            .front()
            .is_some_and(|at| now.saturating_duration_since(*at) > window)
        {
            bucket.pop_front();
        }
        if bucket.len() >= limit {
            return false;
        }
        bucket.push_back(now);
        true
    }

    /// Drop rate-limit history for a closed tab.
    pub fn forget_tab(&self, tab_id: &str) {
        if let Ok(mut inner) = self.inner.lock() {
            let suffix = format!(":{tab_id}");
            inner.buckets.retain(|key, _| !key.ends_with(&suffix));
        }
    }
}

pub fn tracker() -> &'static ActivationTracker {
    static TRACKER: OnceLock<ActivationTracker> = OnceLock::new();
    TRACKER.get_or_init(ActivationTracker::default)
}

/// Called for each real mouse-down and key-down: by the macOS event monitor, and by the
/// GTK handlers on each page WebView on Linux.
#[cfg(any(target_os = "macos", target_os = "linux"))]
pub fn record_native_gesture() {
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT_ID: AtomicU64 = AtomicU64::new(1);
    tracker().record(NEXT_ID.fetch_add(1, Ordering::Relaxed), Instant::now());
}

/// Windows has no app event monitor here, so read the system's last-input tick.
/// The tick value doubles as the input ID, so one input is consumed only once.
#[cfg(target_os = "windows")]
fn sync_platform_input() {
    use windows::Win32::System::SystemInformation::GetTickCount;
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};
    let mut info = LASTINPUTINFO {
        cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32,
        dwTime: 0,
    };
    #[allow(unused_unsafe)]
    let (ok, now_tick) = unsafe { (GetLastInputInfo(&mut info).as_bool(), GetTickCount()) };
    if ok {
        let age = Duration::from_millis(u64::from(now_tick.wrapping_sub(info.dwTime)));
        let now = Instant::now();
        tracker().record(u64::from(info.dwTime), now.checked_sub(age).unwrap_or(now));
    }
}

#[cfg(not(target_os = "windows"))]
fn sync_platform_input() {}

/// Check for a recent native gesture without spending it (menu lookups).
pub fn page_has_gesture() -> bool {
    if !NATIVE_GESTURES {
        return true;
    }
    sync_platform_input();
    tracker().has_gesture(Instant::now())
}

/// Spend a recent native gesture (tab, window, and external-browser opens).
pub fn page_consume_gesture() -> bool {
    if !NATIVE_GESTURES {
        return true;
    }
    sync_platform_input();
    tracker().consume_gesture(Instant::now())
}

pub fn page_rate_allows(action: &str, tab_id: &str, limit: usize) -> bool {
    tracker().allow(
        &format!("{action}:{tab_id}"),
        limit,
        PAGE_RATE_WINDOW,
        Instant::now(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Regression: Linux once had no native input, so every page gesture check passed.
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[test]
    fn page_actions_need_a_recorded_native_gesture() {
        assert!(NATIVE_GESTURES);
        assert!(!page_consume_gesture(), "no input has been recorded yet");
        record_native_gesture();
        assert!(page_has_gesture());
        assert!(page_consume_gesture());
        assert!(!page_consume_gesture(), "one gesture authorizes one open");
    }

    #[test]
    fn gesture_expires_after_its_lifetime() {
        let tracker = ActivationTracker::default();
        let start = Instant::now();
        assert!(!tracker.has_gesture(start));
        tracker.record(1, start);
        assert!(tracker.has_gesture(start + Duration::from_millis(900)));
        assert!(!tracker.has_gesture(start + GESTURE_LIFETIME + Duration::from_millis(1)));
    }

    #[test]
    fn one_gesture_authorizes_one_open() {
        let tracker = ActivationTracker::default();
        let start = Instant::now();
        tracker.record(7, start);
        assert!(tracker.consume_gesture(start));
        assert!(!tracker.consume_gesture(start));
        assert!(!tracker.has_gesture(start));
        // Re-reading the same input (Windows polls its last-input tick) stays spent.
        tracker.record(7, start + Duration::from_millis(10));
        assert!(!tracker.consume_gesture(start + Duration::from_millis(10)));
        tracker.record(8, start + Duration::from_millis(20));
        assert!(tracker.consume_gesture(start + Duration::from_millis(20)));
    }

    #[test]
    fn checking_a_gesture_does_not_spend_it() {
        let tracker = ActivationTracker::default();
        let start = Instant::now();
        tracker.record(3, start);
        assert!(tracker.has_gesture(start));
        assert!(tracker.has_gesture(start));
        assert!(tracker.consume_gesture(start));
    }

    #[test]
    fn rerecording_an_input_keeps_its_first_timestamp() {
        let tracker = ActivationTracker::default();
        let start = Instant::now();
        tracker.record(4, start);
        tracker.record(4, start + Duration::from_secs(5));
        assert!(!tracker.has_gesture(start + Duration::from_secs(5)));
    }

    #[test]
    fn rate_limit_slides_and_is_per_key() {
        let tracker = ActivationTracker::default();
        let start = Instant::now();
        let window = Duration::from_secs(10);
        for _ in 0..3 {
            assert!(tracker.allow("open:tab-1", 3, window, start));
        }
        assert!(!tracker.allow("open:tab-1", 3, window, start));
        assert!(tracker.allow("open:tab-2", 3, window, start));
        assert!(tracker.allow("open:tab-1", 3, window, start + Duration::from_secs(11)));
    }

    #[test]
    fn forgetting_a_tab_clears_only_its_buckets() {
        let tracker = ActivationTracker::default();
        let now = Instant::now();
        let window = Duration::from_secs(10);
        assert!(tracker.allow("open:tab-1", 1, window, now));
        assert!(tracker.allow("open:tab-11", 1, window, now));
        tracker.forget_tab("tab-1");
        assert!(tracker.allow("open:tab-1", 1, window, now));
        assert!(!tracker.allow("open:tab-11", 1, window, now));
    }
}
