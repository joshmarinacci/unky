# Platform matrix

Filtering status reflects runtime tests on macOS arm64. Initial Windows ARM64
browser builds and smoke checks now pass; Windows filtering and Linux runtime
validation remain open. See [Windows validation](windows.md).

| Platform | Engine / native request mechanism | What is confirmed | What remains open |
| --- | --- | --- | --- |
| macOS | WKWebView; `WKContentRuleListStore` compiles JSON rules and a rule list is attached to a web view's content controller. | **Passed on macOS arm64:** the fixture server recorded `/allowed.png` on origin `127.0.0.1:4180` and did not record `/blocked.png`; the page loaded from `127.0.0.1:4179`. The test compiles `||localhost^$image,third-party` through `blocker-core`/adblock-rust, attaches it with Tauri `Webview::with_webview`, then navigates. | This is a declarative content blocker, not an arbitrary per-request Rust callback. Only the small subset in [filtering scope](filtering.md) is accepted. Rule limits and rule attribution remain unresolved. |
| Windows | WebView2; `CoreWebView2.WebResourceRequested` plus URI/context filters can intercept requests and set a response. | Windows ARM64 debug build, Rust library tests, native website rendering, navigation, tab shortcuts, and session recovery passed initial checks. | Request interception and filtering remain unimplemented. Private-storage isolation, split views, multiple windows, installers, and x64 builds still need Windows validation. Frame source filtering has a newer overload and Microsoft identifies iframe request modification as experimental. |
| Linux | WebKitGTK. `WebKitWebPage::send-request` in the web extension API can modify or cancel a request before it is sent. | WebKitGTK documentation describes cancellation from an extension handler; base `WebResource::sent-request` is emitted after request sending and is not a blocking hook. | Deferred to a later milestone because no Linux machine is currently available. WebKitGTK version floor, extension packaging/loading, Wayland hosting, and Tauri/WRY integration remain unverified. The send-request web extension signal is marked unstable since API 4.1. |

## Milestone 1 feasibility decision

The macOS path is connected in a test-only feature and has passed the fixture-server check. Per the project decision, Windows and Linux feasibility checks are deferred to a later milestone while development proceeds on macOS. This deferral does not count as support on those platforms. Run their fixture-server checks before claiming support or expanding the blocker as cross-platform. The native mechanisms are materially different and do not establish shared rule semantics or parity.

References: [Microsoft WebView2 request management](https://learn.microsoft.com/en-us/microsoft-edge/webview2/how-to/webresourcerequested), [WebView2 frame request notes](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/frames), [Apple WKContentRuleListStore](https://developer.apple.com/documentation/webkit/wkcontentruleliststore), [WebKitGTK WebPage send-request](https://webkitgtk.org/reference/webkit2gtk-web-extension/2.42.4/signal.WebPage.send-request.html), [WebKitGTK WebResource sent-request](https://webkitgtk.org/reference/webkit2gtk/2.40.0/signal.WebResource.sent-request.html).
