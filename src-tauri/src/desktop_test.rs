//! Debug-only hooks for the macOS desktop WebdriverIO suite.

use crate::*;

/// Desktop tests drive pages with synthetic DOM events that never reach AppKit's
/// event monitor, and the hidden WebDriver host can leave the browser window unfocused.
/// This debug-only hook stands in for one real click so the gate itself stays active.
pub(crate) static DESKTOP_TEST_GESTURE_AT: Mutex<Option<std::time::Instant>> = Mutex::new(None);

pub(crate) fn desktop_test_simulate_gesture() {
    let now = std::time::Instant::now();
    if let Ok(mut at) = DESKTOP_TEST_GESTURE_AT.lock() {
        *at = Some(now);
    }
    static NEXT_ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(u64::MAX / 2);
    browser::activation::tracker().record(NEXT_ID.fetch_add(1, Ordering::Relaxed), now);
}

pub(crate) fn desktop_test_gesture_is_live() -> bool {
    DESKTOP_TEST_GESTURE_AT
        .lock()
        .is_ok_and(|at| at.is_some_and(|at| at.elapsed() <= browser::activation::GESTURE_LIFETIME))
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DesktopPageDiagnostics {
    browser: BrowserSnapshot,
    window_labels: Vec<String>,
    tab_id: String,
    loading: bool,
    url: String,
    title: String,
    ready_state: String,
    resource_urls: Vec<String>,
    text: String,
    dom: String,
    errors: Vec<String>,
    context_menu: serde_json::Value,
    viewport: serde_json::Value,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DesktopTabDragOverlayDiagnostics {
    attached: bool,
    visible: bool,
    target: Option<&'static str>,
    preview: Option<&'static str>,
}

/// WebDriver attaches to the trusted `main` webview. Website tabs are separate native
/// WKWebViews, so this debug-only command inspects the selected child through Tauri's handle.
#[tauri::command]
pub(crate) async fn desktop_test_inspect_page(
    webview: tauri::Webview,
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserState>,
    tab_id: Option<String>,
    open_context_menu: Option<bool>,
) -> Result<DesktopPageDiagnostics, String> {
    if !is_trusted_browser_ui(webview.label()) {
        return Err("Desktop diagnostics are only available to the trusted browser UI".into());
    }
    let (id, loading, browser) = {
        let tabs = state
            .data
            .lock()
            .map_err(|_| "Browser state is unavailable")?;
        let tab = match tab_id {
            Some(id) => tabs.iter().find(|tab| tab.id == id),
            None => tabs.iter().find(|tab| tab.active),
        }
        .ok_or("The requested browser tab does not exist")?;
        (tab.id.clone(), tab.loading, snapshot(&tabs))
    };
    let window_labels = app.windows().keys().cloned().collect();

    let page = get_page(&app, &id)?;
    if open_context_menu == Some(true) {
        // The synthetic contextmenu event stands in for a real right-click.
        desktop_test_simulate_gesture();
        page.eval("window.__MY_BROWSER_CONTEXT_MENU_TEST_EVENT__ = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 100, clientY: 100 }); (document.querySelector('a[href]') || document.body).dispatchEvent(window.__MY_BROWSER_CONTEXT_MENU_TEST_EVENT__);")
            .map_err(|error| error.to_string())?;
        tauri::async_runtime::spawn_blocking(|| thread::sleep(Duration::from_millis(100)))
            .await
            .map_err(|error| error.to_string())?;
    }
    let script = r#"JSON.stringify((() => ({
      url: location.href,
      title: document.title,
      readyState: document.readyState,
      resourceUrls: performance.getEntriesByType('resource').map(entry => entry.name),
      viewport: { width: innerWidth, height: innerHeight },
      text: document.body?.innerText ?? '',
      dom: document.documentElement?.outerHTML ?? '',
      errors: window.__MY_BROWSER_TEST_ERRORS__ ?? [],
      contextMenu: {
        documentId: performance.timeOrigin,
        enabled: window.__MY_BROWSER_CUSTOM_CONTEXT_MENU_ENABLED__,
        errorsInstalled: Array.isArray(window.__MY_BROWSER_TEST_ERRORS__),
        prevented: window.__MY_BROWSER_CONTEXT_MENU_TEST_EVENT__?.defaultPrevented,
        hosts: document.querySelectorAll('div[aria-hidden]').length,
        visibleHosts: document.querySelectorAll('div[aria-hidden="false"]').length,
        menuItems: JSON.parse(document.querySelector('div[aria-hidden]')?.dataset.menuItems || '[]')
      }
    }))())"#;
    let (sender, receiver) = std::sync::mpsc::channel();
    page.eval_with_callback(script, move |result| {
        let _ = sender.send(result);
    })
    .map_err(|error| error.to_string())?;
    let encoded = tauri::async_runtime::spawn_blocking(move || {
        receiver
            .recv_timeout(Duration::from_secs(5))
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())??;
    let mut page: serde_json::Value =
        serde_json::from_str(&encoded).map_err(|error| error.to_string())?;
    if let Some(json) = page.as_str() {
        page = serde_json::from_str(json).map_err(|error| error.to_string())?;
    }
    Ok(DesktopPageDiagnostics {
        viewport: page["viewport"].clone(),
        context_menu: page["contextMenu"].clone(),
        browser,
        window_labels,
        tab_id: id,
        loading,
        url: page["url"].as_str().unwrap_or_default().to_string(),
        title: page["title"].as_str().unwrap_or_default().to_string(),
        ready_state: page["readyState"].as_str().unwrap_or_default().to_string(),
        resource_urls: page["resourceUrls"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|resource| resource.as_str().map(str::to_string))
            .collect(),
        text: page["text"]
            .as_str()
            .unwrap_or_default()
            .chars()
            .take(20_000)
            .collect(),
        dom: page["dom"]
            .as_str()
            .unwrap_or_default()
            .chars()
            .take(100_000)
            .collect(),
        errors: page["errors"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|error| error.as_str().map(str::to_string))
            .collect(),
    })
}

/// Inspect the macOS overlay attached to the active website child WebView.
#[tauri::command]
pub(crate) fn desktop_test_inspect_tab_drag_overlay(
    webview: tauri::Webview,
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserState>,
) -> Result<DesktopTabDragOverlayDiagnostics, String> {
    if !is_trusted_browser_ui(webview.label()) {
        return Err("Desktop diagnostics are only available to the trusted browser UI".into());
    }
    #[cfg(target_os = "macos")]
    {
        use objc2::MainThreadMarker;

        let owner = browser_window_for_ui(webview.label());
        let active_id = state
            .data
            .lock()
            .map_err(|_| "Browser state is unavailable")?
            .iter()
            .find(|tab| tab.window_label == owner && tab.active)
            .map(|tab| tab.id.clone())
            .ok_or("The browser window has no active tab")?;
        let target_id = state
            .tab_drag_target
            .lock()
            .map_err(|_| "Browser state is unavailable")?
            .clone()
            .unwrap_or(active_id);
        let page = get_page(&app, &target_id)?;
        let (sender, receiver) = std::sync::mpsc::channel();
        page.with_webview(move |_| {
            let diagnostics = MainThreadMarker::new()
                .map(|_| unsafe { platforms::tab_drag_overlay::diagnostics() });
            let result = diagnostics
                .map(|native| DesktopTabDragOverlayDiagnostics {
                    attached: native.attached,
                    visible: native.visible,
                    target: native.target,
                    preview: native.preview,
                })
                .ok_or_else(|| {
                    "Native overlay inspection requires the AppKit main thread".to_string()
                });
            let _ = sender.send(result);
        })
        .map_err(|error| error.to_string())?;
        receiver.recv().map_err(|error| error.to_string())?
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, state);
        Err("The native tab drag overlay is only available on macOS".into())
    }
}

/// Set deterministic split or invalid-drop feedback for desktop-test screenshots.
#[tauri::command]
pub(crate) fn desktop_test_show_tab_drag_feedback(
    webview: tauri::Webview,
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserState>,
) -> Result<(), String> {
    if !is_trusted_browser_ui(webview.label()) {
        return Err("Desktop diagnostics are only available to the trusted browser UI".into());
    }
    #[cfg(target_os = "macos")]
    {
        use objc2::MainThreadMarker;

        let target_id = state
            .tab_drag_target
            .lock()
            .map_err(|_| "Browser state is unavailable")?
            .clone()
            .ok_or("A tab drag must be active before capturing its preview")?;
        let page = get_page(&app, &target_id)?;
        let (sender, receiver) = std::sync::mpsc::channel();
        page.with_webview(move |_| {
            let result = MainThreadMarker::new()
                .map(|_| unsafe { platforms::tab_drag_overlay::show_test_drag_feedback() })
                .ok_or_else(|| {
                    "Native preview inspection requires the AppKit main thread".to_string()
                })
                .and_then(|visible| {
                    if visible {
                        Ok(())
                    } else {
                        Err("The native tab drag overlay is unavailable".into())
                    }
                });
            let _ = sender.send(result);
        })
        .map_err(|error| error.to_string())?;
        receiver.recv().map_err(|error| error.to_string())?
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, state);
        Err("Native tab drag previews are only available on macOS".into())
    }
}

/// Drive and inspect the trusted browser UI from the debug-only WebDriver host.
#[tauri::command]
pub(crate) async fn desktop_test_browser_ui(
    webview: tauri::Webview,
    app: tauri::AppHandle,
    action: String,
    tab_id: Option<String>,
    menu_item: Option<String>,
    target_id: Option<String>,
    tab_position: Option<String>,
    drop_position: Option<String>,
    snapshot: Option<serde_json::Value>,
    window_label: Option<String>,
) -> Result<serde_json::Value, String> {
    if !is_trusted_browser_ui(webview.label()) {
        return Err("Desktop UI controls are only available to the trusted browser UI".into());
    }
    if action == "inspect-tab-position-menu" {
        let menu = tab_position_submenu(&app).ok_or("The tab position menu is unavailable")?;
        let mut checks = serde_json::Map::new();
        for (position, _) in TAB_POSITION_MENU_OPTIONS {
            let id = format!("tab-position-{position}");
            let Some(tauri::menu::MenuItemKind::Check(item)) = menu.get(&id) else {
                return Err(format!("The {position} tab position item is unavailable"));
            };
            checks.insert(
                position.to_string(),
                serde_json::Value::Bool(item.is_checked().map_err(|error| error.to_string())?),
            );
        }
        return Ok(serde_json::Value::Object(checks));
    }
    if action == "choose-tab-position-menu" {
        let position = tab_position.ok_or("A tab position is required")?;
        choose_tab_position_from_menu(&app, "main", &position)?;
        return Ok(serde_json::Value::Bool(true));
    }
    if action == "inspect-windows" {
        let labels = app.windows().keys().cloned().collect::<Vec<_>>();
        return serde_json::to_value(labels).map_err(|error| error.to_string());
    }
    if action == "close-window" {
        let label = window_label.ok_or("A browser window label is required")?;
        if !label.starts_with("browser-window-") {
            return Err("Only test-created browser windows can be closed by this helper".into());
        }
        app.get_window(&label)
            .ok_or("The requested browser window does not exist")?
            .close()
            .map_err(|error| error.to_string())?;
        return Ok(serde_json::Value::Bool(true));
    }
    let ui = app
        .get_webview("main")
        .ok_or("The trusted browser UI is unavailable")?;
    let args = serde_json::json!({
        "action": action,
        "tabId": tab_id,
        "menuItem": menu_item,
        "targetId": target_id,
        "tabPosition": tab_position,
        "dropPosition": drop_position,
        "snapshot": snapshot,
    });
    let script = format!(
        r#"JSON.stringify((() => {{
          const args = {args};
          if (args.action === 'reset-tab-ui') {{
            if (typeof window.__myBrowserTestResetTabUi !== 'function') return {{ error: 'The tab UI reset test bridge is unavailable' }};
            window.__myBrowserTestResetTabUi();
            return {{ reset: true }};
          }}
          if (args.action === 'sync-tab-snapshot') {{
            if (typeof window.__myBrowserTestSyncTabSnapshot !== 'function') return {{ error: 'The tab snapshot test bridge is unavailable' }};
            window.__myBrowserTestSyncTabSnapshot(args.snapshot);
            return {{ synced: true }};
          }}
          if (args.action === 'set-tab-position') {{
            if (typeof window.__myBrowserTestSetTabPosition !== 'function') return {{ error: 'The tab position test bridge is unavailable' }};
            window.__myBrowserTestSetTabPosition(args.tabPosition);
            return {{ selected: args.tabPosition }};
          }}
          if (args.action === 'seed-tab-folders') {{
            if (typeof window.__myBrowserTestSeedTabFolders !== 'function') return {{ error: 'The desktop-test tab-folder bridge is unavailable' }};
            window.__myBrowserTestSeedTabFolders();
            return {{ seeded: true }};
          }}
          if (args.action === 'create-tab-folder') {{
            const switcher = document.querySelector('[role="tab"][id="tabs"]');
            if (switcher && switcher.getAttribute('aria-selected') !== 'true') switcher.click();
            const expand = document.querySelector('[aria-label="Expand sidebar"]');
            if (expand) expand.click();
            const button = document.querySelector('[aria-label="Create tab folder"]');
            if (!button) return {{ error: 'The tab folder button was not found' }};
            button.click();
            return {{ created: true }};
          }}
          if (args.action === 'finish-tab-folder-name') {{
            const input = document.querySelector('.tab-folder-name-input');
            if (input instanceof HTMLElement) input.blur();
            return {{ finished: true }};
          }}
          if (args.action === 'open-folder-context-menu') {{
            const row = Array.from(document.querySelectorAll('.tab-sortable-item')).find(node => node.dataset.tabNodeId === args.tabId);
            if (!row) return {{ error: `Tab folder ${{args.tabId}} was not found` }};
            row.dispatchEvent(new MouseEvent('contextmenu', {{ bubbles: true, cancelable: true, clientX: 100, clientY: 100 }}));
            return {{ opened: true }};
          }}
          if (args.action === 'inspect-tab-layout') {{
            const shell = document.querySelector('.browser-shell');
            const sidebar = document.querySelector('.sidebar')?.getBoundingClientRect();
            const tabStrip = (document.querySelector('.detached-tab-strip') || document.querySelector('.tab-list'))?.getBoundingClientRect();
            const page = document.querySelector('.webview-slot')?.getBoundingClientRect();
            const tree = JSON.parse(localStorage.getItem('browser.tabTree') || '[]');
            return {{
              position: shell?.getAttribute('data-tab-position'),
              persistedPosition: localStorage.getItem('browser.tabPosition'),
              sidebarSide: shell?.getAttribute('data-sidebar-side'),
              sidebarCollapsed: shell?.getAttribute('data-sidebar-collapsed') === 'true',
              tabListVisible: document.querySelector('.tab-list') !== null,
              tabsDetached: document.querySelector('.detached-tab-strip .tab-list') !== null,
              bookmarksInSidebar: document.querySelector('.sidebar .bookmark-manager') !== null,
              axis: document.querySelector('.tab-list')?.getAttribute('aria-orientation'),
              tabIds: Array.from(document.querySelectorAll('.tab-list [data-tab-id]')).map(node => node.dataset.tabId),
              tabNodeIds: Array.from(document.querySelectorAll('.tab-list [data-tab-node-id]')).map(node => node.dataset.tabNodeId),
              pinnedIds: Array.from(document.querySelectorAll('.pinned-tabs-row .pinned-tab-button')).map(node => node.dataset.tabId),
              tree,
              treeDragging: document.querySelector('.tab-tree')?.classList.contains('is-dragging') || false,
              sidebar: sidebar ? {{ x: sidebar.x, y: sidebar.y, width: sidebar.width, height: sidebar.height }} : null,
              tabStrip: tabStrip ? {{ x: tabStrip.x, y: tabStrip.y, width: tabStrip.width, height: tabStrip.height }} : null,
              page: page ? {{ x: page.x, y: page.y, width: page.width, height: page.height }} : null,
              preview: document.querySelector('.tab-drag-morph')?.className || null,
              dropTargets: Array.from(document.querySelectorAll('.tab-sortable-item.drop-before, .tab-sortable-item.drop-after, .tab-sortable-item.drop-inside, .pinned-tab-button.drop-before, .pinned-tab-button.drop-after')).map(node => ({{ id: node.dataset.tabNodeId || node.dataset.tabId, className: node.className }})),
            }};
          }}
          if (args.action === 'drag-start') {{
            const target = Array.from(document.querySelectorAll('.tab-sortable-item, .pinned-tab-button')).find(node => node.dataset.tabNodeId === args.tabId || node.dataset.tabId === args.tabId);
            if (!target) return {{ error: `Draggable tab ${{args.tabId}} was not found` }};
            const rect = target.getBoundingClientRect();
            const x = rect.left + rect.width / 2;
            const y = rect.top + rect.height / 2;
            const pointerId = 37;
            const init = {{ bubbles: true, cancelable: true, pointerId, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 1, clientX: x, clientY: y }};
            target.dispatchEvent(new PointerEvent('pointerdown', init));
            const activatedX = x + 8;
            const activatedY = y + 8;
            document.dispatchEvent(new PointerEvent('pointermove', {{ ...init, clientX: activatedX, clientY: activatedY }}));
            window.__myBrowserTestDragState = {{ pointerId, x: activatedX, y: activatedY }};
            return {{ started: true, x: activatedX, y: activatedY }};
          }}
          if (args.action === 'drag-over-tab' || args.action === 'drag-over-dock' || args.action === 'drag-over-page') {{
            const state = window.__myBrowserTestDragState;
            if (!state) return {{ error: 'No tab drag is active' }};
            let target;
            if (args.action === 'drag-over-tab') target = Array.from(document.querySelectorAll('.tab-sortable-item, .pinned-tab-button')).find(node => node.dataset.tabNodeId === args.targetId || node.dataset.tabId === args.targetId);
            if (args.action === 'drag-over-dock') target = document.querySelector('.pinned-tabs-row');
            if (args.action === 'drag-over-page') target = document.querySelector('.webview-slot');
            if (!target) return {{ error: 'The requested drag target was not found' }};
            const rect = target.getBoundingClientRect();
            const position = args.dropPosition || 'center';
            const fractions = {{ left: [0.08, 0.5], right: [0.92, 0.5], top: [0.5, 0.08], bottom: [0.5, 0.92] }};
            const [fx, fy] = fractions[position] || [0.5, 0.5];
            const x = rect.left + rect.width * fx;
            const y = rect.top + rect.height * fy;
            const move = (clientX, clientY) => document.dispatchEvent(new PointerEvent('pointermove', {{ bubbles: true, cancelable: true, pointerId: state.pointerId, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 1, clientX, clientY }}));
            move(x, y);
            state.nudge = (state.nudge || 0) + 1;
            move(x + state.nudge, y + state.nudge);
            state.x = x + state.nudge;
            state.y = y + state.nudge;
            return {{ moved: true, x, y, targetRect: {{ x: rect.x, y: rect.y, width: rect.width, height: rect.height }} }};
          }}
          if (args.action === 'drag-end' || args.action === 'drag-cancel') {{
            const state = window.__myBrowserTestDragState;
            if (!state) return {{ ended: false }};
            document.dispatchEvent(new PointerEvent(args.action === 'drag-cancel' ? 'pointercancel' : 'pointerup', {{ bubbles: true, cancelable: true, pointerId: state.pointerId, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 0, clientX: state.x, clientY: state.y }}));
            delete window.__myBrowserTestDragState;
            return {{ ended: true }};
          }}
          if (args.action === 'inspect-split-rows') {{
            return {{ groups: Array.from(document.querySelectorAll('.tab-split-row')).map(group => ({{
              first: group.dataset.splitFirst, second: group.dataset.splitSecond,
              tabs: Array.from(group.querySelectorAll('[data-tab-id]')).map(row => {{ const r = row.getBoundingClientRect(); return {{ id: row.dataset.tabId, x: r.x, y: r.y, width: r.width, selected: row.classList.contains('selected') }}; }})
            }})), tabIds: Array.from(document.querySelectorAll('[data-tab-id]')).map(row => row.dataset.tabId) }};
          }}
          if (args.action === 'toggle-downloads') {{
            document.querySelector('.downloads-trigger').click();
            return {{ clicked: true }};
          }}
          if (args.action === 'inspect-downloads') {{
            return {{ expanded: document.querySelector('.downloads-trigger')?.getAttribute('aria-expanded') === 'true', htmlPanel: !!document.querySelector('.downloads-popover') }};
          }}
          if (args.action === 'open-context-menu') {{
            const row = Array.from(document.querySelectorAll('[data-tab-id]')).find(node => node.dataset.tabId === args.tabId);
            if (!row) return {{ error: `Tab row ${{args.tabId}} was not found` }};
            if (typeof window.__myBrowserTestOpenTabContextMenu !== 'function') return {{ error: 'The desktop-test context menu bridge is unavailable' }};
            window.__myBrowserTestOpenTabContextMenu(args.tabId);
            return {{ opened: true }};
          }}
          if (args.action === 'click-context-item') {{
            const item = Array.from(document.querySelectorAll('.sidebar-context-menu [role^="menuitem"]')).find(node => node.textContent.trim() === args.menuItem);
            if (!item) return {{ error: `Context item ${{args.menuItem}} was not found` }};
            if (item.getAttribute('aria-disabled') === 'true' || item.hasAttribute('disabled')) return {{ error: `Context item ${{args.menuItem}} is disabled` }};
            item.click();
            return {{ clicked: true }};
          }}
          if (args.action === 'keyboard-context-menu') {{
            const row = Array.from(document.querySelectorAll('.tab-sortable-item')).find(node => node.dataset.tabNodeId === args.tabId);
            if (!row) return {{ error: `Tab row ${{args.tabId}} was not found` }};
            row.focus();
            row.dispatchEvent(new KeyboardEvent('keydown', {{ key: 'F10', shiftKey: true, bubbles: true, cancelable: true }}));
            return {{ opened: true }};
          }}
          if (args.action === 'focus-tab-row') {{
            const row = Array.from(document.querySelectorAll('.tab-sortable-item')).find(node => node.dataset.tabNodeId === args.tabId);
            if (!row) return {{ error: `Tab row ${{args.tabId}} was not found` }};
            row.focus();
            return {{ focused: document.activeElement === row }};
          }}
          if (args.action === 'press-key') {{
            const target = document.activeElement || document.body;
            target.dispatchEvent(new KeyboardEvent('keydown', {{ key: args.menuItem, bubbles: true, cancelable: true }}));
            target.dispatchEvent(new KeyboardEvent('keyup', {{ key: args.menuItem, bubbles: true, cancelable: true }}));
            return {{ pressed: args.menuItem }};
          }}
          if (args.action === 'inspect-focus') {{
            const active = document.activeElement;
            return {{
              menus: document.querySelectorAll('.sidebar-context-menu').length,
              renameOpen: Boolean(document.querySelector('.tab-rename-input')),
              tabNodeId: active instanceof HTMLElement ? (active.dataset.tabNodeId ?? null) : null,
              tabStops: Array.from(document.querySelectorAll('.tab-tree [role="treeitem"]')).filter(node => node.tabIndex === 0).map(node => node.dataset.tabNodeId),
              tag: active?.tagName ?? null,
              role: active?.getAttribute('role') ?? null,
              text: active?.textContent?.trim() ?? '',
              className: typeof active?.className === 'string' ? active.className : '',
              value: active instanceof HTMLInputElement ? active.value : null,
              selected: active instanceof HTMLInputElement ? active.value.slice(active.selectionStart ?? 0, active.selectionEnd ?? 0) : null,
            }};
          }}
          if (args.action === 'type-tab-rename') {{
            const input = document.querySelector('.tab-rename-input');
            if (!(input instanceof HTMLInputElement)) return {{ error: 'The tab rename field is not open' }};
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, args.menuItem);
            input.dispatchEvent(new Event('input', {{ bubbles: true }}));
            return {{ typed: true }};
          }}
          if (args.action === 'tab-title') {{
            const row = Array.from(document.querySelectorAll('[data-tab-id]')).find(node => node.dataset.tabId === args.tabId && node.querySelector('.tab-title'));
            return {{ title: row?.querySelector('.tab-title')?.textContent?.trim() ?? null }};
          }}
          if (args.action === 'click-button') {{
            const button = Array.from(document.querySelectorAll('button')).find(node => node.getAttribute('aria-label') === args.menuItem);
            if (!button) return {{ error: `Button ${{args.menuItem}} was not found` }};
            button.click();
            return {{ clicked: true }};
          }}
          if (args.action === 'inspect-site-filter') {{
            const card = Array.from(document.querySelectorAll('.settings-card')).find(node => node.querySelector('strong')?.textContent === 'Current site');
            if (!card) return {{ settingsOpen: false }};
            const button = card.querySelector('button');
            return {{ settingsOpen: true, text: card.querySelector('small')?.textContent ?? '', enabled: Boolean(button) && !button.disabled && button.getAttribute('aria-disabled') !== 'true' }};
          }}
          if (args.action === 'inspect') {{
            const page = document.querySelector('.start-page');
            const menuItems = Array.from(document.querySelectorAll('.sidebar-context-menu [role^="menuitem"]')).map(node => node.textContent.trim());
            const hasTestContextMenuBridge = typeof window.__myBrowserTestOpenTabContextMenu === 'function';
            if (!page) return {{ startPage: null, menuItems, tabRows: document.querySelectorAll('[data-tab-id]').length, menus: document.querySelectorAll('[role="menu"]').length, hasTestContextMenuBridge }};
            const rect = page.getBoundingClientRect();
            return {{ startPage: {{ text: page.innerText, left: rect.left, top: rect.top, width: rect.width, height: rect.height, className: page.className }}, slot: (() => {{ const slot = document.querySelector('.webview-slot').getBoundingClientRect(); return {{ left: slot.left, top: slot.top, width: slot.width, height: slot.height }}; }})(), menuItems, tabRows: document.querySelectorAll('[data-tab-id]').length, menus: document.querySelectorAll('[role="menu"]').length, hasTestContextMenuBridge }};
          }}
          throw new Error(`Unsupported UI test action ${{args.action}}`);
        }})())"#,
        args = args
    );
    let (sender, receiver) = std::sync::mpsc::channel();
    ui.eval_with_callback(&script, move |result| {
        let _ = sender.send(result);
    })
    .map_err(|error| error.to_string())?;
    let encoded = tauri::async_runtime::spawn_blocking(move || {
        receiver
            .recv_timeout(Duration::from_secs(5))
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())??;
    let mut value: serde_json::Value = serde_json::from_str(&encoded).map_err(|error| {
        format!("Could not decode browser UI test result ({error}); raw result: {encoded:?}")
    })?;
    if let Some(json) = value.as_str() {
        value = serde_json::from_str(json).map_err(|error| error.to_string())?;
    }
    Ok(value)
}

/// Exercise app-tab routing for a website's new-window request.
#[tauri::command]
pub(crate) fn desktop_test_request_new_window(
    webview: tauri::Webview,
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserState>,
    tab_id: String,
    url: String,
) -> Result<String, String> {
    if !is_trusted_browser_ui(webview.label()) {
        return Err("Desktop UI controls are only available to the trusted browser UI".into());
    }
    allowed_navigation_url(&url)?;
    route_webview_new_window_request(&app, &state, &tab_id, &url)
}
