use serde::{Deserialize, Serialize};
use std::{fs, path::Path};

pub const EASYLIST_URL: &str = "https://easylist.to/easylist/easylist.txt";
const SETTINGS_VERSION: u32 = 1;
const MIN_ACCEPTED_UPDATE_RULES: usize = 100;
const MAX_DOWNLOAD_BYTES: usize = 8 * 1024 * 1024;

const STARTER_RULES: &str = include_str!("../../../resources/filter-starter.txt");

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FilterSettings {
    pub version: u32,
    pub enabled: bool,
    pub exceptions: Vec<String>,
    pub source_url: String,
    pub updated_at: Option<u64>,
    pub accepted_rules: usize,
    pub raw_rules: String,
    pub compiled_rules: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FilterSettingsView {
    pub enabled: bool,
    pub source_url: String,
    pub updated_at: Option<u64>,
    pub accepted_rules: usize,
    pub exceptions: Vec<String>,
}

impl FilterSettings {
    pub fn starter() -> Result<Self, String> {
        let report = compile(STARTER_RULES, &[])?;
        Ok(Self {
            version: SETTINGS_VERSION,
            enabled: cfg!(target_os = "macos"),
            exceptions: Vec::new(),
            source_url: EASYLIST_URL.into(),
            updated_at: None,
            accepted_rules: report.accepted,
            raw_rules: STARTER_RULES.into(),
            compiled_rules: report.json,
        })
    }

    pub fn load(path: &Path) -> Result<Self, String> {
        let Ok(bytes) = fs::read(path) else {
            return Self::starter();
        };
        let Ok(mut settings) = serde_json::from_slice::<Self>(&bytes) else {
            return Self::starter();
        };
        if settings.version != SETTINGS_VERSION
            || blocker_core::validate_content_rules_json(&settings.compiled_rules).is_err()
        {
            return Self::starter();
        }
        settings.exceptions = normalize_exceptions(settings.exceptions)?;
        Ok(settings)
    }

    pub fn view(&self) -> FilterSettingsView {
        FilterSettingsView {
            enabled: self.enabled,
            source_url: self.source_url.clone(),
            updated_at: self.updated_at,
            accepted_rules: self.accepted_rules,
            exceptions: self.exceptions.clone(),
        }
    }

    pub fn set_enabled(&mut self, enabled: bool) {
        self.enabled = enabled;
    }

    pub fn set_exception(&mut self, domain: &str, enabled: bool) -> Result<(), String> {
        let domain = normalize_domain(domain)?;
        if enabled {
            if !self.exceptions.contains(&domain) {
                self.exceptions.push(domain);
                self.exceptions.sort();
            }
        } else {
            self.exceptions.retain(|entry| entry != &domain);
        }
        let report = compile(&self.raw_rules, &self.exceptions)?;
        self.accepted_rules = report.accepted;
        self.compiled_rules = report.json;
        Ok(())
    }

    pub fn replace_list(&mut self, input: String, updated_at: u64) -> Result<(), String> {
        if input.len() > MAX_DOWNLOAD_BYTES {
            return Err(format!(
                "EasyList update exceeds {MAX_DOWNLOAD_BYTES} bytes"
            ));
        }
        let report = compile(&input, &self.exceptions)?;
        if report.accepted < MIN_ACCEPTED_UPDATE_RULES {
            return Err(format!(
                "EasyList update only produced {} supported rules; the current list was kept",
                report.accepted
            ));
        }
        self.raw_rules = input;
        self.compiled_rules = report.json;
        self.accepted_rules = report.accepted;
        self.source_url = EASYLIST_URL.into();
        self.updated_at = Some(updated_at);
        Ok(())
    }

    pub fn persist(&self, path: &Path) -> Result<(), String> {
        let parent = path.parent().ok_or("Filter settings path has no parent")?;
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        let temporary = path.with_extension("json.tmp");
        let bytes = serde_json::to_vec_pretty(self).map_err(|error| error.to_string())?;
        fs::write(&temporary, bytes).map_err(|error| error.to_string())?;
        fs::rename(temporary, path).map_err(|error| error.to_string())
    }
}

fn compile(raw_rules: &str, exceptions: &[String]) -> Result<blocker_core::CompileReport, String> {
    let report = blocker_core::compile_filter_list_with_site_exceptions(raw_rules, exceptions)?;
    blocker_core::validate_content_rules_json(&report.json)?;
    Ok(report)
}

fn normalize_exceptions(exceptions: Vec<String>) -> Result<Vec<String>, String> {
    let mut normalized = exceptions
        .iter()
        .map(|domain| normalize_domain(domain))
        .collect::<Result<Vec<_>, _>>()?;
    normalized.sort();
    normalized.dedup();
    Ok(normalized)
}

pub fn normalize_domain(domain: &str) -> Result<String, String> {
    let domain = domain.trim().trim_end_matches('.').to_ascii_lowercase();
    if domain.is_empty()
        || !domain.is_ascii()
        || domain.split('.').any(|label| {
            label.is_empty()
                || label.len() > 63
                || label.starts_with('-')
                || label.ends_with('-')
                || !label
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        })
    {
        return Err("Enter a valid ASCII site domain".into());
    }
    Ok(domain)
}
