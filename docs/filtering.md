# macOS content filtering

## Current implementation

On macOS, content filtering is enabled by default with a small built-in starter set. Settings can turn it off, update the EasyList source, or add/remove an exception for the current site's document domain. Exceptions are compiled into each blocking rule as WebKit `unless-domain` conditions for the site's exact domain and subdomains, so its first-party pages can load resources normally. New child WebViews wait for the native rule list to compile before their first website navigation; changing the setting or exception list replaces the rules and reloads open website tabs. Private tabs use the same filter list.

EasyList updates download from the official HTTPS URL [`https://easylist.to/easylist/easylist.txt`](https://easylist.to/easylist/easylist.txt). The updater caps the download at 8 MiB, requires valid UTF-8, compiles the result before activation, and requires at least 100 supported rules. It writes the active source and compiled JSON through a temporary file and atomic rename, so download, parse, or compile failures leave the previous active list intact. The bundled starter set keeps first-run filtering useful without a network update.

The stored list contains the original source text, accepted-rule count, compiled JSON, enabled state, update time, and site exceptions in the app data directory's `filtering.json`. There is a manual **Update EasyList** action; while it runs, Settings reports download percentage when the server supplies a content length, an indeterminate connecting/download state otherwise, and a separate rule-compilation phase. WebKit does not expose compilation percentage. Automatic periodic updates are not implemented yet. The download is authenticated by HTTPS but is not separately signed. Review EasyList's license and redistribution terms before bundling its downloaded contents in a release.

## Rule compiler

`crates/blocker-core` pins `adblock` 0.13.3 and enables its `content-blocking` feature. The upstream crate supports conversion of ABP-style rules into Apple's content-blocking format, but some rule semantics cannot be represented there. The compiler applies an explicit allowlist before conversion and reports lines the native format cannot represent.

The accepted subset is:

- Domain-anchored `||hostname^` blocking rules and `@@||hostname^` exceptions.
- Lowercase ASCII hostnames with no paths, wildcards, ports, or non-ASCII characters.
- Optional resource options: `document`, `image`, `script`, `stylesheet`, `xmlhttprequest`, `subdocument`, `font`, `media`, and `other`.
- Optional single-party constraint: `third-party` or `~third-party`.
- Blank lines, `!` comments, and list metadata headers are skipped.

Input is capped at 8 MiB and 80,000 lines; compiled output is capped at 50,000 native rules. Unsupported syntax is skipped and is not active. This means the app uses only the representable domain-anchored subset of EasyList; cosmetic filters, path rules, scriptlets, redirects, and unsupported modifiers do not run. A macOS-only fixture integration test confirms one rule blocks a subresource before server receipt.

## Current limits

- EasyList's unsupported rules are omitted, so this is not equivalent to uBlock Origin or a full ABP engine. The starter set is intentionally small until EasyList has been downloaded.
- There is no signature verification or automatic update schedule.
- Site exceptions exempt requests initiated by the matching document domain; there are no per-request diagnostics or live block counters.
- WKContentRuleList is declarative and does not provide a per-request callback for accurate live block counters.
- The Settings progress indicator reports EasyList download progress only; rule compilation is shown as a separate phase without a percentage.
- Windows and Linux interception remain deferred; the current pipeline is macOS-tested only.

## Live-site regression check

On macOS, run `npm run test:desktop:real-sites` to compare observed tracker hosts on CNN, Forbes, and eight pop-culture wikis hosted by Fandom: Wookieepedia, Harry Potter Wiki, Marvel Database, DC Comics Database, Memory Alpha, Doctor Who Wiki, Simpsons Wiki, and Pokémon Wiki. WhoTracks.Me reports advertising and analytics trackers across Fandom subpages ([Fandom tracker profile](https://www.ghostery.com/whotracksme/websites/fandom.com)). The command builds the debug desktop-test app and requires an internet connection. It temporarily allows the selected pages' tracker requests in the disposable test profile during the disabled-filter baseline, then restores filtering and returns the tab to the local fixture.

The test records WebKit `PerformanceResourceTiming` resource URLs and compares them against a known ad and analytics host inventory. The inventory includes Fandom-observed providers even when the starter filter does not yet include a rule for them, so hosts that persist with filtering enabled expose coverage gaps. Its report is `test-results/real-site-tracker-results.json`. Pages that fail to load are recorded per site and excluded from the comparison, so one unavailable wiki does not prevent the remaining pages from being measured. A host observed with filtering disabled and absent when filtering is enabled is evidence consistent with a blocked request. WebKit does not expose a native per-request content-rule callback to this app, so this is comparative evidence rather than a definitive blocked-request event or a complete ad-block score. Publisher content, consent prompts, network availability, and tracker behavior change over time; a run with no baseline tracker hosts is inconclusive and fails with the report path.

The 2026-11-08 run loaded all ten pages in both states. It recorded 167 baseline host/page observations, 26 known-host observations with filtering enabled, and 145 baseline observations absent in the enabled run (87%). These counts vary by site content and region; the generated JSON report is the detailed result for each run.

The regular `npm run test:desktop` suite skips this network-dependent test. The dedicated command opts in through `MY_BROWSER_REAL_SITE_TESTS=1` and targets only `tests/desktop/specs/real-sites.spec.ts`.

The pinned upstream crate is licensed MPL-2.0. Review its notice and source-disclosure terms before distributing a product that includes or modifies it. See the [upstream project and license](https://github.com/brave/adblock-rust).
