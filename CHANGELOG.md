# Changelog

Release notes are written under an `## <version>` heading. Candidate generation uses that version's full section for its GitHub release notes. The website shows the five newest sections, with dates taken from each GitHub Release's publication date and displayed in UTC; an unpublished candidate is marked pending.

## 0.1.4

- Websites can no longer open tabs, windows, the other split or another browser from a script; these actions now need a real click or key press on the page.
- Suggest bookmarks and history in the address bar as you type.
- Store bookmarks and history in a local SQLite database.
- Add a full Downloads page.
- Choose where tabs sit (left, right, top or bottom) from the View menu; the tab strip is now separate from the bookmarks sidebar.
- Restyle the new tab page to match the website.
- Rename tabs again from the tab menu or by double-clicking a title; renaming a bookmark folder selects its current name.
- Open the tab menu from the keyboard with Shift+F10 or the Menu key, and move through the tab and bookmark lists with the arrow keys.
- Fix the Settings "Current site" filter exception, which was always disabled.
- Ask before clearing website data and history.
- Keep each browser window's tab list to its own tabs.
- Finish renaming the app to Unky internally; existing profiles and settings are kept.
- Add an Apache 2.0 license.

## 0.1.3

- Add patch release version helper
- Match Windows download button styling
- update prose
- Update Unky download page
- Add macOS full-page webview screenshots
- Separate development app data from production
- Add external browser context menu and UI tests
- Select tab names when renaming
- Open context menu links in other split pane
- Fix tab cycling order for pinned tabs

## 0.1.2

- Fix release candidate preparation failing on a duplicate HTML escaping helper.
- Fix restored tab URLs after navigation inside a page frame.
- Add dated release notes and screenshots to the download page and release candidate.

## 0.1.1

- Improve tab-folder organization with aligned nested icons, clearer folder controls, and better hover feedback.
- Open website links directly in a selected tab folder from the context menu.
- Fix horizontal overflow in the collapsed sidebar.

## 0.1.0

- Initial prototype release.
