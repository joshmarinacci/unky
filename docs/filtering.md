# macOS filtering scope

## Current implementation

`crates/blocker-core` pins `adblock` 0.13.3 and enables its `content-blocking` feature. The upstream crate supports conversion of ABP-style rules into Apple's content-blocking format, but some rule semantics cannot be represented there. The current bridge applies an additional allowlist before conversion and reports lines the native format cannot represent.

The accepted subset is:

- Domain-anchored `||hostname^` blocking rules and `@@||hostname^` exceptions.
- Lowercase ASCII hostnames with no paths, wildcards, ports, or non-ASCII characters.
- Optional resource options: `image`, `script`, `stylesheet`, `xmlhttprequest`, `subdocument`, `font`, `media`, and `other`.
- Optional single-party constraint: `third-party` or `~third-party`.
- Blank lines, `!` comments, and list metadata headers are skipped.

The compiler rejects unsupported syntax rather than passing it along optimistically. Input is capped at 2 MiB and 20,000 rules. Unit tests cover block rules, exceptions, unsupported syntax, and input bounds. A macOS-only integration test confirms one rule blocks a subresource before server receipt.

## Current limits

- No EasyList/EasyPrivacy downloads, signatures, cache, or update path yet.
- The rule compiler is currently exercised through the macOS test feature; normal browsing has no settings UI or persistent protection toggle yet.
- No per-site allowlist or request diagnostics yet.
- WKContentRuleList is declarative and does not provide a per-request callback for accurate live block counters.
- Windows and Linux interception remain deferred; the current pipeline is macOS-tested only.

The pinned upstream crate is licensed MPL-2.0. Review its notice and source-disclosure terms before distributing a product that includes or modifies it. See the [upstream project and license](https://github.com/brave/adblock-rust).
