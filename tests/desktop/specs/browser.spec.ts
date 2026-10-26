import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { captureNativeWindow, inspect, invoke, results } from '../wdio.conf.js';

describe('native Tauri browser', () => {
  it('isolates private website storage and excludes private tabs from saved browsing state', async () => {
    type Snapshot = { tabs: Array<{ id: string; private: boolean }>; activeTabId: string };
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

    const switched = await invoke('select_tab', { tabId: 'tab-1' }) as { tabs: Array<{ id: string; active: boolean }> };
    assert.equal(switched.tabs.find((tab) => tab.id === 'tab-1')?.active, true);
    assert.equal(switched.tabs.find((tab) => tab.id === secondTab.id)?.active, false);
    const afterSwitch = await inspect();
    assert.equal(afterSwitch.tabId, 'tab-1');
    assert.match(afterSwitch.text, /Fixture Page One/);

    await invoke('split_tab', { tabId: secondTab.id, side: 'right' });
    const splitTabs = await invoke('get_split_tabs') as { firstTabId: string; secondTabId: string; orientation: string } | null;
    assert.deepEqual(splitTabs, {
      firstTabId: 'tab-1',
      secondTabId: secondTab.id,
      orientation: 'horizontal',
    }, 'right split should place the active page before the dragged page');
    captureNativeWindow('split-view.png');

    await invoke('split_tab', { tabId: secondTab.id, side: 'bottom' });
    const verticalSplit = await invoke('get_split_tabs') as { firstTabId: string; secondTabId: string; orientation: string } | null;
    assert.deepEqual(verticalSplit, {
      firstTabId: 'tab-1',
      secondTabId: secondTab.id,
      orientation: 'vertical',
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
});
