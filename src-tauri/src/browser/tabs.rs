use serde::{Deserialize, Serialize};
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
