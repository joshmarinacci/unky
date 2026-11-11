use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum BookmarkNode {
    Bookmark {
        id: String,
        title: String,
        url: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        description: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        favicon: Option<String>,
    },
    Folder {
        id: String,
        title: String,
        #[serde(default)]
        children: Vec<BookmarkNode>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub id: String,
    pub url: String,
    pub title: String,
    pub visited_at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub favicon: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CachedFavicon {
    pub icon_url: String,
    pub data_url: Option<String>,
    pub mime_type: Option<String>,
}

pub struct BrowserDatabase {
    connection: Connection,
}

impl BrowserDatabase {
    pub fn open(path: &Path) -> Result<Self, String> {
        if let Some(parent) = path
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
        {
            std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let connection = Connection::open(path).map_err(|error| error.to_string())?;
        connection
            .execute_batch(
                "PRAGMA foreign_keys = ON;
                 PRAGMA journal_mode = WAL;
                 CREATE TABLE IF NOT EXISTS bookmarks (
                   id TEXT PRIMARY KEY,
                   parent_id TEXT REFERENCES bookmarks(id) ON DELETE CASCADE,
                   position INTEGER NOT NULL,
                   kind TEXT NOT NULL CHECK (kind IN ('bookmark', 'folder')),
                   title TEXT NOT NULL,
                   url TEXT,
                   description TEXT
                 );
                 CREATE INDEX IF NOT EXISTS bookmarks_parent_order ON bookmarks(parent_id, position);
                 CREATE INDEX IF NOT EXISTS bookmarks_url ON bookmarks(url);
                 CREATE TABLE IF NOT EXISTS history_visits (
                   id INTEGER PRIMARY KEY AUTOINCREMENT,
                   url TEXT NOT NULL,
                   title TEXT NOT NULL,
                   visited_at INTEGER NOT NULL
                 );
                 CREATE INDEX IF NOT EXISTS history_url_latest ON history_visits(url, id DESC);
                 CREATE INDEX IF NOT EXISTS history_visited_at ON history_visits(visited_at DESC, id DESC);
                 CREATE TABLE IF NOT EXISTS favicons (
                   page_url TEXT PRIMARY KEY,
                   icon_url TEXT NOT NULL,
                   mime_type TEXT,
                   data_url TEXT,
                   updated_at INTEGER NOT NULL
                 );
                 CREATE TABLE IF NOT EXISTS metadata (
                   key TEXT PRIMARY KEY,
                   value TEXT NOT NULL
                 );",
            )
            .map_err(|error| error.to_string())?;
        Ok(Self { connection })
    }

    pub fn load_bookmarks(&self) -> Result<Vec<BookmarkNode>, String> {
        let mut statement = self
            .connection
            .prepare(
                "SELECT b.id, b.parent_id, b.kind, b.title, b.url, b.description, f.data_url
                 FROM bookmarks b LEFT JOIN favicons f ON f.page_url = b.url
                 ORDER BY b.parent_id IS NOT NULL, b.parent_id, b.position, b.rowid",
            )
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], |row| {
                Ok(BookmarkRow {
                    id: row.get(0)?,
                    parent_id: row.get(1)?,
                    kind: row.get(2)?,
                    title: row.get(3)?,
                    url: row.get(4)?,
                    description: row.get(5)?,
                    favicon: row.get(6)?,
                })
            })
            .map_err(|error| error.to_string())?;
        let mut children: HashMap<Option<String>, Vec<BookmarkRow>> = HashMap::new();
        for row in rows {
            let row = row.map_err(|error| error.to_string())?;
            children.entry(row.parent_id.clone()).or_default().push(row);
        }
        Ok(build_bookmark_tree(None, &mut children))
    }

    pub fn save_bookmarks(&mut self, nodes: &[BookmarkNode]) -> Result<(), String> {
        let transaction = self
            .connection
            .transaction()
            .map_err(|error| error.to_string())?;
        transaction
            .execute("DELETE FROM bookmarks", [])
            .map_err(|error| error.to_string())?;
        insert_bookmark_nodes(&transaction, nodes, None)?;
        transaction.commit().map_err(|error| error.to_string())
    }

    pub fn migrate_bookmarks_once(
        &mut self,
        legacy: &[BookmarkNode],
    ) -> Result<Vec<BookmarkNode>, String> {
        let migrated = self
            .connection
            .query_row(
                "SELECT value FROM metadata WHERE key = 'localstorage_bookmarks_migrated'",
                [],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|error| error.to_string())?
            .is_some();
        if !migrated {
            let count: i64 = self
                .connection
                .query_row("SELECT COUNT(*) FROM bookmarks", [], |row| row.get(0))
                .map_err(|error| error.to_string())?;
            let transaction = self
                .connection
                .transaction()
                .map_err(|error| error.to_string())?;
            if count == 0 && !legacy.is_empty() {
                insert_bookmark_nodes(&transaction, legacy, None)?;
            }
            transaction
                .execute(
                    "INSERT OR REPLACE INTO metadata(key, value) VALUES ('localstorage_bookmarks_migrated', '1')",
                    [],
                )
                .map_err(|error| error.to_string())?;
            transaction.commit().map_err(|error| error.to_string())?;
        }
        self.load_bookmarks()
    }

    pub fn record_visit(
        &self,
        url: &str,
        title: &str,
        visited_at: u64,
    ) -> Result<HistoryEntry, String> {
        self.connection
            .execute(
                "INSERT INTO history_visits(url, title, visited_at) VALUES (?1, ?2, ?3)",
                params![url, title, visited_at as i64],
            )
            .map_err(|error| error.to_string())?;
        let id = self.connection.last_insert_rowid();
        self.history_entry(id)
    }

    pub fn update_latest_visit_title(&self, url: &str, title: &str) -> Result<(), String> {
        self.connection
            .execute(
                "UPDATE history_visits SET title = ?1 WHERE id = (SELECT id FROM history_visits WHERE url = ?2 ORDER BY id DESC LIMIT 1)",
                params![title, url],
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    pub fn history(&self, query: Option<&str>, limit: usize) -> Result<Vec<HistoryEntry>, String> {
        let pattern = query.map(|value| {
            format!(
                "%{}%",
                value
                    .trim()
                    .replace('\\', "\\\\")
                    .replace('%', "\\%")
                    .replace('_', "\\_")
            )
        });
        let mut statement = self
            .connection
            .prepare(
                "SELECT h.id, h.url, h.title, h.visited_at, f.data_url
                 FROM history_visits h LEFT JOIN favicons f ON f.page_url = h.url
                 WHERE (?1 IS NULL OR h.title LIKE ?1 ESCAPE '\\' COLLATE NOCASE OR h.url LIKE ?1 ESCAPE '\\' COLLATE NOCASE)
                 ORDER BY h.id DESC LIMIT ?2",
            )
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map(params![pattern, limit as i64], |row| {
                Ok(HistoryEntry {
                    id: row.get::<_, i64>(0)?.to_string(),
                    url: row.get(1)?,
                    title: row.get(2)?,
                    visited_at: row.get::<_, i64>(3)?.max(0) as u64,
                    favicon: row.get(4)?,
                })
            })
            .map_err(|error| error.to_string())?;
        rows.map(|row| row.map_err(|error| error.to_string()))
            .collect()
    }

    pub fn recent_distinct_history(&self, limit: usize) -> Result<Vec<HistoryEntry>, String> {
        let mut statement = self
            .connection
            .prepare(
                "SELECT h.id, h.url, h.title, h.visited_at, f.data_url
                 FROM history_visits h
                 LEFT JOIN favicons f ON f.page_url = h.url
                 WHERE h.id = (SELECT MAX(recent.id) FROM history_visits recent WHERE recent.url = h.url)
                 ORDER BY h.id DESC LIMIT ?1",
            )
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([limit as i64], |row| {
                Ok(HistoryEntry {
                    id: row.get::<_, i64>(0)?.to_string(),
                    url: row.get(1)?,
                    title: row.get(2)?,
                    visited_at: row.get::<_, i64>(3)?.max(0) as u64,
                    favicon: row.get(4)?,
                })
            })
            .map_err(|error| error.to_string())?;
        rows.map(|row| row.map_err(|error| error.to_string()))
            .collect()
    }

    pub fn history_entry(&self, id: i64) -> Result<HistoryEntry, String> {
        self.connection
            .query_row(
                "SELECT h.id, h.url, h.title, h.visited_at, f.data_url
                 FROM history_visits h LEFT JOIN favicons f ON f.page_url = h.url WHERE h.id = ?1",
                [id],
                |row| {
                    Ok(HistoryEntry {
                        id: row.get::<_, i64>(0)?.to_string(),
                        url: row.get(1)?,
                        title: row.get(2)?,
                        visited_at: row.get::<_, i64>(3)?.max(0) as u64,
                        favicon: row.get(4)?,
                    })
                },
            )
            .map_err(|error| error.to_string())
    }

    pub fn import_history_once(&mut self, entries: &[HistoryEntry]) -> Result<(), String> {
        let migrated = self
            .connection
            .query_row(
                "SELECT value FROM metadata WHERE key = 'legacy_json_history_migrated'",
                [],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|error| error.to_string())?
            .is_some();
        if migrated {
            return Ok(());
        }
        let transaction = self
            .connection
            .transaction()
            .map_err(|error| error.to_string())?;
        let has_visits: bool = transaction
            .query_row("SELECT EXISTS(SELECT 1 FROM history_visits)", [], |row| {
                row.get(0)
            })
            .map_err(|error| error.to_string())?;
        if !has_visits {
            for entry in entries.iter().rev() {
                transaction
                    .execute(
                        "INSERT INTO history_visits(url, title, visited_at) VALUES (?1, ?2, ?3)",
                        params![entry.url, entry.title, entry.visited_at as i64],
                    )
                    .map_err(|error| error.to_string())?;
            }
        }
        transaction
            .execute(
                "INSERT OR REPLACE INTO metadata(key, value) VALUES ('legacy_json_history_migrated', '1')",
                [],
            )
            .map_err(|error| error.to_string())?;
        transaction.commit().map_err(|error| error.to_string())
    }

    pub fn clear_history(&self) -> Result<(), String> {
        self.connection
            .execute("DELETE FROM history_visits", [])
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    pub fn save_favicon(
        &self,
        page_url: &str,
        icon_url: &str,
        mime_type: Option<&str>,
        data_url: Option<&str>,
    ) -> Result<(), String> {
        let updated_at = now_epoch();
        self.connection
            .execute(
                "INSERT INTO favicons(page_url, icon_url, mime_type, data_url, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT(page_url) DO UPDATE SET icon_url=excluded.icon_url, mime_type=CASE WHEN excluded.icon_url <> favicons.icon_url THEN excluded.mime_type ELSE COALESCE(excluded.mime_type, favicons.mime_type) END, data_url=CASE WHEN excluded.icon_url <> favicons.icon_url THEN excluded.data_url ELSE COALESCE(excluded.data_url, favicons.data_url) END, updated_at=excluded.updated_at",
                params![page_url, icon_url, mime_type, data_url, updated_at],
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    pub fn favicon(&self, page_url: &str) -> Result<Option<CachedFavicon>, String> {
        self.connection
            .query_row(
                "SELECT icon_url, data_url, mime_type FROM favicons WHERE page_url = ?1",
                [page_url],
                |row| {
                    Ok(CachedFavicon {
                        icon_url: row.get(0)?,
                        data_url: row.get(1)?,
                        mime_type: row.get(2)?,
                    })
                },
            )
            .optional()
            .map_err(|error| error.to_string())
    }

    pub fn bookmark_url(&self, id: &str) -> Result<Option<String>, String> {
        self.connection
            .query_row(
                "SELECT url FROM bookmarks WHERE id = ?1 AND kind = 'bookmark'",
                [id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| error.to_string())
    }

    pub fn export_bookmarks_html(&self) -> Result<String, String> {
        let tree = self.load_bookmarks()?;
        let mut statement = self
            .connection
            .prepare("SELECT page_url, icon_url, data_url, mime_type FROM favicons")
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    CachedFavicon {
                        icon_url: row.get(1)?,
                        data_url: row.get(2)?,
                        mime_type: row.get(3)?,
                    },
                ))
            })
            .map_err(|error| error.to_string())?;
        let mut icons = HashMap::new();
        for row in rows {
            let (url, favicon) = row.map_err(|error| error.to_string())?;
            icons.insert(url, favicon);
        }
        let mut output = String::from(
            "<!DOCTYPE NETSCAPE-Bookmark-file-1>\n<META HTTP-EQUIV=\"Content-Type\" CONTENT=\"text/html; charset=UTF-8\">\n<TITLE>Bookmarks</TITLE>\n<H1>Bookmarks</H1>\n<DL><p>\n",
        );
        write_bookmark_html(&tree, 1, &icons, &mut output);
        output.push_str("</DL><p>\n");
        Ok(output)
    }

    pub fn import_bookmarks_html(&mut self, html: &str) -> Result<Vec<BookmarkNode>, String> {
        let imported = parse_bookmarks_html(html);
        if imported.is_empty() {
            return Err("No bookmarks were found in that file.".into());
        }
        let mut current = self.load_bookmarks()?;
        let mut folder = BookmarkNode::Folder {
            id: new_bookmark_id(),
            title: "Imported Bookmarks".into(),
            children: imported,
        };
        if let BookmarkNode::Folder { children, .. } = &mut folder {
            for child in children.iter_mut() {
                attach_imported_icons(child, &self.connection)?;
            }
        }
        current.push(folder);
        self.save_bookmarks(&current)?;
        self.load_bookmarks()
    }
}

#[derive(Debug)]
struct BookmarkRow {
    id: String,
    parent_id: Option<String>,
    kind: String,
    title: String,
    url: Option<String>,
    description: Option<String>,
    favicon: Option<String>,
}

fn build_bookmark_tree(
    parent: Option<String>,
    children: &mut HashMap<Option<String>, Vec<BookmarkRow>>,
) -> Vec<BookmarkNode> {
    children
        .remove(&parent)
        .unwrap_or_default()
        .into_iter()
        .map(|row| match row.kind.as_str() {
            "folder" => BookmarkNode::Folder {
                id: row.id.clone(),
                title: row.title,
                children: build_bookmark_tree(Some(row.id), children),
            },
            _ => BookmarkNode::Bookmark {
                id: row.id,
                title: row.title,
                url: row.url.unwrap_or_default(),
                description: row.description,
                favicon: row.favicon,
            },
        })
        .collect()
}

fn insert_bookmark_nodes(
    transaction: &Transaction<'_>,
    nodes: &[BookmarkNode],
    parent_id: Option<&str>,
) -> Result<(), String> {
    for (position, node) in nodes.iter().enumerate() {
        match node {
            BookmarkNode::Bookmark {
                id,
                title,
                url,
                description,
                favicon,
            } => {
                transaction
                    .execute(
                        "INSERT INTO bookmarks(id, parent_id, position, kind, title, url, description) VALUES (?1, ?2, ?3, 'bookmark', ?4, ?5, ?6)",
                        params![id, parent_id, position as i64, title, url, description],
                    )
                    .map_err(|error| error.to_string())?;
                if let Some(favicon) = favicon.as_deref() {
                    let data_url = favicon.starts_with("data:image/").then_some(favicon);
                    let mime_type = data_url
                        .and_then(|value| value.strip_prefix("data:"))
                        .and_then(|value| value.split([';', ',']).next());
                    transaction
                        .execute(
                            "INSERT INTO favicons(page_url, icon_url, mime_type, data_url, updated_at)
                             VALUES (?1, ?2, ?3, ?4, ?5)
                             ON CONFLICT(page_url) DO UPDATE SET icon_url=CASE WHEN excluded.data_url IS NOT NULL THEN favicons.icon_url ELSE excluded.icon_url END, mime_type=CASE WHEN excluded.icon_url <> favicons.icon_url THEN excluded.mime_type ELSE COALESCE(excluded.mime_type, favicons.mime_type) END, data_url=CASE WHEN excluded.icon_url <> favicons.icon_url THEN excluded.data_url ELSE COALESCE(excluded.data_url, favicons.data_url) END, updated_at=excluded.updated_at",
                            params![url, favicon, mime_type, data_url, now_epoch()],
                        )
                        .map_err(|error| error.to_string())?;
                }
            }
            BookmarkNode::Folder {
                id,
                title,
                children,
            } => {
                transaction
                    .execute(
                        "INSERT INTO bookmarks(id, parent_id, position, kind, title) VALUES (?1, ?2, ?3, 'folder', ?4)",
                        params![id, parent_id, position as i64, title],
                    )
                    .map_err(|error| error.to_string())?;
                insert_bookmark_nodes(transaction, children, Some(id))?;
            }
        }
    }
    Ok(())
}

fn now_epoch() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or_default()
}

fn new_bookmark_id() -> String {
    static NEXT_ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    format!(
        "bookmark-{now}-{}",
        NEXT_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    )
}

fn attach_imported_icons(node: &mut BookmarkNode, connection: &Connection) -> Result<(), String> {
    match node {
        BookmarkNode::Bookmark { url, favicon, .. } => {
            if let Some(data_url) = favicon.as_deref() {
                if data_url.starts_with("data:image/") {
                    let mime = data_url
                        .strip_prefix("data:")
                        .and_then(|value| value.split([';', ',']).next())
                        .unwrap_or("image/png");
                    connection
                        .execute(
                            "INSERT OR REPLACE INTO favicons(page_url, icon_url, mime_type, data_url, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)",
                            params![url.as_str(), data_url, mime, data_url, 0],
                        )
                        .map_err(|error| error.to_string())?;
                } else {
                    connection
                        .execute(
                            "INSERT OR REPLACE INTO favicons(page_url, icon_url, mime_type, data_url, updated_at) VALUES (?1, ?2, NULL, NULL, 0)",
                            params![url.as_str(), data_url],
                        )
                        .map_err(|error| error.to_string())?;
                }
            }
        }
        BookmarkNode::Folder { children, .. } => {
            for child in children {
                attach_imported_icons(child, connection)?;
            }
        }
    }
    Ok(())
}

fn write_bookmark_html(
    nodes: &[BookmarkNode],
    depth: usize,
    icons: &HashMap<String, CachedFavicon>,
    output: &mut String,
) {
    let indent = "    ".repeat(depth);
    for node in nodes {
        match node {
            BookmarkNode::Bookmark {
                title,
                url,
                description,
                favicon,
                ..
            } => {
                let icon_value = favicon.as_deref().or_else(|| {
                    icons
                        .get(url)
                        .map(|icon| icon.data_url.as_deref().unwrap_or(icon.icon_url.as_str()))
                });
                let icon = icon_value
                    .map(|value| format!(" ICON=\"{}\"", escape_html_attribute(value)))
                    .unwrap_or_default();
                output.push_str(&format!(
                    "{indent}<DT><A HREF=\"{}\"{icon}{}>{}</A>\n",
                    escape_html_attribute(url),
                    description
                        .as_ref()
                        .map(|value| format!(" DESCRIPTION=\"{}\"", escape_html_attribute(value)))
                        .unwrap_or_default(),
                    escape_html_text(title)
                ));
            }
            BookmarkNode::Folder {
                title, children, ..
            } => {
                output.push_str(&format!(
                    "{indent}<DT><H3>{}</H3>\n{indent}<DL><p>\n",
                    escape_html_text(title)
                ));
                write_bookmark_html(children, depth + 1, icons, output);
                output.push_str(&format!("{indent}</DL><p>\n"));
            }
        }
    }
}

fn escape_html_text(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn escape_html_attribute(value: &str) -> String {
    escape_html_text(value).replace('"', "&quot;")
}

fn decode_html_entities(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    let mut remainder = value;
    while let Some(start) = remainder.find('&') {
        output.push_str(&remainder[..start]);
        let tail = &remainder[start + 1..];
        let Some(end) = tail.find(';') else {
            output.push('&');
            remainder = tail;
            continue;
        };
        let entity = &tail[..end];
        let decoded = match entity {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" | "#39" => Some('\''),
            value if value.starts_with("#x") || value.starts_with("#X") => {
                u32::from_str_radix(&value[2..], 16)
                    .ok()
                    .and_then(char::from_u32)
            }
            value if value.starts_with('#') => {
                value[1..].parse::<u32>().ok().and_then(char::from_u32)
            }
            _ => None,
        };
        if let Some(decoded) = decoded {
            output.push(decoded);
        } else {
            output.push('&');
            output.push_str(entity);
            output.push(';');
        }
        remainder = &tail[end + 1..];
    }
    output.push_str(remainder);
    output
}

fn tag_attribute(tag: &str, name: &str) -> Option<String> {
    let bytes = tag.as_bytes();
    let mut cursor = 0;
    while cursor < bytes.len() {
        while cursor < bytes.len()
            && !(bytes[cursor].is_ascii_alphanumeric() || bytes[cursor] == b'-')
        {
            cursor += 1;
        }
        let start = cursor;
        while cursor < bytes.len()
            && (bytes[cursor].is_ascii_alphanumeric() || bytes[cursor] == b'-')
        {
            cursor += 1;
        }
        if start == cursor {
            break;
        }
        let key = &tag[start..cursor];
        while cursor < bytes.len() && bytes[cursor].is_ascii_whitespace() {
            cursor += 1;
        }
        if cursor >= bytes.len() || bytes[cursor] != b'=' {
            continue;
        }
        cursor += 1;
        while cursor < bytes.len() && bytes[cursor].is_ascii_whitespace() {
            cursor += 1;
        }
        if cursor >= bytes.len() {
            break;
        }
        let quote = if bytes[cursor] == b'\'' || bytes[cursor] == b'"' {
            let value = bytes[cursor];
            cursor += 1;
            Some(value)
        } else {
            None
        };
        let value_start = cursor;
        while cursor < bytes.len()
            && match quote {
                Some(value) => bytes[cursor] != value,
                None => !bytes[cursor].is_ascii_whitespace() && bytes[cursor] != b'>',
            }
        {
            cursor += 1;
        }
        let value = decode_html_entities(&tag[value_start..cursor]);
        if quote.is_some() && cursor < bytes.len() {
            cursor += 1;
        }
        if key.eq_ignore_ascii_case(name) {
            return Some(value);
        }
    }
    None
}

fn parse_bookmarks_html(html: &str) -> Vec<BookmarkNode> {
    let mut roots = Vec::new();
    let mut folders: Vec<BookmarkNode> = Vec::new();
    let mut pending_folder: Option<BookmarkNode> = None;
    let mut cursor = 0;
    while let Some(start) = html[cursor..].find('<') {
        let start = cursor + start;
        let Some(relative_end) = html[start..].find('>') else {
            break;
        };
        let end = start + relative_end;
        let tag = html[start + 1..end].trim();
        let body_start = end + 1;
        let lower = tag.to_ascii_lowercase();
        if lower.starts_with("h3") {
            let close = html[body_start..].to_ascii_lowercase().find("</h3>");
            if let Some(relative_close) = close {
                let close_start = body_start + relative_close;
                let title = decode_html_entities(&html[body_start..close_start])
                    .split('<')
                    .next()
                    .unwrap_or_default()
                    .trim()
                    .to_string();
                pending_folder = Some(BookmarkNode::Folder {
                    id: new_bookmark_id(),
                    title,
                    children: Vec::new(),
                });
                cursor = close_start + 5;
                continue;
            }
        } else if lower.starts_with("/dl") {
            if let Some(folder) = folders.pop() {
                push_bookmark_node(&mut roots, &mut folders, folder);
            }
        } else if lower.starts_with("dl") {
            if let Some(folder) = pending_folder.take() {
                folders.push(folder);
            }
        } else if lower.starts_with('a') {
            let close = html[body_start..].to_ascii_lowercase().find("</a>");
            if let Some(relative_close) = close {
                let close_start = body_start + relative_close;
                let title = html[body_start..close_start]
                    .split('<')
                    .next()
                    .map(decode_html_entities)
                    .unwrap_or_default()
                    .trim()
                    .to_string();
                if let Some(url) = tag_attribute(tag, "href") {
                    let favicon = tag_attribute(tag, "icon");
                    let description = tag_attribute(tag, "description");
                    push_bookmark_node(
                        &mut roots,
                        &mut folders,
                        BookmarkNode::Bookmark {
                            id: new_bookmark_id(),
                            title,
                            url,
                            description,
                            favicon,
                        },
                    );
                }
                cursor = close_start + 4;
                continue;
            }
        }
        cursor = end + 1;
    }
    while let Some(folder) = folders.pop() {
        push_bookmark_node(&mut roots, &mut folders, folder);
    }
    roots
}

fn push_bookmark_node(
    roots: &mut Vec<BookmarkNode>,
    folders: &mut [BookmarkNode],
    node: BookmarkNode,
) {
    if let Some(BookmarkNode::Folder { children, .. }) = folders.last_mut() {
        children.push(node);
    } else {
        roots.push(node);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temporary_database() -> (std::path::PathBuf, BrowserDatabase) {
        let path = std::env::temp_dir().join(format!("unky-test-{}.sqlite", new_bookmark_id()));
        let database = BrowserDatabase::open(&path).unwrap();
        (path, database)
    }

    #[test]
    fn every_history_visit_is_retained_and_searchable() {
        let (path, database) = temporary_database();
        database
            .save_favicon(
                "https://example.com",
                "https://example.com/favicon.png",
                Some("image/png"),
                Some("data:image/png;base64,YQ=="),
            )
            .unwrap();
        database
            .record_visit("https://example.com", "One", 10)
            .unwrap();
        database
            .record_visit("https://example.com", "Two", 20)
            .unwrap();
        let all = database.history(None, 50).unwrap();
        assert_eq!(all.len(), 2);
        assert_eq!(all[0].title, "Two");
        assert_eq!(
            all[0].favicon.as_deref(),
            Some("data:image/png;base64,YQ==")
        );
        assert_eq!(database.history(Some("example"), 50).unwrap().len(), 2);
        assert_eq!(database.recent_distinct_history(10).unwrap().len(), 1);
        drop(database);
        let database = BrowserDatabase::open(&path).unwrap();
        assert_eq!(database.history(None, 50).unwrap().len(), 2);
        drop(database);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn bookmark_tree_round_trips_and_legacy_import_only_runs_once() {
        let (path, mut database) = temporary_database();
        let legacy = vec![BookmarkNode::Folder {
            id: "folder".into(),
            title: "Work".into(),
            children: vec![BookmarkNode::Bookmark {
                id: "link".into(),
                title: "Example & More".into(),
                url: "https://example.com/?a=1&b=2".into(),
                description: Some("example".into()),
                favicon: None,
            }],
        }];
        assert_eq!(database.migrate_bookmarks_once(&legacy).unwrap(), legacy);
        database.migrate_bookmarks_once(&[]).unwrap();
        assert_eq!(database.load_bookmarks().unwrap(), legacy);
        drop(database);
        let database = BrowserDatabase::open(&path).unwrap();
        assert_eq!(database.load_bookmarks().unwrap(), legacy);
        drop(database);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn netscape_bookmarks_preserve_nested_folders_and_data_icons() {
        let html = "<!DOCTYPE NETSCAPE-Bookmark-file-1><DL><p><DT><H3>Work &amp; Research</H3><DL><p><DT><A HREF=\"https://example.com/?a=1&amp;b=2\" ICON=\"data:image/png;base64,abc\">Example &amp; More</A></DL><p></DL><p>";
        let parsed = parse_bookmarks_html(html);
        assert!(
            matches!(&parsed[0], BookmarkNode::Folder { title, children, .. } if title == "Work & Research" && children.len() == 1)
        );
        let (path, mut database) = temporary_database();
        database.save_bookmarks(&parsed).unwrap();
        let exported = database.export_bookmarks_html().unwrap();
        let round_trip = parse_bookmarks_html(&exported);
        assert!(
            matches!(&round_trip[0], BookmarkNode::Folder { title, children, .. }
            if title == "Work & Research"
                && matches!(&children[0], BookmarkNode::Bookmark { title, url, favicon, .. }
                    if title == "Example & More"
                        && url == "https://example.com/?a=1&b=2"
                        && favicon.as_deref() == Some("data:image/png;base64,abc")))
        );
        drop(database);
        let _ = std::fs::remove_file(path);
    }
}
