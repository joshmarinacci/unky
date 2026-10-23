# Roadmap adjustment

## Active platform

macOS arm64 is the active development platform. The WKContentRuleList fixture test has passed, so work can proceed to the next implementation milestone on macOS.

## Deferred platform work

Windows and Linux interception feasibility are moved out of the current blocking milestone and into a later cross-platform milestone. They are deferred because the developer currently has no access to those machines.

The deferred work includes connecting WebView2 interception on Windows and a WebKitGTK interception hook on Linux to Tauri's website WebView, then proving on each native OS that a blocked third-party subresource never reaches the fixture server while an allowed resource does.

Until that milestone passes, describe the browser and its filtering implementation as macOS-tested. Do not claim Windows or Linux request-blocking support. Revisit the deferred gate before porting the filtering implementation broadly or publishing cross-platform support claims.

## Active implementation milestone

Build the minimal usable macOS browser shell: native WebViews per tab, tab create/select/close, URL and search navigation, back/forward/reload/stop, and page title/loading state. This is the next slice after the macOS interception proof. Keep the UI truthful: normal browsing currently has no active filtering, even though the macOS fixture path can compile and install a test content rule.

After the shell is usable, resume basic ad/tracker filtering on macOS by loading a configured reputable list, safely persisting compiled rules, and exposing working global and per-site controls. Keep the filtering core separate from the macOS adapter so later platform work can reuse it.
