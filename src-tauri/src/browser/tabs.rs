use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use url::Url;

pub use super::database::HistoryEntry;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TabState {
    pub id: String,
    #[serde(default = "default_window_label")]
    pub window_label: String,
    pub url: String,
    pub title: String,
    pub loading: bool,
    pub can_go_back: bool,
    pub can_go_forward: bool,
    pub active: bool,
    #[serde(default)]
    pub private: bool,
    #[serde(default = "default_zoom")]
    pub zoom: f64,
    #[serde(skip)]
    history: Vec<String>,
    #[serde(skip)]
    history_index: usize,
}

fn default_zoom() -> f64 {
    1.0
}

fn default_window_label() -> String {
    "main".into()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserSnapshot {
    pub tabs: Vec<TabState>,
    pub active_tab_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SplitLayout {
    pub first_tab_id: String,
    pub second_tab_id: String,
    pub orientation: SplitOrientation,
    #[serde(default = "default_split_ratio")]
    pub first_pane_percent: u8,
}

/// Whether a tab's page is on screen: Settings is closed and the tab is active or is
/// half of the split that holds its window's active tab. Matches `position_tabs`.
/// Back/forward entries kept per tab.
pub const MAX_TAB_HISTORY: usize = 100;

pub fn is_tab_visible(
    tabs: &[TabState],
    split: Option<&SplitLayout>,
    settings_open: bool,
    tab_id: &str,
) -> bool {
    let Some(tab) = tabs.iter().find(|tab| tab.id == tab_id) else {
        return false;
    };
    if settings_open || tab.url.is_empty() {
        return false;
    }
    if tab.active {
        return true;
    }
    split.is_some_and(|layout| {
        (layout.first_tab_id == tab_id || layout.second_tab_id == tab_id)
            && tabs.iter().any(|other| {
                other.window_label == tab.window_label
                    && other.active
                    && (layout.first_tab_id == other.id || layout.second_tab_id == other.id)
            })
    })
}

fn default_split_ratio() -> u8 {
    50
}

impl SplitLayout {
    pub fn contains(&self, tab_id: &str) -> bool {
        self.first_tab_id == tab_id || self.second_tab_id == tab_id
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SplitOrientation {
    Horizontal,
    Vertical,
}

#[derive(Clone, Default)]
pub struct BrowserState {
    pub data: Arc<Mutex<Vec<TabState>>>,
    pub page_context_menu_enabled: Arc<std::sync::atomic::AtomicBool>,
    pub next_id: Arc<std::sync::atomic::AtomicU64>,
    pub settings_open: Arc<Mutex<std::collections::HashSet<String>>>,
    pub window_bounds: Arc<Mutex<std::collections::HashMap<String, ViewBounds>>>,
    pub split_tabs: Arc<Mutex<std::collections::HashMap<String, SplitLayout>>>,
    pub tab_dragging: Arc<Mutex<Option<String>>>,
    pub tab_drag_source: Arc<Mutex<Option<String>>>,
    pub tab_drag_target: Arc<Mutex<Option<String>>>,
    pub recently_closed: Arc<Mutex<Vec<SessionTab>>>,
    pub session_file: Arc<Mutex<Option<PathBuf>>>,
    pub database: Arc<Mutex<Option<super::database::BrowserDatabase>>>,
    pub history: Arc<Mutex<Vec<HistoryEntry>>>,
    pub filtering: Arc<Mutex<Option<super::filtering::FilterSettings>>>,
    pub filtering_file: Arc<Mutex<Option<PathBuf>>>,
    pub downloads: Arc<Mutex<Vec<DownloadEntry>>>,
    pub next_download_id: Arc<std::sync::atomic::AtomicU64>,
    pub launch_request: Arc<Mutex<Option<super::launch::LaunchRequest>>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TabFolderMenuEntry {
    pub id: String,
    pub title: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DownloadEntry {
    pub id: String,
    pub url: String,
    pub filename: String,
    pub path: PathBuf,
    pub status: DownloadStatus,
    pub bytes_received: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum DownloadStatus {
    Downloading,
    Completed,
    Failed,
}

pub fn cycle_active_tab(tabs: &mut [TabState], direction: isize) -> Option<String> {
    if tabs.is_empty() {
        return None;
    }
    let current = tabs.iter().position(|tab| tab.active).unwrap_or(0) as isize;
    let count = tabs.len() as isize;
    let next = (current + direction).rem_euclid(count) as usize;
    for (index, tab) in tabs.iter_mut().enumerate() {
        tab.active = index == next;
    }
    Some(tabs[next].id.clone())
}

pub fn find_script(query: &str, backwards: bool) -> String {
    let query = serde_json::to_string(query).expect("string serialization cannot fail");
    format!(
        r#"(() => {{
            const query = {query};
            if (!query) return 0;
            const needle = query.toLocaleLowerCase();
            const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
            let count = 0;
            let node;
            while ((node = walker.nextNode())) {{
                const parent = node.parentElement;
                if (!parent || parent.closest('script,style,noscript,template,[hidden],[aria-hidden="true"]')) continue;
                const text = (node.nodeValue || '').toLocaleLowerCase();
                let offset = 0;
                let index;
                while ((index = text.indexOf(needle, offset)) !== -1) {{
                    count += 1;
                    offset = index + needle.length;
                }}
            }}
            window.find({query}, false, {backwards}, true, false, false, false);
            return count;
        }})()"#
    )
}

pub fn download_filename(input: &str) -> String {
    let candidate = Url::parse(input)
        .ok()
        .and_then(|url| {
            url.path_segments()
                .and_then(|mut segments| segments.next_back())
                .map(str::to_string)
        })
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "download".into());
    let safe: String = candidate
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '_') {
                character
            } else {
                '_'
            }
        })
        .collect();
    let safe = safe.trim_matches('.');
    if safe.is_empty() {
        "download".into()
    } else {
        safe.into()
    }
}

pub fn next_download_path(directory: &Path, filename: &str, in_use: &[PathBuf]) -> PathBuf {
    let initial = directory.join(filename);
    if !initial.exists() && !in_use.iter().any(|path| path == &initial) {
        return initial;
    }
    let path = Path::new(filename);
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("download");
    let extension = path.extension().and_then(|value| value.to_str());
    for suffix in 1.. {
        let name = match extension {
            Some(extension) => format!("{stem} ({suffix}).{extension}"),
            None => format!("{stem} ({suffix})"),
        };
        let candidate = directory.join(name);
        if !candidate.exists() && !in_use.iter().any(|path| path == &candidate) {
            return candidate;
        }
    }
    unreachable!("an available download path should always exist")
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionTab {
    pub id: String,
    pub url: String,
    pub title: String,
    #[serde(default = "default_zoom")]
    pub zoom: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistedSession {
    pub version: u32,
    pub tabs: Vec<SessionTab>,
    pub active_tab_id: String,
    #[serde(default)]
    pub recently_closed: Vec<SessionTab>,
}

impl Default for PersistedSession {
    fn default() -> Self {
        Self {
            version: 1,
            tabs: Vec::new(),
            active_tab_id: String::new(),
            recently_closed: Vec::new(),
        }
    }
}

impl From<&TabState> for SessionTab {
    fn from(tab: &TabState) -> Self {
        Self {
            id: tab.id.clone(),
            url: tab.url.clone(),
            title: tab.title.clone(),
            zoom: tab.zoom,
        }
    }
}

pub fn remember_closed_tab(recently_closed: &mut Vec<SessionTab>, tab: SessionTab) {
    recently_closed.insert(0, tab);
    recently_closed.truncate(20);
}

pub fn take_recently_closed(recently_closed: &mut Vec<SessionTab>) -> Option<SessionTab> {
    if recently_closed.is_empty() {
        None
    } else {
        Some(recently_closed.remove(0))
    }
}

#[derive(Debug, Clone, Copy)]
pub struct ViewBounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl Default for ViewBounds {
    fn default() -> Self {
        Self {
            x: 220.0,
            y: 64.0,
            width: 980.0,
            height: 736.0,
        }
    }
}

impl TabState {
    pub fn new(id: String, url: String, active: bool) -> Self {
        Self {
            id,
            window_label: default_window_label(),
            url: url.clone(),
            title: "New Tab".into(),
            loading: false,
            can_go_back: false,
            can_go_forward: false,
            active,
            private: false,
            zoom: 1.0,
            history: if url.is_empty() {
                Vec::new()
            } else {
                vec![url]
            },
            history_index: 0,
        }
    }

    pub fn new_private(id: String, active: bool) -> Self {
        let mut tab = Self::new(id, String::new(), active);
        tab.private = true;
        tab
    }

    pub fn new_in_window(
        id: String,
        url: String,
        active: bool,
        private: bool,
        window_label: String,
    ) -> Self {
        let mut tab = if private {
            Self::new_private(id, active)
        } else {
            Self::new(id, url, active)
        };
        tab.window_label = window_label;
        tab
    }

    pub fn record_navigation(&mut self, url: String) {
        if self.history.get(self.history_index) == Some(&url) {
            self.url = url;
            return;
        }
        if self.history_index > 0 && self.history[self.history_index - 1] == url {
            self.history_index -= 1;
            self.url = url;
            self.can_go_back = self.history_index > 0;
            self.can_go_forward = true;
            return;
        }
        if self.history_index + 1 < self.history.len()
            && self.history[self.history_index + 1] == url
        {
            self.history_index += 1;
            self.url = url;
            self.can_go_back = self.history_index > 0;
            self.can_go_forward = self.history_index + 1 < self.history.len();
            return;
        }
        self.history.truncate(self.history_index.saturating_add(1));
        self.history.push(url.clone());
        // Pages can push same-origin entries without limit; keep the newest ones.
        if self.history.len() > MAX_TAB_HISTORY {
            let excess = self.history.len() - MAX_TAB_HISTORY;
            self.history.drain(..excess);
        }
        self.history_index = self.history.len().saturating_sub(1);
        self.url = url;
        self.can_go_back = self.history_index > 0;
        self.can_go_forward = false;
    }

    pub fn replace_navigation(&mut self, url: String) {
        if self.history.is_empty() {
            self.history.push(url.clone());
            self.history_index = 0;
        } else {
            self.history[self.history_index] = url.clone();
        }
        self.url = url;
        self.can_go_back = self.history_index > 0;
        self.can_go_forward = self.history_index + 1 < self.history.len();
    }

    pub fn move_history(&mut self, forward: bool) -> Option<String> {
        if forward && self.history_index + 1 < self.history.len() {
            self.history_index += 1;
        } else if !forward && self.history_index > 0 {
            self.history_index -= 1;
        } else {
            return None;
        }
        self.url = self.history[self.history_index].clone();
        self.can_go_back = self.history_index > 0;
        self.can_go_forward = self.history_index + 1 < self.history.len();
        Some(self.url.clone())
    }
}

pub fn snapshot(tabs: &[TabState]) -> BrowserSnapshot {
    BrowserSnapshot {
        tabs: tabs.to_vec(),
        active_tab_id: tabs
            .iter()
            .find(|tab| tab.active)
            .map(|tab| tab.id.clone())
            .unwrap_or_default(),
    }
}

#[cfg(test)]
mod tests {
    use super::{
        cycle_active_tab, download_filename, find_script, is_tab_visible, next_download_path,
        remember_closed_tab, take_recently_closed, SessionTab, SplitLayout, SplitOrientation,
        TabState, MAX_TAB_HISTORY,
    };
    use std::{fs, time::SystemTime};

    fn tab(id: usize) -> SessionTab {
        SessionTab {
            id: format!("tab-{id}"),
            url: format!("https://example.com/{id}"),
            title: format!("Page {id}"),
            zoom: 1.0,
        }
    }

    #[test]
    fn recently_closed_tabs_reopen_newest_first_and_are_bounded() {
        let mut recently_closed = Vec::new();
        remember_closed_tab(&mut recently_closed, tab(1));
        remember_closed_tab(&mut recently_closed, tab(2));

        assert_eq!(
            take_recently_closed(&mut recently_closed).unwrap().id,
            "tab-2"
        );
        assert_eq!(
            take_recently_closed(&mut recently_closed).unwrap().id,
            "tab-1"
        );
        assert!(take_recently_closed(&mut recently_closed).is_none());

        for id in 0..25 {
            remember_closed_tab(&mut recently_closed, tab(id));
        }
        assert_eq!(recently_closed.len(), 20);
        assert_eq!(
            take_recently_closed(&mut recently_closed).unwrap().id,
            "tab-24"
        );
    }

    #[test]
    fn download_names_are_sanitized_and_paths_do_not_overwrite() {
        assert_eq!(
            download_filename("https://example.com/files/report.pdf?token=abc"),
            "report.pdf"
        );
        assert_eq!(download_filename("https://example.com/"), "download");
        assert_eq!(
            download_filename("https://example.com/files/%2e%2e%2fsecret"),
            "_2e_2e_2fsecret"
        );

        let unique = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = std::env::temp_dir().join(format!("browser-download-path-test-{unique}"));
        fs::create_dir_all(&directory).unwrap();
        let initial = directory.join("report.pdf");
        fs::write(&initial, "existing").unwrap();
        let in_use = vec![directory.join("report (1).pdf")];

        let selected = next_download_path(&directory, "report.pdf", &in_use);

        assert_eq!(selected, directory.join("report (2).pdf"));
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn tab_cycling_wraps_in_both_directions() {
        let mut tabs = vec![
            TabState::new("tab-1".into(), "https://one.test".into(), false),
            TabState::new("tab-2".into(), "https://two.test".into(), true),
            TabState::new("tab-3".into(), "https://three.test".into(), false),
        ];

        assert_eq!(cycle_active_tab(&mut tabs, 1).as_deref(), Some("tab-3"));
        assert_eq!(cycle_active_tab(&mut tabs, 1).as_deref(), Some("tab-1"));
        assert_eq!(cycle_active_tab(&mut tabs, -1).as_deref(), Some("tab-3"));
        assert_eq!(cycle_active_tab(&mut [], 1), None);
    }

    #[test]
    fn find_script_escapes_queries_and_sets_direction() {
        let script = find_script("two \"words\"", true);
        assert!(script.contains("two \\\"words\\\""));
        assert!(script.contains(", true, true, false"));
    }

    #[test]
    fn page_pushed_history_is_capped_to_the_newest_entries() {
        let mut tab = TabState::new("tab-1".into(), "https://site.test/0".into(), true);
        tab.record_navigation("https://site.test/0".into());
        for index in 1..=MAX_TAB_HISTORY + 50 {
            tab.record_navigation(format!("https://site.test/{index}"));
        }
        assert_eq!(tab.history.len(), MAX_TAB_HISTORY);
        assert_eq!(tab.history_index, MAX_TAB_HISTORY - 1);
        assert_eq!(
            tab.history.last().map(String::as_str),
            Some(format!("https://site.test/{}", MAX_TAB_HISTORY + 50).as_str())
        );
        assert!(tab.can_go_back);
        assert!(!tab.can_go_forward);
    }

    fn visibility_tabs() -> Vec<TabState> {
        vec![
            TabState::new_in_window(
                "tab-1".into(),
                "https://one.test".into(),
                true,
                false,
                "main".into(),
            ),
            TabState::new_in_window(
                "tab-2".into(),
                "https://two.test".into(),
                false,
                false,
                "main".into(),
            ),
            TabState::new_in_window(
                "tab-3".into(),
                "https://three.test".into(),
                false,
                false,
                "main".into(),
            ),
            TabState::new_in_window(
                "tab-4".into(),
                "https://four.test".into(),
                true,
                false,
                "browser-window-9".into(),
            ),
        ]
    }

    fn split(first: &str, second: &str) -> SplitLayout {
        SplitLayout {
            first_tab_id: first.into(),
            second_tab_id: second.into(),
            orientation: SplitOrientation::Horizontal,
            first_pane_percent: 50,
        }
    }

    #[test]
    fn only_on_screen_tabs_are_visible() {
        let tabs = visibility_tabs();
        assert!(is_tab_visible(&tabs, None, false, "tab-1"));
        assert!(is_tab_visible(&tabs, None, false, "tab-4"));
        assert!(
            !is_tab_visible(&tabs, None, false, "tab-2"),
            "background tab"
        );
        assert!(
            !is_tab_visible(&tabs, None, true, "tab-1"),
            "Settings covers pages"
        );
        assert!(!is_tab_visible(&tabs, None, false, "missing"));
    }

    #[test]
    fn split_partner_of_the_active_tab_is_visible() {
        let tabs = visibility_tabs();
        let layout = split("tab-1", "tab-2");
        assert!(is_tab_visible(&tabs, Some(&layout), false, "tab-2"));
        assert!(!is_tab_visible(&tabs, Some(&layout), false, "tab-3"));
        // A split that does not hold the active tab is not on screen.
        let hidden = split("tab-2", "tab-3");
        assert!(!is_tab_visible(&tabs, Some(&hidden), false, "tab-2"));
        assert!(!is_tab_visible(&tabs, Some(&hidden), false, "tab-3"));
    }
}
