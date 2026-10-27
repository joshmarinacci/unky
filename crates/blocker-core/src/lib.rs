//! Small, explicitly constrained bridge from ABP-style network rules to Apple's content rules.

use adblock::lists::{FilterSet, ParseOptions};
use serde_json::Value;
use std::collections::HashSet;

const MAX_LIST_BYTES: usize = 8 * 1024 * 1024;
const MAX_RULES: usize = 80_000;
const MAX_CONTENT_RULES: usize = 50_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RejectedRule {
    pub line: usize,
    pub text: String,
    pub reason: &'static str,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompileReport {
    /// Serialized WKContentRuleList JSON.
    pub json: String,
    /// Number of input rules accepted by the declared subset and converter.
    pub accepted: usize,
    /// Input rules omitted from the compiled output, with a reason.
    pub rejected: Vec<RejectedRule>,
}

/// Convert a small ABP-style subset to Apple's declarative content-blocking format.
///
/// Supported patterns are domain-anchored `||domain^` block rules and their `@@`
/// exceptions, optionally followed by resource types and one party constraint.
/// Path, regex, cosmetic, redirect, scriptlet, and arbitrary modifier syntax is
/// rejected before it reaches the upstream converter.
pub fn compile_filter_list(input: &str) -> Result<CompileReport, String> {
    if input.len() > MAX_LIST_BYTES {
        return Err(format!("filter list exceeds {MAX_LIST_BYTES} bytes"));
    }

    let mut filter_set = FilterSet::new(true);
    let mut accepted_lines = Vec::new();
    let mut rejected = Vec::new();

    for (index, original) in input.lines().enumerate() {
        let text = original.trim();
        if text.is_empty() || text.starts_with('!') || text.starts_with('[') {
            continue;
        }
        if accepted_lines.len() + rejected.len() >= MAX_RULES {
            return Err(format!("filter list exceeds {MAX_RULES} rules"));
        }

        match supported_rule(text) {
            Ok(()) => {
                filter_set.add_filter_list(text.to_string(), ParseOptions::default());
                accepted_lines.push(text.to_string());
            }
            Err(reason) => rejected.push(RejectedRule {
                line: index + 1,
                text: text.to_string(),
                reason,
            }),
        }
    }

    let (rules, converted) = filter_set
        .into_content_blocking()
        .map_err(|_| "adblock-rust could not convert the parsed filter set".to_string())?;
    let converted: HashSet<&str> = converted.iter().map(String::as_str).collect();
    let mut accepted = 0;
    for (index, rule) in accepted_lines.iter().enumerate() {
        if converted.contains(rule.as_str()) {
            accepted += 1;
        } else {
            rejected.push(RejectedRule {
                line: input
                    .lines()
                    .position(|line| line.trim() == rule)
                    .map_or(index + 1, |line| line + 1),
                text: rule.clone(),
                reason: "upstream converter did not emit an equivalent content rule",
            });
        }
    }

    let json = serde_json::to_string(&rules).map_err(|error| error.to_string())?;
    Ok(CompileReport {
        json,
        accepted,
        rejected,
    })
}

/// Compile the supported list subset and exempt requests initiated by listed site domains.
/// WKContentRuleList's `unless-domain` matches the main document domain, which lets site
/// exceptions bypass all converted block rules without pretending to be an ABP `document`
/// exception (which would only exempt the top-level document request).
pub fn compile_filter_list_with_site_exceptions(
    input: &str,
    exception_domains: &[String],
) -> Result<CompileReport, String> {
    let mut report = compile_filter_list(input)?;
    if exception_domains.is_empty() {
        return Ok(report);
    }
    let mut value: Value = serde_json::from_str(&report.json).map_err(|error| error.to_string())?;
    let rules = value
        .as_array_mut()
        .ok_or("content rule output must be a JSON array")?;
    let domains: Vec<String> = exception_domains
        .iter()
        .flat_map(|domain| [domain.clone(), format!("*{domain}")])
        .collect();
    for rule in rules {
        if rule["action"]["type"] != "block" {
            continue;
        }
        let trigger = rule
            .get_mut("trigger")
            .and_then(Value::as_object_mut)
            .ok_or("compiled content rule has no trigger object")?;
        let unless_domains = trigger
            .entry("unless-domain")
            .or_insert_with(|| Value::Array(Vec::new()))
            .as_array_mut()
            .ok_or("compiled unless-domain must be an array")?;
        for domain in &domains {
            if !unless_domains.iter().any(|existing| existing == domain) {
                unless_domains.push(Value::String(domain.clone()));
            }
        }
    }
    report.json = serde_json::to_string(&value).map_err(|error| error.to_string())?;
    validate_content_rules_json(&report.json)?;
    Ok(report)
}

fn supported_rule(line: &str) -> Result<(), &'static str> {
    let body = line.strip_prefix("@@").unwrap_or(line);
    let (pattern, options) = match body.split_once('$') {
        Some((pattern, options)) => (pattern, Some(options)),
        None => (body, None),
    };
    let domain = pattern
        .strip_prefix("||")
        .and_then(|pattern| pattern.strip_suffix('^'))
        .ok_or("only domain-anchored ||domain^ patterns are supported")?;
    if domain.is_empty()
        || !domain.is_ascii()
        || domain.starts_with('.')
        || domain.ends_with('.')
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
        return Err("domain must be a lowercase ASCII hostname without wildcards or a port");
    }
    if domain != domain.to_ascii_lowercase() {
        return Err("domain must be lowercase ASCII");
    }

    let Some(options) = options else {
        return Ok(());
    };
    let mut party_option = None;
    for option in options.split(',') {
        match option {
            "document" | "image" | "script" | "stylesheet" | "xmlhttprequest" | "subdocument"
            | "font" | "media" | "other" => {}
            "third-party" | "~third-party" => {
                if party_option.replace(option).is_some() {
                    return Err("only one party constraint is supported");
                }
            }
            _ => return Err("resource type or modifier is outside the supported subset"),
        }
    }
    Ok(())
}

/// Check the serialized output's basic shape before handing it to WebKit.
pub fn validate_content_rules_json(json: &str) -> Result<(), String> {
    let value: Value = serde_json::from_str(json).map_err(|error| error.to_string())?;
    let rules = value
        .as_array()
        .ok_or("content rule output must be a JSON array")?;
    if rules.len() > MAX_CONTENT_RULES {
        return Err(format!(
            "compiled content rules exceed the {MAX_CONTENT_RULES} rule safety limit"
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        compile_filter_list, compile_filter_list_with_site_exceptions,
        validate_content_rules_json,
    };
    use serde_json::Value;

    #[test]
    fn compiles_supported_domain_rules_and_exceptions() {
        let report = compile_filter_list(
            "! fixture list\n||blocked.localhost^$image,third-party\n@@||allowed.localhost^$image,third-party\n",
        )
        .unwrap();
        let rules: Value = serde_json::from_str(&report.json).unwrap();
        assert_eq!(report.accepted, 2);
        assert!(report.rejected.is_empty());
        assert!(rules.as_array().unwrap().len() >= 2);
        validate_content_rules_json(&report.json).unwrap();
    }

    #[test]
    fn rejects_rules_outside_the_documented_subset() {
        let report = compile_filter_list(
            "||tracker.example^$script,third-party\n||tracker.example/path.js\nexample.com##.ad\n||tracker.example^$redirect=noop.js\n",
        )
        .unwrap();
        assert_eq!(report.accepted, 1);
        assert_eq!(report.rejected.len(), 3);
        assert_eq!(report.rejected[0].line, 2);
    }

    #[test]
    fn rejects_oversized_input_and_non_array_json() {
        assert!(compile_filter_list(&"x".repeat(8 * 1024 * 1024 + 1)).is_err());
        assert!(validate_content_rules_json("{}").is_err());
    }

    #[test]
    fn site_exceptions_exempt_main_document_domains_from_each_block_rule() {
        let report = compile_filter_list_with_site_exceptions(
            "||tracker.example^\n",
            &["news.example".into()],
        )
        .unwrap();
        let rules: Value = serde_json::from_str(&report.json).unwrap();
        let block = rules
            .as_array()
            .unwrap()
            .iter()
            .find(|rule| rule["action"]["type"] == "block")
            .unwrap();
        assert_eq!(
            block["trigger"]["unless-domain"],
            serde_json::json!(["news.example", "*news.example"])
        );
    }
}
