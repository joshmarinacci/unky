use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TabState {
    pub id: String,
    pub url: String,
    pub title: String,
    pub loading: bool,
    pub can_go_back: bool,
    pub can_go_forward: bool,
    pub active: bool,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserSnapshot {
    pub tabs: Vec<TabState>,
    pub active_tab_id: String,
}

#[derive(Default)]
pub struct BrowserState {
    pub data: Arc<Mutex<Vec<TabState>>>,
    pub next_id: Arc<std::sync::atomic::AtomicU64>,
    pub bounds: Arc<Mutex<ViewBounds>>,
    pub settings_open: Arc<Mutex<bool>>,
    pub recently_closed: Arc<Mutex<Vec<SessionTab>>>,
    pub session_file: Arc<Mutex<Option<PathBuf>>>,
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
            url: url.clone(),
            title: "New Tab".into(),
            loading: false,
            can_go_back: false,
            can_go_forward: false,
            active,
            zoom: 1.0,
            history: if url.is_empty() {
                Vec::new()
            } else {
                vec![url]
            },
            history_index: 0,
        }
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
        self.history_index = self.history.len().saturating_sub(1);
        self.url = url;
        self.can_go_back = self.history_index > 0;
        self.can_go_forward = false;
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
    use super::{remember_closed_tab, take_recently_closed, SessionTab};

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
}
