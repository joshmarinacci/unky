# Authentication compatibility on macOS

Research checked on 2026-10-26 for the current Tauri 2 / WKWebView architecture.

## Findings

- **WebAuthn and passkeys:** WKWebView participates in Apple's Authentication Services flow, but passkey behavior depends on the relying party domain, OS version, and app association/authorization. Apple's browser guidance describes additional browser authorization through `ASAuthorizationWebBrowserPublicKeyCredentialManager`; its passkey setup guidance also describes associated-domain requirements. A general purpose browser cannot register every website's relying party domain as its own associated domain, so the app must not promise universal passkey compatibility. Test common sign-in flows on supported macOS releases and surface WebKit's normal fallback when a passkey is unavailable.
- **Password managers and autofill:** WKWebView uses the system WebKit and macOS AutoFill/password-provider integrations where WebKit exposes them. This is not equivalent to browser extension support, and behavior depends on the provider and page. Verify password fill and save flows with Apple's Passwords and at least one supported third-party password manager before claiming compatibility.
- **Extensions:** Tauri/Wry's `browser_extensions_enabled` option is unsupported on macOS and Linux. Extension-based password managers therefore cannot be assumed to work. This is an architectural limitation of the current embedded WebView approach, not a setting that can be enabled in this app.
- **Permissions:** The app currently reads some `navigator.permissions` values for display. WKWebView's permission decisions are mediated by its UI delegate; WRY owns that delegate. The current app does not expose a reliable per-site grant/revoke UI. macOS system privacy settings remain the user-facing control for OS protected resources such as camera and microphone. We need a deliberate native delegate integration before advertising granular site permission management.

## Product guidance

Describe authentication as **WebKit-based with macOS AutoFill support**, subject to site and provider compatibility. Do not promise full Chromium/Firefox password-manager extension support or universal passkey behavior. Keep authentication compatibility as a release checklist until exercised on actual supported macOS versions and account providers.

## Sources

- [Apple: Passkey use in web browsers](https://developer.apple.com/documentation/authenticationservices/passkey-use-in-web-browsers)
- [Apple: Supporting passkeys](https://developer.apple.com/documentation/authenticationservices/supporting-passkeys)
- [Apple: WKUIDelegate](https://developer.apple.com/documentation/webkit/wkuidelegate)
- [Tauri WebviewBuilder](https://docs.rs/tauri/2.12.5/tauri/webview/struct.WebviewBuilder.html)
- [Wry WebViewBuilder](https://docs.rs/wry/latest/wry/struct.WebViewBuilder.html)
