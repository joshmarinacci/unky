import assert from 'node:assert/strict';
import { browserWindowLabels, closeBrowserWindows, inspect, invoke } from '../wdio.conf.js';

type Tab = { id: string; url: string; windowLabel: string };
type Snapshot = { tabs: Tab[]; activeTabId: string | null };

describe('window shortcuts', () => {
  before(async () => {
    await closeBrowserWindows();
  });

  it('⌘N opens a new browser window with one blank tab', async () => {
    const windowsBefore = await browserWindowLabels();
    const main = (await invoke('get_browser_state')) as Snapshot;
    assert.ok(main.activeTabId, 'the main window should have an active tab to inspect from');
    try {
      const label = (await invoke('new_browser_window')) as string;
      assert.match(label, /^browser-window-\d+$/);
      await browser.waitUntil(async () => (await browserWindowLabels()).includes(label), {
        timeout: 5000,
        timeoutMsg: 'New Window should open a native browser window',
      });
      const page = await inspect(main.activeTabId);
      const newTabs = (page.browser.tabs as Tab[]).filter((tab) => tab.windowLabel === label);
      assert.equal(newTabs.length, 1, 'the new window should start with exactly one tab');
      assert.equal(newTabs[0].url, '', 'the new window tab should be blank');
      assert.deepEqual(
        ((await invoke('get_browser_state')) as Snapshot).tabs.map((tab) => tab.id),
        main.tabs.map((tab) => tab.id),
        'opening a window should leave the main window tabs alone',
      );
    } finally {
      await closeBrowserWindows(windowsBefore);
    }
  });
});
