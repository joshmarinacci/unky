# My Browser

A Tauri 2, Rust, React, and TypeScript desktop browser prototype. The current implementation is Milestone 0: one trusted UI WebView, one separate website WebView, and a narrowly validated navigation command.

## Prerequisites

- Node.js 20.19+ or 22.12+, pnpm 9+
- Rust stable and the platform's Tauri prerequisites
- macOS: Xcode Command Line Tools
- Windows: Microsoft C++ Build Tools and WebView2 Runtime
- Linux: GTK 3, WebKit2GTK 4.1, and the Tauri build dependencies for the target distribution

See the [Tauri v2 prerequisites](https://v2.tauri.app/start/prerequisites/) for distribution-specific packages.

## Run

```sh
pnpm install
python3 tests/fixtures/server.py
pnpm tauri dev
```

The local fixture is served on `127.0.0.1:4179`, with its image resources on `127.0.0.1:4180`. The normal app run loads the fixture without enabling filtering; the macOS test command enables the filter compiler and native rule list.

## macOS filtering smoke test

After installing dependencies, run `python3 tests/macos_interception_test.py` on macOS. The test enables the `macos-interception-test` Cargo feature, compiles an ABP-style domain rule through `blocker-core` and adblock-rust into a WKContentRuleList, then loads the fixture from `http://127.0.0.1:4179/`. It passes only when the server records `/allowed.png` and does not record `/blocked.png`.

## Current status

Milestone 0 is scaffolded. The separate website WebView uses Tauri's unstable child-WebView API. The first adblock-rust to WKContentRuleList pipeline passes the macOS fixture test for a small domain-rule subset. Windows and Linux interception validation is deferred to a later cross-platform milestone; macOS is the active development platform for now. See [the roadmap](docs/roadmap.md), [filtering scope](docs/filtering.md), and [platform matrix](docs/platform-matrix.md). This prototype is not a general-purpose secure browser yet.
