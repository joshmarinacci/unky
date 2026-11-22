import assert from 'node:assert/strict';
import { browserWindowLabels, closeBrowserWindows, closeTabs, inspect, invoke } from '../wdio.conf.js';

type Tab = { id: string; url: string; windowLabel: string };
type Snapshot = { tabs: Tab[]; activeTabId: string | null };
type SourcePage = {
  address: string | null;
  open: boolean;
  notes: string[];
  lineCount: number;
  text: string | null;
  saved: Record<string, string>;
};

const browserUi = (action: string, menuItem?: string) => invoke('desktop_test_browser_ui', { action, menuItem });
const sourcePage = () => browserUi('inspect-source-page') as Promise<SourcePage>;

/** Open a tab on `url`, wait for it to load, then press ⌥⌘U and wait for the source tab. */
async function viewSourceOf(url: string) {
  const created = (await invoke('create_tab')) as Snapshot;
  const pageTabId = created.activeTabId!;
  await invoke('navigate', { tabId: pageTabId, url });
  await browser.waitUntil(
    async () => {
      const page = await inspect(pageTabId);
      return page.url === url && page.readyState === 'complete';
    },
    { timeout: 10000, timeoutMsg: `${url} did not load` },
  );
  await browserUi('run-shortcut', 'view-source');
  await browser.waitUntil(async () => (await sourcePage()).lineCount > 0, {
    timeout: 10000,
    timeoutMsg: 'View Source did not show the page source',
  });
  const state = (await invoke('get_browser_state')) as Snapshot;
  return { pageTabId, sourceTabId: state.activeTabId, page: await sourcePage() };
}

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

  it('⌥⌘U shows the downloaded HTML in a new tab with a view-source: address', async () => {
    const tabsBefore = ((await invoke('get_browser_state')) as Snapshot).tabs.map((tab) => tab.id);
    try {
      const url = 'http://127.0.0.1:4179/two';
      const { pageTabId, sourceTabId, page } = await viewSourceOf(url);
      assert.notEqual(sourceTabId, pageTabId, 'the source should open in its own tab');
      assert.equal(page.address, `view-source:${url}`);
      assert.deepEqual(page.notes, [], 'a downloaded original needs no fallback note');
      assert.match(page.text ?? '', /<title>Desktop fixture · Two<\/title>/);
    } finally {
      await closeTabs(tabsBefore);
    }
  });

  it('saves source tab addresses so a restart can download them again', async () => {
    const tabsBefore = ((await invoke('get_browser_state')) as Snapshot).tabs.map((tab) => tab.id);
    try {
      const url = 'http://127.0.0.1:4179/two';
      const { sourceTabId, page } = await viewSourceOf(url);
      assert.equal(page.saved[sourceTabId], url, 'the source tab address should be saved, without its HTML');
      // What the UI calls on the next launch for each saved source tab.
      const restored = (await invoke('restore_page_source', { url })) as { source: string; original: boolean };
      assert.equal(restored.original, true);
      assert.match(restored.source, /<title>Desktop fixture · Two<\/title>/);
      await assert.rejects(invoke('restore_page_source', { url: 'file:///etc/hosts' }), /Only web pages/);
      await invoke('close_tab', { tabId: sourceTabId });
      await browser.waitUntil(async () => !(sourceTabId in (await sourcePage()).saved), {
        timeoutMsg: 'a closed source tab should be forgotten',
      });
    } finally {
      await closeTabs(tabsBefore);
    }
  });

  it('falls back to the live DOM when the page cannot be downloaded again', async () => {
    const tabsBefore = ((await invoke('get_browser_state')) as Snapshot).tabs.map((tab) => tab.id);
    try {
      const { page } = await viewSourceOf('http://127.0.0.1:4179/browser-only');
      assert.match(page.notes.join(' '), /could not be downloaded/);
      // The live DOM includes the attribute the page's script added after loading.
      assert.match(page.text ?? '', /data-changed="by-script"/);
    } finally {
      await closeTabs(tabsBefore);
    }
  });
});
