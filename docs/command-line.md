# Command-line launcher (macOS)

The `scripts/unky` launcher uses this checkout's release bundle or debug executable when available, then falls back to `/Applications/Unky.app`. This keeps the CLI and browser from the same checkout in sync. Set `UNKY_BIN` to select a different executable. The launcher was called `mybrowser` before the rename; `scripts/mybrowser` still forwards to `scripts/unky`, `MY_BROWSER_BIN` still works, and the launcher also finds installs whose executable is still named `my-browser`. Install the command in a directory on your `PATH`:

```sh
mkdir -p "$HOME/.local/bin"
ln -sfn "$PWD/scripts/unky" "$HOME/.local/bin/unky"
```

Add `export PATH="$HOME/.local/bin:$PATH"` to `~/.zshrc` if that directory is not already on your `PATH`, then open a new terminal. Usage:

```sh
unky https://example.com
unky --private https://example.com
unky https://example.com --private
unky
```

With no arguments, the command opens or focuses the browser without creating a tab. With a URL, it creates a new tab, optionally private, and focuses the browser window. It launches the browser detached from the terminal, so the command returns while the page continues loading. If Unky is already running, the request is forwarded to that process. For a different executable, set `UNKY_BIN` to its full path.

## Gatekeeper on first launch

The current release uses an ad hoc signature and is not notarized. Because of that, macOS may block a copy downloaded by a browser before the `unky` launcher can start it. For a build you created yourself and trust, remove the quarantine attribute from that specific app bundle once, then retry:

```sh
xattr -dr com.apple.quarantine "/Applications/Unky.app"
unky https://example.com
```

This removes the downloaded-file quarantine marker; it does not add a trusted developer signature. Do not use this workaround for an app whose source or download you do not trust. For public distribution, sign the app with a Developer ID certificate and notarize it with Apple. See [Apple's notarization requirements](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution).
