use serde::Serialize;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LaunchRequest {
    pub url: String,
    pub private: bool,
}

pub fn parse_args(args: impl IntoIterator<Item = String>) -> Result<Option<LaunchRequest>, String> {
    let mut args = args.into_iter();
    let _executable = args.next();
    let mut url = None;
    let mut private = false;
    for arg in args {
        if arg == "--private" {
            private = true;
        } else if arg.starts_with('-') {
            return Err(format!("Unknown option: {arg}"));
        } else if url.replace(arg).is_some() {
            return Err("Usage: mybrowser [--private] <url>".into());
        }
    }
    match url {
        Some(url) => Ok(Some(LaunchRequest { url, private })),
        None if private => Err("Usage: mybrowser [--private] <url>".into()),
        None => Ok(None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_url_and_optional_private_flag_in_either_order() {
        assert_eq!(
            parse_args(["mybrowser", "https://example.com", "--private"].map(str::to_string))
                .unwrap(),
            Some(LaunchRequest {
                url: "https://example.com".into(),
                private: true,
            })
        );
        assert_eq!(
            parse_args(["mybrowser", "--private", "https://example.com"].map(str::to_string))
                .unwrap()
                .unwrap()
                .url,
            "https://example.com"
        );
    }

    #[test]
    fn rejects_multiple_urls_and_unknown_options() {
        assert!(parse_args(["mybrowser", "one.test", "two.test"].map(str::to_string)).is_err());
        assert!(parse_args(["mybrowser", "--other", "one.test"].map(str::to_string)).is_err());
        assert!(parse_args(["mybrowser", "--private"].map(str::to_string)).is_err());
    }

    #[test]
    fn no_arguments_opens_the_browser_without_a_launch_request() {
        assert_eq!(parse_args(["mybrowser"].map(str::to_string)).unwrap(), None);
    }
}
