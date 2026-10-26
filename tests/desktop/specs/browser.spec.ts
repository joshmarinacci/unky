import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { captureNativeWindow, inspect, invoke, results } from '../wdio.conf.js';

describe('native Tauri browser', () => {
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
