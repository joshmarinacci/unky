# Linux development

Linux support is in progress and **not yet validated**. The CI builds the app, runs the Rust unit tests,
and packages it on Ubuntu 22.04 (x64 and ARM64), but nobody has run the app on Linux yet.
Do not treat a successful build as support.

## Build dependencies

On Ubuntu 22.04 or newer (the CI uses 22.04, the oldest WebKitGTK 4.1 release we target):

```sh
sudo apt-get install build-essential pkg-config file patchelf \
  libwebkit2gtk-4.1-dev libgtk-3-dev libsoup-3.0-dev libjavascriptcoregtk-4.1-dev \
  libxdo-dev librsvg2-dev libssl-dev
```

Fedora uses `webkit2gtk4.1-devel`, `gtk3-devel`, `libsoup3-devel`, `libxdo-devel` and `librsvg2-devel`. Then, as on other platforms:

```sh
npm install
npm run tauri -- dev
```

To build test packages: `npm run tauri -- build --bundles deb,appimage`. The output is in `target/release/bundle/`.
`src-tauri/tauri.linux.conf.json` selects the PNG icons, which are generated from `resources/app-icon.svg`
the same way as the Windows icon (see [Windows development](windows.md)).

## CI

Both workflows run only when started by hand. `Headless unit tests` has a Linux x64 job, and
`Build desktop bundles` builds x64 and ARM64 `.deb` and AppImage packages as
`linux-test-packages-*` artifacts. Those artifacts are not part of release candidates.
The ARM64 packages are the ones to install in an ARM Linux VM on Apple Silicon.

## Known gaps

Check these first on a real machine, under both Wayland and X11:

1. **Tab WebViews on Wayland.** Each tab is a Tauri child WebView (the `unstable` feature). WRY documents
   child WebViews on X11; Wayland needs GTK hosting. If tabs do not appear or position correctly,
   try `GDK_BACKEND=x11` to tell a Wayland problem from a general one.
2. **The page gesture check needs testing by hand.** GTK button and key handlers on each page WebView
   (`src-tauri/src/platforms/linux.rs`) record native input, so page actions such as opening a tab
   need a real click or key press, as on macOS and Windows. CI compiles and unit-tests this; check on
   a real machine that clicking a `target="_blank"` link opens a tab and a script-only open does not.
3. **Shortcuts while a website has focus.** Linux has no native menu (the menu code is gated to macOS
   and Windows), and WebKitGTK takes key presses first. Windows solves this with the page-key table in
   `src-tauri/src/platforms/windows.rs`; Linux needs the same through GTK. Menu-only actions such as
   Tab Bankruptcy and the Bookmarks and History menus have no other entry point yet.
4. **Things drawn over the page.** macOS draws the downloads and security popovers, address suggestions
   and split feedback as native overlays. On other platforms the React fallbacks are likely hidden
   under the page WebView. Wayland does not let apps position their own windows, so the macOS
   approach for address suggestions (a separate borderless window) will not carry over. Dragging a tab
   onto the page to split it is also macOS-only: `set_tab_dragging` in `src-tauri/src/commands/split.rs`
   ignores the drag elsewhere.
5. **macOS-only features.** Content filtering (WebKitGTK's `WebKitUserContentFilterStore` appears to take
   the same content-blocker JSON as macOS), full-page capture, reload ignoring cache, external-browser
   discovery, selecting a download in the file manager, and private-storage isolation all need Linux
   implementations or validation.
6. **Desktop tests.** `npm run test:desktop` is macOS-only. Tauri's own WebDriver support
   (`tauri-driver` with `WebKitWebDriver`) covers Linux and could run under Xvfb in CI.
