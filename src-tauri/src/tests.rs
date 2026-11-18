use super::{
    allowed_navigation_url, parse_launch_args, persist_session, read_session, split_partner_id,
    validated_session_tab, SplitLayout, SplitOrientation,
};
use crate::browser::tabs::{BrowserState, SessionTab, TabState};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

static TEMP_SESSION_ID: AtomicU64 = AtomicU64::new(0);

fn temporary_session_path() -> std::path::PathBuf {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    std::env::temp_dir()
        .join(format!(
            "my-browser-session-test-{}-{unique}-{}",
            std::process::id(),
            TEMP_SESSION_ID.fetch_add(1, Ordering::Relaxed)
        ))
        .join("session.json")
}

#[test]
fn navigation_accepts_http_and_https() {
    assert!(allowed_navigation_url("http://example.com/").is_ok());
    assert!(allowed_navigation_url("https://example.com/path").is_ok());
}

#[test]
fn split_context_menu_resolves_only_the_opposite_split_tab() {
    let split = SplitLayout {
        first_tab_id: "tab-left".into(),
        second_tab_id: "tab-right".into(),
        orientation: SplitOrientation::Horizontal,
        first_pane_percent: 50,
    };
    assert_eq!(split_partner_id(&split, "tab-left"), Some("tab-right"));
    assert_eq!(split_partner_id(&split, "tab-right"), Some("tab-left"));
    assert_eq!(split_partner_id(&split, "tab-outside"), None);
}

#[test]
fn external_browser_context_action_accepts_only_safe_link_urls() {
    assert!(allowed_navigation_url("https://example.com/link").is_ok());
    assert!(allowed_navigation_url("javascript:alert(1)").is_err());
    assert!(allowed_navigation_url("https://user:pass@example.com/").is_err());
}

#[test]
fn command_line_launch_uses_the_same_web_url_validation_as_navigation() {
    let request = parse_launch_args(["mybrowser", "example.com", "--private"].map(str::to_string))
        .unwrap()
        .unwrap();
    assert_eq!(request.url, "https://example.com/");
    assert!(request.private);
    assert!(parse_launch_args(["mybrowser", "file:///tmp/item"].map(str::to_string)).is_err());
}

#[test]
fn navigation_rejects_privileged_schemes_and_credentials() {
    assert!(allowed_navigation_url("javascript:alert(1)").is_err());
    assert!(allowed_navigation_url("file:///etc/passwd").is_err());
    assert!(allowed_navigation_url("https://user:pass@example.com/").is_err());
}

#[test]
fn session_persistence_round_trips_tab_order_selection_and_recently_closed() {
    let path = temporary_session_path();
    let state = BrowserState::default();
    *state.session_file.lock().unwrap() = Some(path.clone());

    let mut first = TabState::new("tab-1".into(), "https://example.com/first".into(), false);
    first.title = "First page".into();
    let mut second = TabState::new("tab-2".into(), "https://example.com/second".into(), true);
    second.title = "Second page".into();
    second.zoom = 1.4;
    *state.data.lock().unwrap() = vec![first, second];
    *state.recently_closed.lock().unwrap() = vec![SessionTab {
        id: "tab-3".into(),
        url: "https://example.com/closed".into(),
        title: "Closed page".into(),
        zoom: 1.2,
    }];

    persist_session(&state).unwrap();
    let restored = read_session(&path);

    assert_eq!(restored.version, 1);
    assert_eq!(restored.tabs.len(), 2);
    assert_eq!(restored.tabs[0].url, "https://example.com/first");
    assert_eq!(restored.tabs[1].title, "Second page");
    assert_eq!(restored.tabs[1].zoom, 1.4);
    assert_eq!(restored.active_tab_id, "tab-2");
    assert_eq!(restored.recently_closed[0].id, "tab-3");
    assert_eq!(
        restored.recently_closed[0].url,
        "https://example.com/closed"
    );

    std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
}

#[test]
fn session_restore_rejects_invalid_urls_and_tab_ids() {
    let invalid_url = SessionTab {
        id: "tab-1".into(),
        url: "javascript:alert(1)".into(),
        title: "Bad URL".into(),
        zoom: 1.0,
    };
    let invalid_id = SessionTab {
        id: "page-1".into(),
        url: "https://example.com/".into(),
        title: "Bad ID".into(),
        zoom: 1.0,
    };

    assert!(validated_session_tab(invalid_url).is_none());
    assert!(validated_session_tab(invalid_id).is_none());
}

#[test]
fn session_restore_ignores_unsupported_file_versions() {
    let path = temporary_session_path();
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(
        &path,
        r#"{"version":2,"tabs":[],"activeTabId":"","recentlyClosed":[]}"#,
    )
    .unwrap();

    let restored = read_session(&path);

    assert_eq!(restored.version, 1);
    assert!(restored.tabs.is_empty());
    assert!(restored.recently_closed.is_empty());
    std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
}
