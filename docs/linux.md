# Linux development

Linux support is in progress and **not yet validated**. The CI builds the app, runs the Rust unit tests,
and packages it on Ubuntu 22.04 (x64 and ARM64). The app has been run by hand only as unky 0.1.4
(ARM64 `.deb`) on Ubuntu 24.04 with GNOME on Wayland and WebKitGTK 2.52.6, in a VM without GPU
acceleration, where it passed the gesture check and the tab layout checks below. Do not treat a
successful build as support.

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
`unky-linux-*` artifacts. Release candidates include them, and the download page offers them as a
Linux preview. The ARM64 packages are the ones to install in an ARM Linux VM on Apple Silicon.

`npm run vm:linux-test` does that for a UTM VM on a Mac: it restores the VM's clean snapshot, installs the
ARM64 `.deb` from the latest successful bundle run (or `--run <id>`, or `--deb <path>`), serves
`tests/manual/gesture-check.html` inside the VM and opens it in Unky. `--xorg` uses the X11 session instead
of Wayland. It expects an Ubuntu VM with SSH key login, passwordless `sudo` and automatic desktop login;
`--help` lists the defaults and the environment variables that change them.

## Known gaps

Check these first on a real machine, under both Wayland and X11:

1. **Tab WebViews still need checking on X11.** Each tab is a Tauri child WebView (the `unstable` feature).
   On Linux, Tauri packs every WebView of a window into the window's vertical `gtk::Box` and ignores
   their bounds, so all tabs used to be drawn at once in strips. `src-tauri/src/platforms/linux.rs` moves
   each page into a `gtk::Overlay` over the browser UI and places or hides it there. Switching tabs,
   resizing and splits work under Wayland; X11 is unchecked. In a VM without GPU acceleration everything
   is slow, because GNOME and WebKit both render on the CPU; `WEBKIT_SKIA_ENABLE_CPU_RENDERING=1`
   helps a little.
2. **The page gesture check still needs X11.** GTK button and key handlers on each page WebView
   (`src-tauri/src/platforms/linux.rs`) record native input, so page actions such as opening a tab
   need a real click or key press, as on macOS and Windows. Every step of `tests/manual/gesture-check.html`
   passed under Wayland (see above); X11 is unchecked (`npm run vm:linux-test -- --xorg`). To check by hand
   elsewhere, serve that folder over HTTP (for example `python3 -m http.server`) and open the page in Unky.
   Every step should show PASS.
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
