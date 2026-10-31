import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { captureNativeWindow, inspect, invoke, results } from '../wdio.conf.js';

async function browserUi(action: string, tabId?: string, menuItem?: string) {
  return invoke('desktop_test_browser_ui', { action, tabId, menuItem });
}

async function clickTabContextItem(tabId: string, menuItem: string) {
  await browserUi('open-context-menu', tabId);
  const initial = await browserUi('inspect') as { menuItems: string[]; tabRows: number; menus: number; hasTestContextMenuBridge: boolean };
  assert.ok(initial, 'The browser UI test inspector did not return a result');
  assert.equal(initial.hasTestContextMenuBridge, true, `The context menu test bridge is missing: ${JSON.stringify(initial)}`);
  await browser.waitUntil(async () => {
    const state = await browserUi('inspect') as { menuItems: string[] };
    return state.menuItems.includes(menuItem);
  }, { timeout: 3000, timeoutMsg: `The ${menuItem} context menu item did not appear (initial UI state: ${JSON.stringify(initial)})` });
  await browserUi('click-context-item', undefined, menuItem);
}

describe('native Tauri browser', () => {
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
    const savedHistory = JSON.parse(readFileSync(join(results, 'disposable-profile', 'history.json'), 'utf8'));
    assert.ok(!savedHistory.entries.some((entry: { url: string }) => entry.url === privateUrl || entry.url === `${base}&mode=private-read`));

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
    };
    assert.deepEqual(removedOverlay, { attached: false, visible: false, target: null });

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
    assert.equal(second.browser.tabs.length, 2);

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
    };
    assert.deepEqual(hiddenOriginalTargetOverlay, { attached: false, visible: false, target: null });

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
});
