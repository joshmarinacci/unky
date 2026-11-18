//! Session persistence and legacy history import.

use crate::*;

pub(crate) fn persist_session(state: &BrowserState) -> Result<(), String> {
    let path = state
        .session_file
        .lock()
        .map_err(|_| "Session path is unavailable")?
        .clone();
    let Some(path) = path else {
        return Ok(());
    };
    let tabs = state
        .data
        .lock()
        .map_err(|_| "Browser state is unavailable")?;
    let recently_closed = state
        .recently_closed
        .lock()
        .map_err(|_| "Browser state is unavailable")?;
    let session = PersistedSession {
        version: 1,
        tabs: tabs
            .iter()
            .filter(|tab| !tab.private)
            .map(SessionTab::from)
            .collect(),
        active_tab_id: tabs
            .iter()
            .find(|tab| tab.active && !tab.private)
            .or_else(|| tabs.iter().find(|tab| !tab.private))
            .map(|tab| tab.id.clone())
            .unwrap_or_default(),
        recently_closed: recently_closed.clone(),
    };
    let json = serde_json::to_vec_pretty(&session).map_err(|error| error.to_string())?;
    let parent = path
        .parent()
        .ok_or("Session path has no parent directory")?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let temporary = path.with_extension("json.tmp");
    fs::write(&temporary, json).map_err(|error| error.to_string())?;
    fs::rename(temporary, path).map_err(|error| error.to_string())
}

pub(crate) fn read_session(path: &PathBuf) -> PersistedSession {
    fs::read(path)
        .ok()
        .and_then(|contents| serde_json::from_slice::<PersistedSession>(&contents).ok())
        .filter(|session| session.version == 1)
        .unwrap_or_default()
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LegacyHistory {
    version: u32,
    entries: Vec<LegacyHistoryEntry>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LegacyHistoryEntry {
    url: String,
    title: String,
    visited_at: u64,
}

pub(crate) fn read_legacy_history(path: &PathBuf) -> Vec<HistoryEntry> {
    fs::read(path)
        .ok()
        .and_then(|contents| serde_json::from_slice::<LegacyHistory>(&contents).ok())
        .filter(|history| history.version == 1)
        .map(|history| {
            history
                .entries
                .into_iter()
                .map(|entry| HistoryEntry {
                    id: String::new(),
                    url: entry.url,
                    title: entry.title,
                    visited_at: entry.visited_at,
                    favicon: None,
                })
                .collect()
        })
        .unwrap_or_default()
}

pub(crate) fn validated_session_tab(tab: SessionTab) -> Option<SessionTab> {
    let url = if tab.url.is_empty() {
        String::new()
    } else {
        allowed_navigation_url(&tab.url).ok()?.to_string()
    };
    Some(SessionTab {
        id: if tab.id.starts_with("tab-")
            && tab.id.len() <= 32
            && tab.id[4..].bytes().all(|byte| byte.is_ascii_digit())
        {
            tab.id
        } else {
            return None;
        },
        url,
        title: if tab.title.trim().is_empty() {
            "New Tab".into()
        } else {
            tab.title.chars().take(512).collect()
        },
        zoom: if tab.zoom.is_finite() {
            tab.zoom.clamp(0.5, 3.0)
        } else {
            1.0
        },
    })
}
