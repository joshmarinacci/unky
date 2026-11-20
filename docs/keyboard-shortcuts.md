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

On Windows, Ctrl+1 … Ctrl+9 also select tabs, both in the browser UI and while a website has focus. The other new accelerators are macOS-only for now.

## Remaining differences (not changed)

These need new features or would conflict with existing behavior, so they are listed for a later decision.

| Action                      | Safari / Chrome                  | Unky today                                  | Notes                                                                 |
| --------------------------- | -------------------------------- | ------------------------------------------- | --------------------------------------------------------------------- |
| New window                  | ⌘N                               | none                                        | Needs a "new empty window" command; windows only come from tab drags. |
| Close window                | ⇧⌘W                              | none                                        | The predefined Close Window item binds ⌘W, which is Close Tab here.   |
| Bookmark this page          | ⌘D                               | none (star button only)                     |                                                                       |
| Find next / previous        | ⌘G / ⇧⌘G                         | Enter / ⇧Enter in the find bar only         |                                                                       |
| Reload ignoring cache       | ⌥⌘R (Safari), ⇧⌘R (Chrome)       | none                                        | `reload` has no cache-bypassing variant.                              |
| Show/hide sidebar           | ⇧⌘L (Safari)                     | none                                        |                                                                       |
| Show bookmarks/favorites bar | ⇧⌘B                             | none                                        | No bookmarks bar.                                                     |
| Print / save page           | ⌘P / ⌘S                          | none                                        |                                                                       |
| Web Inspector / view source | ⌥⌘I / ⌥⌘U                        | none in the menu                            | `toggle_devtools` exists but has no accelerator.                      |
| Reopen closed tab (undo)    | ⌘Z (Safari, outside text fields) | none                                        | ⇧⌘T already works.                                                    |
| Private window              | ⇧⌘N opens a window               | ⇧⌘N opens a private tab                     | Same keys, different result.                                          |
