//! Event names emitted from Rust to the browser UI.

pub(crate) const TAB_EVENT: &str = "browser://tabs-changed";

pub(crate) const SPLIT_EVENT: &str = "browser://split-changed";

pub(crate) const SPLIT_RESIZE_EVENT: &str = "browser://split-resize";

pub(crate) const PAGE_POINTER_DOWN_EVENT: &str = "browser://page-pointer-down";

pub(crate) const OPEN_SETTINGS_EVENT: &str = "browser://open-settings";

pub(crate) const SHOW_HISTORY_EVENT: &str = "browser://show-history";

pub(crate) const CLEAR_HISTORY_REQUEST_EVENT: &str = "browser://clear-history-request";

pub(crate) const BOOKMARKS_EVENT: &str = "browser://bookmarks-changed";

pub(crate) const OPEN_URL_FROM_MENU_EVENT: &str = "browser://open-url-from-menu";

pub(crate) const IMPORT_BOOKMARKS_EVENT: &str = "browser://import-bookmarks";

pub(crate) const EXPORT_BOOKMARKS_EVENT: &str = "browser://export-bookmarks";

pub(crate) const SHOW_DOWNLOADS_EVENT: &str = "browser://show-downloads";

pub(crate) const CAPTURE_STATUS_EVENT: &str = "browser://capture-status";

pub(crate) const CAPTURE_PROGRESS_EVENT: &str = "browser://capture-progress";

pub(crate) const SHORTCUT_EVENT: &str = "browser://shortcut";

pub(crate) const HISTORY_EVENT: &str = "browser://history-changed";

pub(crate) const ADDRESS_SUGGESTIONS_EVENT: &str = "browser://address-suggestions";

pub(crate) const DOWNLOADS_EVENT: &str = "browser://downloads-changed";

pub(crate) const SHOW_ALL_DOWNLOADS_EVENT: &str = "browser://show-all-downloads";

pub(crate) const FILTER_UPDATE_PROGRESS_EVENT: &str = "browser://filter-update-progress";

pub(crate) const LAUNCH_REQUEST_EVENT: &str = "browser://launch-request";

pub(crate) const TAB_POSITION_MENU_EVENT: &str = "browser://tab-position-menu";

pub(crate) const SHOW_BOOKMARKS_EVENT: &str = "browser://show-bookmarks";

pub(crate) const THEME_MENU_EVENT: &str = "browser://theme-menu";
