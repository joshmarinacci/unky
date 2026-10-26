# Repository guidance

## macOS desktop browser tests

- For changes that affect the browser UI, website tabs, navigation, or native WebView behavior, run `npm run test:desktop` on macOS.
- This command builds the actual application in debug mode with the `desktop-test` Cargo feature, starts the deterministic localhost fixture, opens the app with a disposable session profile, and runs the WebdriverIO suite through `@wdio/tauri-service`'s embedded macOS provider.
- Review `test-results/child-webview-rendered.png`, `test-results/browser-state.json`, `test-results/frontend-errors.json`, `test-results/network-events.jsonl`, and `test-results/rust-logs.log` after a run. The suite also saves `failure-window.png` when a test fails.
- The Rust DOM inspection command, WDIO plugins, `wdio:` capability, and `desktop-test` frontend plugin import are restricted to debug desktop-test builds. Keep `desktop-test` out of release builds and keep `desktop-test-capability` out of the production capability list.
- The embedded WebDriver only exposes Tauri `WebviewWindow` handles; this browser’s website tabs are child WebViews inside its legacy `Window` and are not separate WebDriver contexts. The debug build adds a hidden `wdio-host` WebviewWindow in the same app process, then inspects real website children through the debug-only `desktop_test_inspect_page` Rust command, which returns their DOM and navigation state.
