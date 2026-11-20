# Keyboard shortcuts compared with Safari and Chrome (macOS)

This compares Unky's macOS shortcuts with the ones that Safari and Chrome share. The **Status** column says whether this branch aligned Unky with them or left a difference for later.

## Already matching

| Action                     | Safari / Chrome       | Unky                                                          |
| -------------------------- | --------------------- | ------------------------------------------------------------- |
| New tab                    | ⌘T                    | ⌘T                                                            |
| New private window         | ⇧⌘N                   | ⇧⌘N (opens a private _tab_)                                   |
| Close tab                  | ⌘W                    | ⌘W                                                            |
| Reopen closed tab          | ⇧⌘T                   | ⇧⌘T                                                           |
| Next / previous tab        | ⌃Tab, ⇧⌘] / ⌥⌘→       | ⌃Tab, ⇧⌘] and ⌥⌘→ (and the ⇧ / ← counterparts)                |
| Focus address bar          | ⌘L                    | ⌘L                                                            |
| Find in page               | ⌘F                    | ⌘F                                                            |
| Reload                     | ⌘R                    | ⌘R                                                            |
| Back / forward             | ⌘[ / ⌘]               | ⌘[ / ⌘]                                                       |
| Zoom out / actual size     | ⌘− / ⌘0               | ⌘− / ⌘0                                                       |
| Settings                   | ⌘,                    | ⌘,                                                            |
| Hide / hide others / quit  | ⌘H / ⌥⌘H / ⌘Q         | ⌘H / ⌥⌘H / ⌘Q                                                 |

## Aligned in this branch

| Action                 | Safari / Chrome                  | Unky before            | Unky now                       |
| ---------------------- | -------------------------------- | ---------------------- | ------------------------------ |
| Zoom in                | ⌘+ (the =/+ key, no Shift)       | ⇧⌘= only               | ⌘=                             |
| Select tab 1–8         | ⌘1 … ⌘8                          | none                   | ⌘1 … ⌘8 (sidebar order)        |
| Select last tab        | ⌘9                               | none                   | ⌘9                             |
| Stop loading           | ⌘. (Safari; Chrome uses Esc)     | none                   | ⌘.                             |
| Show all history       | ⌘Y                               | none                   | ⌘Y                             |
| Show downloads         | ⌥⌘L                              | none                   | ⌥⌘L                            |
| Bookmarks manager      | ⌥⌘B                              | none                   | ⌥⌘B (Bookmarks › Show All Bookmarks) |
| Enter full screen      | ⌃⌘F                              | none                   | ⌃⌘F (View menu)                |
| Minimize / zoom window | ⌘M (Window menu)                 | no Window menu         | Window menu with ⌘M            |
| New window             | ⌘N                               | none                   | ⌘N (one blank tab)             |
| Close window           | ⇧⌘W                              | none                   | ⇧⌘W                            |
| Bookmark this page     | ⌘D                               | star button only       | ⌘D (Bookmarks menu)            |
| Find next / previous   | ⌘G / ⇧⌘G                         | Enter / ⇧Enter in the find bar | ⌘G / ⇧⌘G (opens the find bar if empty) |
| Reload ignoring cache  | ⌥⌘R (Safari), ⇧⌘R (Chrome)       | none                   | both                           |
| Show/hide sidebar      | ⇧⌘L (Safari)                     | none                   | ⇧⌘L                            |
| Print                  | ⌘P                               | none                   | ⌘P (File menu)                 |
| Web Inspector          | ⌥⌘I                              | toolbar button only    | ⌥⌘I (View menu)                |
| View source | ⌥⌘U | none | ⌥⌘U (View menu): downloads the page again, or shows the live DOM if that fails |

On Windows the same commands use Ctrl (Ctrl+1 … Ctrl+9, Ctrl+N, Ctrl+Shift+W, Ctrl+D, Ctrl+G, Ctrl+Shift+R or Ctrl+F5, Ctrl+Shift+L, Ctrl+P, Ctrl+Shift+I, Ctrl+U), both in the browser UI and while a website has focus. Show history, downloads and bookmarks, full screen and the Window menu are macOS-only. Reload ignoring cache is a normal reload on Windows, since WebView2 has no cache-bypassing reload.

## Remaining differences (not changed)

These need features Unky doesn't have yet, or would break existing behavior, so they are listed for a later decision.

| Action                       | Safari / Chrome                  | Unky today              | Notes                                                                        |
| ---------------------------- | -------------------------------- | ----------------------- | ---------------------------------------------------------------------------- |
| Show bookmarks/favorites bar | ⇧⌘B                              | none                    | No bookmarks bar.                                                            |
| Save page                    | ⌘S                               | none                    | Needs a page-archive format; Save Full Page Screenshot covers images.        |
| Reopen closed tab (undo)     | ⌘Z (Safari, outside text fields) | none                    | Edit › Undo owns ⌘Z for text fields; ⇧⌘T already reopens tabs.               |
| Private window               | ⇧⌘N opens a window               | ⇧⌘N opens a private tab | Same keys, different result; Unky has private tabs, not private windows.     |
