# Windows development

Install Node.js and npm, Rust with an MSVC target, Microsoft C++ Build Tools
(including the matching Windows SDK and target architecture), and the WebView2
Runtime. Run these commands from the repository root:

```powershell
npm install
npm run tauri -- dev
```

To build an executable without creating an installer:

```powershell
npm run tauri -- build --debug --no-bundle
```

The workspace executable is `target/debug/my-browser.exe`. The Windows-specific
Tauri configuration selects `src-tauri/icons/icon.ico`. Its editable source is
`resources/app-icon.svg`; regenerate it with `npm run tauri -- icon
resources/app-icon.svg --output target/generated-icons`, then copy `icon.ico`
into `src-tauri/icons/`.

## Native browser commands

Windows has File, Edit, and View menus. Browser shortcuts use Ctrl: Ctrl+T,
Ctrl+Shift+N, Ctrl+W, Ctrl+Shift+T, Ctrl+L, Ctrl+F, Ctrl+R, Ctrl+Tab,
Ctrl+Shift+Tab, Ctrl+PageDown, Ctrl+PageUp, Ctrl+Shift+=, Ctrl+-, and Ctrl+0.
Ctrl+Tab / Ctrl+PageDown cycle forward; Ctrl+Shift+Tab / Ctrl+PageUp cycle
backward, matching Chrome's Windows tab-navigation shortcuts. Back and forward
use Alt+Left and Alt+Right. Settings uses Ctrl+,.

Commands that create native WebViews use `#[tauri::command(async)]` so creation
does not block the Windows WebView2 IPC callback. Keep this execution mode when
adding tab creation, tab restoration, or new-window paths.

## Validation and remaining work

```powershell
npm run check
cargo test --manifest-path src-tauri/Cargo.toml --lib
```

The automated desktop suite currently requires macOS. Windows runtime smoke
checks should use the deterministic fixture (`node tests/desktop/serve-fixtures.mjs`)
and a disposable `MY_BROWSER_PROFILE_DIR` with a debug build. Check navigation,
native shortcuts with focus inside a website, tab creation and restoration,
splits, moving tabs to another window, and session recovery.

Windows content filtering, external-browser discovery, and the native security
popover remain unimplemented. Windows private-storage isolation and installer
distribution require separate validation. A successful native build does not
establish feature parity with macOS.

Initial validation on Windows ARM64: the frontend build, Rust check, Tauri debug
build, and all 15 Rust library tests pass. A manual runtime smoke check confirmed
fixture rendering in a real WebView2 child, in-page navigation, session recovery,
Ctrl+L from a focused website, and creating, closing, and reopening tabs with
Ctrl+T, Ctrl+W, and Ctrl+Shift+T. Splits, moving tabs between windows, private
storage, installers, and x64 builds have not been validated on Windows.
