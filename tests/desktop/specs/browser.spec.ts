import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { captureNativeWindow, inspect, invoke, results } from '../wdio.conf.js';

async function browserUi(action: string, tabId?: string, menuItem?: string, extra: Record<string, unknown> = {}) {
  return invoke('desktop_test_browser_ui', { action, tabId, menuItem, ...extra });
}

async function settleTabDragOver(action: string, extra: Record<string, unknown> = {}) {
  await browserUi(action, undefined, undefined, extra);
  await browser.pause(50);
  await browserUi(action, undefined, undefined, extra);
}

async function clickTabContextItem(tabId: string, menuItem: string) {
  await browserUi('open-context-menu', tabId);
  await browser.pause(50);
  await browser.waitUntil(async () => ((await browserUi('inspect')) as { menus: number }).menus > 0, {
    timeout: 3000,
    timeoutMsg: 'The tab context menu did not open',
  });
  const initial = await browserUi('inspect') as { menuItems: string[]; tabRows: number; menus: number; hasTestContextMenuBridge: boolean };
  assert.ok(initial, 'The browser UI test inspector did not return a result');
  assert.equal(initial.hasTestContextMenuBridge, true, `The context menu test bridge is missing: ${JSON.stringify(initial)}`);
  const targetItem = menuItem === 'Split right' ? 'Right' : menuItem === 'Duplicate tab' ? 'Duplicate' : menuItem;
  if ((menuItem.startsWith('Split ') || menuItem.startsWith('Unsplit ')) && !initial.menuItems.includes(targetItem) && initial.menuItems.includes('Split')) {
    await browserUi('click-context-item', undefined, 'Split');
  }
  await browser.waitUntil(async () => {
    const state = await browserUi('inspect') as { menuItems: string[] };
    return state.menuItems.includes(targetItem);
  }, { timeout: 3000, timeoutMsg: `The ${menuItem} context menu item did not appear (initial UI state: ${JSON.stringify(initial)})` });
  await browserUi('click-context-item', undefined, targetItem);
}

describe('native Tauri browser', () => {
  it('groups split tabs on one sidebar row and separates them when unsplit', async () => {
    type Sidebar = { groups: Array<{ first: string; second: string; tabs: Array<{ id: string; x: number; y: number; width: number; selected: boolean }> }>; tabIds: string[] };
    const created = await invoke('create_tab') as { activeTabId: string };
    const other = created.activeTabId;
    const read = () => browserUi('inspect-split-rows') as Promise<Sidebar>;
    try {
      await invoke('split_tab', { tabId: other, targetTabId: 'tab-1', side: 'right' });
      await browser.waitUntil(async () => (await read()).groups.length === 1);
      const grouped = await read();
      const pair = grouped.groups[0];
      assert.deepEqual(pair.tabs.map(tab => tab.id), [pair.first, pair.second]);
      assert.equal(pair.tabs[0].y, pair.tabs[1].y);
      assert.ok(pair.tabs[1].x >= pair.tabs[0].x + pair.tabs[0].width);
      assert.equal(grouped.tabIds.filter(id => id === other).length, 1);
      captureNativeWindow('split-sidebar-row.png');
      await invoke('select_tab', { tabId: 'tab-1' });
      await browser.waitUntil(async () => (await read()).groups[0]?.tabs.some(tab => tab.id === 'tab-1' && tab.selected));
      await invoke('clear_tab_split');
      await browser.waitUntil(async () => (await read()).groups.length === 0);
      assert.ok((await read()).tabIds.includes(other));
      await invoke('split_tab', { tabId: other, targetTabId: 'tab-1', side: 'bottom' });
      await browser.waitUntil(async () => (await read()).groups.length === 1);
      await invoke('close_tab', { tabId: other });
      await browser.waitUntil(async () => (await read()).groups.length === 0);
    } finally {
      await invoke('clear_tab_split');
      const snapshot = await invoke('get_browser_state') as { tabs: Array<{ id: string }> };
      if (snapshot.tabs.some(tab => tab.id === other)) await invoke('close_tab', { tabId: other });
    }
  });
  it('shows native downloads above the page without resizing its viewport', async () => {
    await browser.waitUntil(async () => (await inspect('tab-1')).readyState === 'complete');
    const before = await inspect('tab-1');
    const anchor = { x: 1140, y: 24, width: 30, height: 30 };
    const control = (action: string) => invoke('control_downloads_popover', { action, anchor });
    try {
      await browserUi('toggle-downloads');
      await browser.waitUntil(async () => (await browserUi('inspect-downloads') as { expanded: boolean }).expanded);
      assert.equal((await browserUi('inspect-downloads') as { htmlPanel: boolean }).htmlPanel, false);
      assert.equal(await control('update'), true);
      assert.deepEqual((await inspect('tab-1')).viewport, before.viewport);
      await invoke('navigate', { tabId: 'tab-1', url: 'http://127.0.0.1:4179/download' });
      await browser.waitUntil(async () => {
        const items = await invoke('get_downloads') as Array<{ filename: string; status: string }>;
        return items.some(item => item.filename === 'download' && item.status === 'completed');
      });
      assert.equal(await control('update'), true);
      captureNativeWindow('downloads-popover.png');
      assert.deepEqual((await inspect('tab-1')).viewport, before.viewport);
      assert.equal(await control('close'), false);
      await browser.waitUntil(async () => !(await browserUi('inspect-downloads') as { expanded: boolean }).expanded);
      assert.equal(await control('update'), false, 'refresh must not reopen a dismissed popover');
      await browserUi('toggle-downloads');
      await browser.waitUntil(async () => (await browserUi('inspect-downloads') as { expanded: boolean }).expanded);
      await browserUi('toggle-downloads');
      await browser.waitUntil(async () => !(await browserUi('inspect-downloads') as { expanded: boolean }).expanded);
    } finally {
      await control('close');
      await invoke('navigate', { tabId: 'tab-1', url: 'http://127.0.0.1:4179/' });
    }
  });
  it('opens bookmark links from the trusted UI in new tabs and windows', async () => {
    type Snapshot = { tabs: Array<{ id: string; url: string; private: boolean; windowLabel: string }>; activeTabId: string };
    const privateSource = await invoke('create_tab', { private: true }) as Snapshot;
    const url = 'http://127.0.0.1:4179/two?source=bookmark';
    await invoke('open_link_in_new_tab', { url });
    const opened = await invoke('get_browser_state') as Snapshot;
    const tab = opened.tabs.find(item => item.id === opened.activeTabId);
    assert.ok(tab);
    assert.equal(tab.url, url);
    assert.equal(tab.private, true);
    await invoke('open_link_in_new_window', { url });
    await browser.waitUntil(async () => {
      const page = await inspect(tab.id);
      return page.browser.tabs.some((item: Snapshot['tabs'][number]) => item.url === url && item.windowLabel !== 'main');
    });
    const page = await inspect(tab.id);
    const windowTab = page.browser.tabs.find((item: Snapshot['tabs'][number]) => item.url === url && item.windowLabel !== 'main');
    assert.equal(windowTab?.private, true);
    await assert.rejects(() => invoke('open_link_in_new_window', { url: 'javascript:alert(1)' }));
    if (windowTab) {
      await browserUi('close-window', undefined, undefined, { windowLabel: windowTab.windowLabel });
      await browser.waitUntil(async () => !(await browserUi('inspect-windows') as string[]).includes(windowTab.windowLabel));
    }
    await invoke('close_tab', { tabId: tab.id });
    await invoke('close_tab', { tabId: privateSource.activeTabId });
  });
  it('intercepts webpage context menus when enabled after startup and navigation', async () => {
    await browser.waitUntil(async () => (await inspect('tab-1')).readyState === 'complete');
    type MenuProbe = { contextMenu: { documentId: number; enabled: boolean; prevented: boolean; visibleHosts: number; menuItems: string[] }; errors: string[] };
    const probe = () => invoke('desktop_test_inspect_page', { tabId: 'tab-1', openContextMenu: true }) as Promise<MenuProbe>;
    await invoke('set_page_context_menu_enabled', { enabled: true });
    await browserUi('seed-tab-folders');
    const initial = await probe();
    writeFileSync(join(results, 'context-menu.json'), JSON.stringify(initial, null, 2));
    assert.equal(initial.contextMenu.enabled, true);
    assert.equal(initial.contextMenu.prevented, true, JSON.stringify(initial.contextMenu));
    assert.equal(initial.contextMenu.visibleHosts, 1, JSON.stringify(initial.errors));
    assert.ok(initial.contextMenu.menuItems.includes('Open Link in Tab Folder'), JSON.stringify(initial.contextMenu.menuItems));
    assert.ok(initial.contextMenu.menuItems.includes('Open Link in New Tab in “Desktop Test Folder”'), JSON.stringify(initial.contextMenu.menuItems));
    assert.deepEqual(initial.errors, []);
    await invoke('set_page_context_menu_enabled', { enabled: false });
    await invoke('navigate', { tabId: 'tab-1', url: 'http://127.0.0.1:4179/two' });
    await browser.waitUntil(async () => {
      const page = await inspect('tab-1');
      return page.url === 'http://127.0.0.1:4179/two' && page.readyState === 'complete';
    });
    const disabled = await probe();
    assert.equal(disabled.contextMenu.enabled, false);
    assert.equal(disabled.contextMenu.prevented, false);
    assert.equal(disabled.contextMenu.visibleHosts, 0);
    await invoke('set_page_context_menu_enabled', { enabled: true });
    await invoke('reload', { tabId: 'tab-1' });
    await browser.waitUntil(async () => {
      const page = await inspect('tab-1');
      return page.readyState === 'complete' && !page.loading && page.contextMenu.documentId !== disabled.contextMenu.documentId;
    });
    const reloaded = await probe();
    assert.equal(reloaded.contextMenu.enabled, true);
    assert.equal(reloaded.contextMenu.prevented, true);
    assert.equal(reloaded.contextMenu.visibleHosts, 1);
    assert.deepEqual(reloaded.errors, []);
    await invoke('navigate', { tabId: 'tab-1', url: 'http://127.0.0.1:4179/' });
    await browser.waitUntil(async () => {
      const page = await inspect('tab-1');
      return page.url === 'http://127.0.0.1:4179/' && page.readyState === 'complete';
    });
  });
  it('forwards a command-line URL into a private tab in the running browser', async () => {
    type Snapshot = { tabs: Array<{ id: string; url: string; private: boolean }> };
    const url = 'http://127.0.0.1:4179/two';
    const launch = spawnSync(resolve(process.cwd(), 'scripts/mybrowser'), [url, '--private'], {
      encoding: 'utf8',
      timeout: 10000,
    });
    assert.equal(launch.error, undefined, launch.error?.message);
    assert.equal(launch.status, 0, launch.stderr);
    await browser.waitUntil(async () => {
      const snapshot = await invoke('get_browser_state') as Snapshot;
      return snapshot.tabs.some(tab => tab.url === url && tab.private);
    }, { timeout: 10000, timeoutMsg: 'The running browser did not open the forwarded private tab' });
    const snapshot = await invoke('get_browser_state') as Snapshot;
    const tab = snapshot.tabs.find(candidate => candidate.url === url && candidate.private);
    assert.ok(tab);
    await browser.waitUntil(async () => {
      const page = await inspect(tab.id);
      return page.url === url && page.readyState === 'complete' && page.text.includes('Fixture Page Two');
    }, { timeout: 15000, timeoutMsg: 'The command-line private tab did not finish navigation' });
    await invoke('close_tab', { tabId: tab.id });
  });

  it('isolates private website storage and excludes private tabs from saved browsing state', async () => {
    type Snapshot = { tabs: Array<{ id: string; private: boolean }>; activeTabId: string };
    type Filters = { enabled: boolean; acceptedRules: number; exceptions: string[] };
    const initialFilters = await invoke('get_filter_settings') as Filters;
    assert.equal(initialFilters.enabled, true);
    assert.ok(initialFilters.acceptedRules > 0);
    const exceptionDomain = 'fixture.example';
    const excepted = await invoke('set_filter_site_exception', { domain: exceptionDomain, enabled: true }) as Filters;
    assert.ok(excepted.exceptions.includes(exceptionDomain));
    const restoredFilters = await invoke('set_filter_site_exception', { domain: exceptionDomain, enabled: false }) as Filters;
    assert.ok(!restoredFilters.exceptions.includes(exceptionDomain));
    const persistedFilters = JSON.parse(readFileSync(join(results, 'disposable-profile', 'filtering.json'), 'utf8')) as Filters;
    assert.ok(!persistedFilters.exceptions.includes(exceptionDomain));
    const key = `privacy_${Date.now()}`;
    const base = `http://127.0.0.1:4179/privacy?key=${key}`;
    const visit = async (tabId: string, url: string) => {
      await invoke('navigate', { tabId, url });
      await browser.waitUntil(async () => {
        const page = await inspect(tabId);
        return page.url === url && page.readyState === 'complete' && page.text.startsWith('{');
      }, { timeout: 15000 });
      const page = await inspect(tabId);
      assert.deepEqual(page.errors, []);
      return JSON.parse(page.text);
    };
    const normal = await invoke('create_tab') as Snapshot;
    const normalId = normal.activeTabId;
    assert.equal(normal.tabs.find(tab => tab.id === normalId)?.private, false);
    assert.deepEqual((await visit(normalId, `${base}&write=normal`)).after, { local: 'normal', cookie: 'normal' });

    const privateState = await invoke('create_tab', { private: true }) as Snapshot;
    const privateId = privateState.activeTabId;
    assert.equal(privateState.tabs.find(tab => tab.id === privateId)?.private, true);
    const privateUrl = `${base}&write=private`;
    const privateStorage = await visit(privateId, privateUrl);
    assert.deepEqual(privateStorage.before, { local: null, cookie: null });
    assert.deepEqual(privateStorage.after, { local: 'private', cookie: 'private' });
    assert.deepEqual((await visit(privateId, `${base}&mode=private-read`)).before, { local: 'private', cookie: 'private' });
    captureNativeWindow('private-tab.png');

    const sessionPath = join(results, 'disposable-profile', 'session.json');
    const saved = JSON.parse(readFileSync(sessionPath, 'utf8'));
    assert.ok(saved.tabs.some((tab: { id: string }) => tab.id === normalId));
    assert.ok(!saved.tabs.some((tab: { id: string }) => tab.id === privateId));
    const history = await invoke('get_history') as Array<{ url: string }>;
    assert.ok(history.some(entry => entry.url === `${base}&write=normal`));
    assert.ok(!history.some(entry => entry.url === privateUrl || entry.url === `${base}&mode=private-read`));
    const storedHistory = await invoke('get_history') as Array<{ url: string }>;
    assert.ok(!storedHistory.some(entry => entry.url === privateUrl || entry.url === `${base}&mode=private-read`));

    await invoke('close_tab', { tabId: privateId });
    const closed = JSON.parse(readFileSync(sessionPath, 'utf8'));
    assert.ok(!closed.recentlyClosed.some((tab: { id: string }) => tab.id === privateId));
    const fresh = await invoke('create_tab', { private: true }) as Snapshot;
    assert.deepEqual((await visit(fresh.activeTabId, `${base}&mode=fresh`)).before, { local: null, cookie: null });
    await invoke('close_tab', { tabId: fresh.activeTabId });
    assert.deepEqual((await visit(normalId, base)).before, { local: 'normal', cookie: 'normal' });
    await invoke('close_tab', { tabId: normalId });
    await invoke('select_tab', { tabId: 'tab-1' });
    writeFileSync(join(results, 'private-storage.json'), JSON.stringify({ privateStorage, saved, history }, null, 2));
  });

  it('splits from the tab context menu, shows the start page, unsplits, duplicates, and closes tabs', async () => {
    await browser.waitUntil(async () => {
      const page = await inspect('tab-1');
      return page.url === 'http://127.0.0.1:4179/' && page.readyState === 'complete';
    }, { timeout: 15000, timeoutMsg: 'The starting tab did not load for the context-menu test' });
    await invoke('select_tab', { tabId: 'tab-1' });

    await clickTabContextItem('tab-1', 'Split right');
    let companionTabId = '';
    await browser.waitUntil(async () => {
      const split = await invoke('get_split_tabs') as { firstTabId: string; secondTabId: string } | null;
      if (split && split.firstTabId !== 'tab-1' && split.secondTabId === 'tab-1') companionTabId = split.firstTabId;
      return Boolean(split && split.firstTabId !== 'tab-1' && split.secondTabId === 'tab-1');
    }, { timeout: 5000, timeoutMsg: 'The active tab context action did not create a start-page companion' });
    const splitUi = await browserUi('inspect') as { startPage: { text: string; width: number } | null; slot: { width: number } };
    assert.match(splitUi.startPage?.text ?? '', /Where to\?/);
    assert.ok(splitUi.startPage!.width < splitUi.slot.width, 'the start page should fit within one split pane');

    await clickTabContextItem('tab-1', 'Unsplit from other tab');
    assert.equal(await invoke('get_split_tabs'), null, 'the tab context action should remove the split');
    await clickTabContextItem(companionTabId, 'Close tab');
    await browser.waitUntil(async () => {
      const state = await invoke('get_browser_state') as { tabs: Array<{ id: string }> };
      return !state.tabs.some(tab => tab.id === companionTabId);
    }, { timeout: 5000, timeoutMsg: 'The start-page companion tab should close after the split test' });

    await clickTabContextItem('tab-1', 'Duplicate tab');
    let duplicateTabId = '';
    await browser.waitUntil(async () => {
      const state = await invoke('get_browser_state') as { tabs: Array<{ id: string; url: string; private: boolean }> };
      const duplicate = state.tabs.find(tab => tab.id !== 'tab-1' && tab.url === 'http://127.0.0.1:4179/' && !tab.private);
      duplicateTabId = duplicate?.id ?? '';
      return Boolean(duplicate);
    }, { timeout: 5000, timeoutMsg: 'Duplicate tab did not copy the page URL' });
    await clickTabContextItem(duplicateTabId, 'Close tab');
    await browser.waitUntil(async () => {
      const state = await invoke('get_browser_state') as { tabs: Array<{ id: string }> };
      return !state.tabs.some(tab => tab.id === duplicateTabId);
    }, { timeout: 5000, timeoutMsg: 'Close tab context action did not remove the tab' });

    const privateTab = await invoke('create_tab', { private: true }) as { activeTabId: string };
    await invoke('navigate', { tabId: privateTab.activeTabId, url: 'http://127.0.0.1:4179/two' });
    await browser.waitUntil(async () => {
      const state = await invoke('get_browser_state') as { tabs: Array<{ id: string; url: string; private: boolean }> };
      return state.tabs.some(tab => tab.id === privateTab.activeTabId && tab.url === 'http://127.0.0.1:4179/two' && tab.private);
    }, { timeout: 5000, timeoutMsg: 'The private source tab did not finish navigating' });
    await clickTabContextItem(privateTab.activeTabId, 'Duplicate tab');
    let privateDuplicateId = '';
    await browser.waitUntil(async () => {
      const state = await invoke('get_browser_state') as { tabs: Array<{ id: string; url: string; private: boolean }> };
      const duplicate = state.tabs.find(tab => tab.id !== privateTab.activeTabId && tab.url === 'http://127.0.0.1:4179/two' && tab.private);
      privateDuplicateId = duplicate?.id ?? '';
      return Boolean(duplicate);
    }, { timeout: 5000, timeoutMsg: 'A duplicated private tab should keep private mode' });
    await invoke('close_tab', { tabId: privateDuplicateId });
    await invoke('close_tab', { tabId: privateTab.activeTabId });
    await browser.waitUntil(async () => {
      const state = await invoke('get_browser_state') as { tabs: Array<{ id: string }> };
      return state.tabs.length === 1 && state.tabs[0].id === 'tab-1';
    }, { timeout: 5000, timeoutMsg: 'The context-menu test should restore the initial one-tab browser state' });
  });

  it('routes website new-window links into tabs in the current browser window', async () => {
    const privateSource = await invoke('create_tab', { private: true }) as { activeTabId: string; tabs: Array<{ id: string; windowLabel: string }> };
    await invoke('navigate', { tabId: privateSource.activeTabId, url: 'http://127.0.0.1:4179/' });
    await browser.waitUntil(async () => {
      const page = await inspect(privateSource.activeTabId);
      return page.url === 'http://127.0.0.1:4179/' && page.readyState === 'complete';
    }, { timeout: 15000, timeoutMsg: 'The private source page did not load' });
    const source = await inspect(privateSource.activeTabId);
    assert.match(source.dom, /data-testid="open-new-window"/);
    const sourceWindowLabel = source.browser.tabs.find((tab: { id: string }) => tab.id === privateSource.activeTabId)?.windowLabel;
    assert.ok(sourceWindowLabel);
    const sourceTabCount = source.browser.tabs.length;
    const url = 'http://127.0.0.1:4179/two?source=new-window';
    const ownerWindowLabel = await invoke('desktop_test_request_new_window', { tabId: privateSource.activeTabId, url }) as string;

    let newWindowTab: { id: string; windowLabel: string; private: boolean } | undefined;
    await browser.waitUntil(async () => {
      const page = await inspect(privateSource.activeTabId);
      newWindowTab = page.browser.tabs.find((tab: { id: string; url: string; windowLabel: string; private: boolean }) =>
        tab.url === url && tab.windowLabel === ownerWindowLabel);
      return Boolean(newWindowTab && page.browser.tabs.length === sourceTabCount + 1);
    }, { timeout: 10000, timeoutMsg: 'The WebKit new-window request did not create a tab in the current browser window' });
    assert.ok(newWindowTab);
    await browser.waitUntil(async () => {
      const page = await inspect(newWindowTab!.id);
      return page.url === url && page.readyState === 'complete' && page.text.includes('Fixture Page Two');
    }, { timeout: 15000, timeoutMsg: 'The link in the new tab did not load' });
    assert.equal(newWindowTab.private, true, 'the new tab should preserve its private source tab mode');
    assert.equal(newWindowTab.windowLabel, sourceWindowLabel, 'the new tab should stay in the source browser window');

    await invoke('close_tab', { tabId: newWindowTab.id });
    await browser.waitUntil(async () => {
      const page = await inspect(privateSource.activeTabId);
      return page.browser.tabs.length === sourceTabCount && !page.browser.tabs.some((tab: { id: string }) => tab.id === newWindowTab!.id);
    }, { timeout: 5000, timeoutMsg: 'The tab opened from the WebKit menu did not close cleanly' });
    await invoke('close_tab', { tabId: privateSource.activeTabId });
  });

  it('loads a child WebView, navigates, switches tabs, and captures the native window', async () => {
    await browser.waitUntil(async () => {
      const page = await inspect('tab-1');
      return page.readyState === 'complete' && page.text.includes('Fixture Page One');
    }, { timeout: 20000, timeoutMsg: 'The local fixture did not render in the first child WebView' });
    const initial = await inspect('tab-1');

    assert.equal(initial.title, 'Desktop fixture · One');
    assert.equal(initial.url, 'http://127.0.0.1:4179/');
    assert.match(initial.dom, /data-testid="fixture-one"/);
    assert.equal(initial.loading, false);
    const initialScreenshot = captureNativeWindow('child-webview-rendered.png');

    await invoke('set_tab_dragging', { dragging: true, tabId: null, targetTabId: 'tab-1' });
    try {
      const overlay = await invoke('desktop_test_inspect_tab_drag_overlay') as {
        attached: boolean;
        visible: boolean;
        target: string | null;
        preview: string | null;
      };
      assert.equal(overlay.attached, true, 'the preview should attach above the active website WebView');
      assert.equal(overlay.visible, true, 'the native preview should be visible during a tab drag');
      const pageDuringDrag = await inspect('tab-1');
      assert.match(pageDuringDrag.text, /Fixture Page One/, 'the page remains rendered beneath the preview');
      captureNativeWindow('tab-drag-overlay.png');
    } finally {
      await invoke('set_tab_dragging', { dragging: false, tabId: null, targetTabId: null });
    }
    const removedOverlay = await invoke('desktop_test_inspect_tab_drag_overlay') as {
      attached: boolean;
      visible: boolean;
      target: string | null;
      preview: string | null;
    };
    assert.deepEqual(removedOverlay, { attached: false, visible: false, target: null, preview: null });

    const state = await invoke('create_tab') as { tabs: Array<{ id: string }>; activeTabId: string };
    const secondTab = state.tabs.find((tab) => tab.id !== 'tab-1');
    assert.ok(secondTab, 'new tab command should create a second website child WebView');
    await invoke('navigate', { tabId: secondTab.id, url: 'http://127.0.0.1:4179/two' });
    await browser.waitUntil(async () => {
      const page = await inspect(secondTab.id);
      return page.readyState === 'complete' && page.text.includes('Fixture Page Two');
    }, { timeout: 20000, timeoutMsg: 'The second local fixture did not finish loading' });
    const second = await inspect(secondTab.id);
    assert.equal(second.url, 'http://127.0.0.1:4179/two');
    const secondTabWindow = second.browser.tabs.find((tab: { id: string; windowLabel: string }) => tab.id === secondTab.id)?.windowLabel;
    assert.ok(secondTabWindow, 'the second tab should have an owning browser window');
    assert.equal(second.browser.tabs.filter((tab: { windowLabel: string }) => tab.windowLabel === secondTabWindow).length, 2);

    const thirdState = await invoke('create_tab') as { tabs: Array<{ id: string }>; activeTabId: string };
    const thirdTabId = thirdState.activeTabId;
    await invoke('navigate', { tabId: thirdTabId, url: 'http://127.0.0.1:4179/?third=1' });
    await browser.waitUntil(async () => {
      const page = await inspect(thirdTabId);
      return page.readyState === 'complete' && page.text.includes('Fixture Page One');
    }, { timeout: 20000, timeoutMsg: 'The third local fixture did not finish loading' });
    await invoke('select_tab', { tabId: 'tab-1' });

    await invoke('set_tab_dragging', { dragging: true, tabId: null, targetTabId: secondTab.id });
    try {
      const selectedTarget = await invoke('select_tab', { tabId: 'tab-1' }) as { activeTabId: string };
      assert.equal(selectedTarget.activeTabId, 'tab-1');
      const overlayWhileTargetInactive = await invoke('desktop_test_inspect_tab_drag_overlay') as {
        attached: boolean;
        visible: boolean;
        target: string | null;
        preview: string | null;
      };
      assert.equal(overlayWhileTargetInactive.attached, true, 'the overlay stays attached to the page that drag started over');
      assert.equal(overlayWhileTargetInactive.visible, true);
    } finally {
      await invoke('set_tab_dragging', { dragging: false, tabId: null, targetTabId: null });
    }
    const hiddenOriginalTargetOverlay = await invoke('desktop_test_inspect_tab_drag_overlay') as {
      attached: boolean;
      visible: boolean;
      target: string | null;
      preview: string | null;
    };
    assert.deepEqual(hiddenOriginalTargetOverlay, { attached: false, visible: false, target: null, preview: null });

    await invoke('split_tab', { tabId: 'tab-1', targetTabId: secondTab.id, side: 'left' });
    const explicitTargetSplit = await invoke('get_split_tabs') as { firstTabId: string; secondTabId: string; orientation: string } | null;
    assert.deepEqual(explicitTargetSplit, {
      firstTabId: 'tab-1',
      secondTabId: secondTab.id,
      orientation: 'horizontal',
      firstPanePercent: 50,
    }, 'a split should use its captured target even when the dragged tab became active');
    await invoke('clear_tab_split');

    const blankCompanion = await invoke('create_tab') as Snapshot;
    const blankTab = blankCompanion.tabs.find(tab => tab.id === blankCompanion.activeTabId)!;
    assert.equal(blankTab.url, '', 'a new tab should remain blank when created as a split companion');
    await invoke('split_tab', { tabId: 'tab-1', targetTabId: blankTab.id, side: 'right' });
    assert.deepEqual(await invoke('get_split_tabs'), {
      firstTabId: blankTab.id,
      secondTabId: 'tab-1',
      orientation: 'horizontal',
      firstPanePercent: 50,
    }, 'a loaded tab should split alongside a newly created blank tab');
    captureNativeWindow('split-with-new-tab.png');
    await invoke('close_tab', { tabId: blankTab.id });

    await invoke('set_tab_dragging', { dragging: true, tabId: 'tab-1', targetTabId: 'tab-1' });
    await invoke('set_tab_dragging', { dragging: false, tabId: null, targetTabId: null, cancelled: true });
    await browser.pause(500);
    assert.equal(await invoke('get_split_tabs'), null, 'a cancelled tab drag must not split');
    await invoke('clear_tab_split');

    const switched = await invoke('select_tab', { tabId: 'tab-1' }) as { tabs: Array<{ id: string; active: boolean }> };
    assert.equal(switched.tabs.find((tab) => tab.id === 'tab-1')?.active, true);
    assert.equal(switched.tabs.find((tab) => tab.id === secondTab.id)?.active, false);
    const afterSwitch = await inspect();
    assert.equal(afterSwitch.tabId, 'tab-1');
    assert.match(afterSwitch.text, /Fixture Page One/);

    await invoke('split_tab', { tabId: secondTab.id, targetTabId: 'tab-1', side: 'right' });
    const splitTabs = await invoke('get_split_tabs') as { firstTabId: string; secondTabId: string; orientation: string } | null;
    assert.deepEqual(splitTabs, {
      firstTabId: 'tab-1',
      secondTabId: secondTab.id,
      orientation: 'horizontal',
      firstPanePercent: 50,
    }, 'right split should place the active page before the dragged page');
    captureNativeWindow('split-view.png');
    await invoke('resize_tab_split', { firstPanePercent: 67 });
    const resizedSplit = await invoke('get_split_tabs') as { firstPanePercent: number } | null;
    assert.equal(resizedSplit?.firstPanePercent, 67, 'the native divider should update the first pane size');
    captureNativeWindow('resized-split-view.png');
    await invoke('resize_tab_split', { firstPanePercent: 50 });

    await invoke('select_tab', { tabId: secondTab.id });
    assert.deepEqual(await invoke('get_split_tabs'), splitTabs, 'selecting either pane should keep the split intact');
    await invoke('select_tab', { tabId: 'tab-1' });
    assert.deepEqual(await invoke('get_split_tabs'), splitTabs, 'returning to the other pane should keep the split intact');
    await invoke('select_tab', { tabId: thirdTabId });
    assert.deepEqual(await invoke('get_split_tabs'), splitTabs, 'a tab outside the split should not change its pane membership');
    assert.equal((await invoke('get_browser_state') as { activeTabId: string }).activeTabId, thirdTabId);
    captureNativeWindow('split-view-suspended-for-other-tab.png');
    await invoke('select_tab', { tabId: 'tab-1' });
    assert.deepEqual(await invoke('get_split_tabs'), splitTabs, 'returning to a split tab should restore the original pair');
    captureNativeWindow('split-view-restored-after-tab-select.png');

    await invoke('split_tab', { tabId: secondTab.id, targetTabId: 'tab-1', side: 'bottom' });
    const verticalSplit = await invoke('get_split_tabs') as { firstTabId: string; secondTabId: string; orientation: string } | null;
    assert.deepEqual(verticalSplit, {
      firstTabId: 'tab-1',
      secondTabId: secondTab.id,
      orientation: 'vertical',
      firstPanePercent: 50,
    }, 'bottom split should place the active page above the dragged page');
    captureNativeWindow('vertical-split.png');

    const newWindowLabel = await invoke('move_tab_to_new_window', { tabId: secondTab.id }) as string;
    await browser.waitUntil(async () => {
      const page = await inspect(secondTab.id);
      return page.readyState === 'complete'
        && page.browser.tabs.find((tab: { id: string; windowLabel?: string }) => tab.id === secondTab.id)?.windowLabel === newWindowLabel
        && page.windowLabels.includes(newWindowLabel);
    }, {
      timeout: 10000,
      timeoutMsg: `The tab was not reattached to native browser window ${newWindowLabel}`,
    });
    const movedPage = await inspect(secondTab.id);
    assert.match(movedPage.text, /Fixture Page Two/);

    const errors = [...initial.errors, ...second.errors, ...afterSwitch.errors];
    writeFileSync(join(results, 'frontend-errors.json'), JSON.stringify(errors, null, 2));
    writeFileSync(join(results, 'browser-state.json'), JSON.stringify(afterSwitch.browser, null, 2));
    assert.deepEqual(errors, [], 'fixture frontend should have no JavaScript errors');
    const requests = readFileSync(join(results, 'network-events.jsonl'), 'utf8');
    assert.match(requests, /"path":"\/api\/status"/);
    assert.match(requests, /"path":"\/two"/);
    assert.ok(initialScreenshot.endsWith('child-webview-rendered.png'));
  });
  it('discovers installed browsers and validates current-page handoff', async () => {
    const browsers = await invoke('get_external_browsers') as Array<{ id: string; name: string }>;
    assert.ok(browsers.length > 0, 'macOS should report an installed HTTPS browser');
    assert.ok(browsers.every(item => item.id && item.name && item.id !== 'dev.example.my-browser'));
    assert.equal(new Set(browsers.map(item => item.id)).size, browsers.length);
    const browserId = browsers[0].id;
    const blank = await invoke('create_tab') as { activeTabId: string };
    const tabId = blank.activeTabId;
    await assert.rejects(invoke('open_in_external_browser', { tabId, browserId }), /Open a web page first|Only HTTP\(S\) pages/);
    const url = 'http://127.0.0.1:4179/two?handoff=one%20two&next=%2Fthree#section';
    await invoke('navigate', { tabId, url });
    await browser.waitUntil(async () => (await inspect(tabId)).url === url);
    await assert.rejects(invoke('open_in_external_browser', { tabId, browserId: 'not.an.installed.browser' }), /no longer available/);
    await assert.rejects(invoke('open_in_external_browser', { tabId: 'missing-tab', browserId }), /does not belong/);
    const state = (await inspect(tabId)).browser;
    const otherWindowTab = state.tabs.find((tab: { windowLabel: string }) => tab.windowLabel !== 'main');
    assert.ok(otherWindowTab, 'the window-move test should leave a tab in another native window');
    await assert.rejects(invoke('open_in_external_browser', { tabId: otherWindowTab.id, browserId }), /does not belong/);
    await invoke('select_tab', { tabId: 'tab-1' });
    await invoke('open_in_external_browser', { tabId, browserId });
    const dispatched = JSON.parse(readFileSync(join(results, 'disposable-profile', 'external-open.json'), 'utf8'));
    assert.deepEqual(dispatched, { browserId, tabId, url });
    assert.equal((await inspect(tabId)).url, url, 'handoff should leave the original tab open');
    assert.equal((await invoke('get_browser_state') as { activeTabId: string }).activeTabId, 'tab-1', 'opening a background tab elsewhere should not select it');
    writeFileSync(join(results, 'external-browser-handoff.json'), JSON.stringify({ browsers, dispatched, launchStubbed: true }, null, 2));
    await invoke('close_tab', { tabId });
  });

  it('supports four tab-strip positions, pointer folder drops, pin docking, and page split feedback', async () => {
    type TabNode = { id: string; type: 'tab' } | { id: string; type: 'folder'; title: string; children: TabNode[] };
    type Layout = {
      position: string;
      persistedPosition: string;
      sidebarCollapsed: boolean;
      tabListVisible: boolean;
      tabsDetached: boolean;
      bookmarksInSidebar: boolean;
      axis: string;
      sidebarSide: 'left' | 'right';
      tabIds: string[];
      pinnedIds: string[];
      tree: TabNode[];
      sidebar: { x: number; y: number; width: number; height: number };
      tabStrip: { x: number; y: number; width: number; height: number };
      page: { x: number; y: number; width: number; height: number };
      preview: string | null;
      dropTargets: Array<{ id: string; className: string }>;
    };
    const read = () => browserUi('inspect-tab-layout') as Promise<Layout>;
    const originalPosition = (await read()).persistedPosition || 'left';
    const createdIds: string[] = [];
    let folderId = '';
    let dragActive = false;
    const captureLayoutScreenshot = (filename: string) => {
      try { captureNativeWindow(filename); }
      catch (error) { console.warn(`Could not capture ${filename}: ${String(error)}`); }
    };
    await browserUi('reset-tab-ui');
    await browser.pause(50);
    await browserUi('set-tab-position', undefined, undefined, { tabPosition: originalPosition });
    await invoke('select_tab', { tabId: 'tab-1' });
    const first = await invoke('create_tab') as { activeTabId: string };
    createdIds.push(first.activeTabId);
    const second = await invoke('create_tab') as { activeTabId: string };
    createdIds.push(second.activeTabId);
    const third = await invoke('create_tab') as { activeTabId: string };
    createdIds.push(third.activeTabId);
    try {
      const current = await invoke('get_browser_state') as { activeTabId: string; tabs: Array<{ id: string; windowLabel?: string }> };
      const owner = current.tabs.find(tab => tab.id === current.activeTabId)?.windowLabel;
      const currentWindow = owner ? { ...current, tabs: current.tabs.filter(tab => tab.windowLabel === owner) } : current;
      const synced = await browserUi('sync-tab-snapshot', undefined, undefined, { snapshot: currentWindow }) as { synced?: boolean; error?: string };
      assert.equal(synced.synced, true, `The browser UI did not accept the current-window snapshot: ${JSON.stringify(synced)}`);
      for (const tabId of createdIds) {
        if ((await read()).pinnedIds.includes(tabId)) await clickTabContextItem(tabId, 'Unpin');
      }
      for (const [index, tabId] of createdIds.entries()) {
        await invoke('navigate', { tabId, url: `http://127.0.0.1:4179/?tab-dnd=${index}` });
      }
      try {
        await browser.waitUntil(async () => {
          const layout = await read();
          return createdIds.every(id => layout.tabIds.includes(id));
        }, { timeoutMsg: 'The new tabs did not appear in the tab strip' });
      } catch (error) {
        const layout = await read();
        const state = await invoke('get_browser_state');
        throw new Error(`${String(error)}\nTab layout: ${JSON.stringify(layout)}\nBrowser state: ${JSON.stringify(state)}`);
      }

      for (const position of ['left', 'right', 'top', 'bottom'] as const) {
        await browserUi('set-tab-position', undefined, undefined, { tabPosition: position });
        await browser.waitUntil(async () => (await read()).position === position && (await read()).persistedPosition === position);
        const layout = await read();
        assert.equal(layout.sidebarCollapsed, false, 'the tab strip should be expanded in every position');
        assert.equal(layout.tabListVisible, true, 'the tab list should remain visible in every position');
        assert.ok(createdIds.every(id => layout.tabIds.includes(id)), 'all tabs should remain visible in every position');
        assert.equal(layout.axis, position === 'top' || position === 'bottom' ? 'horizontal' : 'vertical');
        assert.equal(layout.tabsDetached, position === 'top' || position === 'bottom', 'top and bottom tabs should live outside the sidebar');
        assert.equal(layout.bookmarksInSidebar, position === 'top' || position === 'bottom', 'when tabs detach, the bookmarks manager should stay in the side panel');
        if (position === 'left') assert.ok(layout.sidebar.x + layout.sidebar.width <= layout.page.x, 'left tabs should remain in the left sidebar');
        if (position === 'right') assert.ok(layout.sidebar.x >= layout.page.x + layout.page.width, 'right tabs should remain in the right sidebar');
        if (position === 'top') {
          assert.ok(layout.tabStrip.y + layout.tabStrip.height <= layout.page.y, 'top tabs should sit above the page');
          if (layout.sidebarSide === 'left') assert.ok(layout.sidebar.x + layout.sidebar.width <= layout.page.x, 'the bookmarks sidebar should remain to the left of the page');
          else assert.ok(layout.sidebar.x >= layout.page.x + layout.page.width, 'the bookmarks sidebar should remain to the right of the page');
        }
        if (position === 'bottom') {
          assert.ok(layout.tabStrip.y >= layout.page.y + layout.page.height, 'bottom tabs should sit below the page');
          if (layout.sidebarSide === 'left') assert.ok(layout.sidebar.x + layout.sidebar.width <= layout.page.x, 'the bookmarks sidebar should remain to the left of the page');
          else assert.ok(layout.sidebar.x >= layout.page.x + layout.page.width, 'the bookmarks sidebar should remain to the right of the page');
        }
        await browser.pause(150);
        captureLayoutScreenshot(`tab-strip-${position}.png`);
      }

      await browserUi('set-tab-position', undefined, undefined, { tabPosition: 'left' });
      await browser.waitUntil(async () => (await read()).position === 'left');
      const createdFolder = await browserUi('create-tab-folder') as { created: boolean };
      assert.equal(createdFolder.created, true);
      await browser.waitUntil(async () => (await read()).tree.some(node => node.type === 'folder' && node.title === 'New Folder'));
      await browserUi('finish-tab-folder-name');
      const folder = (await read()).tree.find(node => node.type === 'folder' && node.title === 'New Folder');
      assert.ok(folder && folder.type === 'folder');
      folderId = folder.id;
      await browser.waitUntil(async () => (await read()).tree.some(node => node.type === 'folder' && node.id === folderId));

      await browserUi('drag-start', first.activeTabId);
      dragActive = true;
      await browser.pause(50);
      const movedIntoFolder = await browserUi('drag-over-tab', undefined, undefined, { targetId: folderId });
      await browser.pause(50);
      await browserUi('drag-over-tab', undefined, undefined, { targetId: folderId });
      await browser.waitUntil(async () => (await read()).dropTargets.some(item => item.id === folderId && item.className.includes('drop-inside')));
      captureLayoutScreenshot('tab-drop-folder-inside.png');
      await browserUi('drag-end');
      dragActive = false;
      await browser.waitUntil(async () => {
        const current = (await read()).tree.find(node => node.type === 'folder' && node.id === folderId);
        return current?.type === 'folder' && current.children.some(node => node.id === first.activeTabId);
      }, { timeoutMsg: 'Dragging a tab into a folder did not update the tab tree' });

      for (const tabId of [second.activeTabId, third.activeTabId]) {
        await browserUi('drag-start', tabId);
        dragActive = true;
        await browser.pause(50);
        await settleTabDragOver('drag-over-dock');
        await browser.waitUntil(async () => (await read()).preview?.includes('tab-drag-morph'));
        captureLayoutScreenshot('tab-drag-pin-dock.png');
        await browserUi('drag-end');
        dragActive = false;
        await browser.waitUntil(async () => (await read()).pinnedIds.includes(tabId));
      }
      assert.deepEqual((await read()).pinnedIds, [second.activeTabId, third.activeTabId]);

      await browserUi('drag-start', second.activeTabId);
      dragActive = true;
      await browser.pause(50);
      await settleTabDragOver('drag-over-tab', { targetId: third.activeTabId });
      await browserUi('drag-end');
      dragActive = false;
      await browser.waitUntil(async () => JSON.stringify((await read()).pinnedIds) === JSON.stringify([third.activeTabId, second.activeTabId]));

      await browserUi('drag-start', second.activeTabId);
      dragActive = true;
      await browser.pause(50);
      await settleTabDragOver('drag-over-tab', { targetId: first.activeTabId });
      await browserUi('drag-end');
      dragActive = false;
      await browser.waitUntil(async () => !(await read()).pinnedIds.includes(second.activeTabId));

      await browserUi('drag-start', third.activeTabId);
      dragActive = true;
      await browser.pause(50);
      await settleTabDragOver('drag-over-page', { dropPosition: 'left' });
      await browser.waitUntil(async () => (await read()).preview === null);
      await browser.waitUntil(async () => (await invoke('desktop_test_inspect_tab_drag_overlay') as { attached: boolean }).attached);
      await invoke('desktop_test_show_tab_drag_feedback');
      await browser.waitUntil(async () => {
        const overlay = await invoke('desktop_test_inspect_tab_drag_overlay') as { target: string | null; preview: string | null };
        return overlay.target === 'left' && overlay.preview === 'tab';
      });
      captureLayoutScreenshot('tab-drag-split-target.png');
      await settleTabDragOver('drag-over-tab', { targetId: third.activeTabId });
      await browserUi('drag-end');
      dragActive = false;

      await browserUi('drag-start', folderId);
      dragActive = true;
      await browser.pause(50);
      await settleTabDragOver('drag-over-page', { dropPosition: 'center' });
      await browser.waitUntil(async () => (await read()).preview?.includes('invalid'));
      await browser.waitUntil(async () => (await invoke('desktop_test_inspect_tab_drag_overlay') as { attached: boolean }).attached);
      await invoke('desktop_test_show_tab_drag_feedback');
      await browser.waitUntil(async () => (await invoke('desktop_test_inspect_tab_drag_overlay') as { preview: string | null }).preview === 'folder');
      captureLayoutScreenshot('tab-drag-folder-invalid.png');
      await browserUi('drag-cancel');
      dragActive = false;
      assert.ok((await read()).tree.some(node => node.type === 'folder' && node.id === folderId), 'a cancelled folder drag should leave the folder intact');
    } finally {
      if (dragActive) await browserUi('drag-cancel');
      await invoke('set_tab_dragging', { dragging: false, tabId: null, targetTabId: null, cancelled: true }).catch(() => undefined);
      for (const tabId of createdIds) {
        if ((await read()).pinnedIds.includes(tabId)) {
          await clickTabContextItem(tabId, 'Unpin').catch(() => undefined);
        }
      }
      if (folderId) {
        await browserUi('open-folder-context-menu', folderId).catch(() => undefined);
        await browserUi('click-context-item', undefined, 'Delete folder').catch(() => undefined);
      }
      await browserUi('set-tab-position', undefined, undefined, { tabPosition: originalPosition }).catch(() => undefined);
      for (const tabId of createdIds) {
        const current = await invoke('get_browser_state') as { tabs: Array<{ id: string }> };
        if (current.tabs.some(tab => tab.id === tabId)) await invoke('close_tab', { tabId }).catch(() => undefined);
      }
    }
  });
});
