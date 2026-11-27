import assert from 'node:assert/strict';
import { captureNativeWindow, closeTabs, inspect, invoke } from '../wdio.conf.js';

type Tab = { id: string; url: string; private?: boolean };
type Snapshot = { tabs: Tab[]; activeTabId: string };
type Bookmark = { type: 'bookmark'; title: string; url: string };
type Folder = { type: 'folder'; title: string; children: Node[] };
type Node = Bookmark | Folder;

const folderId = 'desktop-test-folder';
const folderTitle = 'Desktop Test Folder';
const page = (name: string) => `http://127.0.0.1:4179/two?bookmark=${name}`;

const browserUi = (action: string, tabId?: string, menuItem?: string) =>
  invoke('desktop_test_browser_ui', { action, tabId, menuItem });
const state = () => invoke('get_browser_state') as Promise<Snapshot>;
const bookmarks = () => invoke('load_bookmarks', { legacyBookmarks: [] }) as Promise<Node[]>;
const urls = (nodes: Node[]): string[] =>
  nodes.flatMap((node) => (node.type === 'bookmark' ? [node.url] : urls(node.children)));

async function openTab(url: string, options: { private?: boolean } = {}) {
  const id = ((await invoke('create_tab', options)) as Snapshot).activeTabId;
  await invoke('navigate', { tabId: id, url });
  await browser.waitUntil(
    async () => {
      const loaded = await inspect(id);
      return loaded.url === url && loaded.readyState === 'complete';
    },
    { timeout: 15000, timeoutMsg: `${url} did not load` },
  );
  return id;
}

async function chooseTabMenuItem(tabId: string, label: string, folder = false) {
  const opened = (await browserUi(folder ? 'open-folder-context-menu' : 'open-context-menu', tabId)) as {
    error?: string;
  };
  assert.equal(opened.error, undefined, opened.error);
  await browser.waitUntil(
    async () => ((await browserUi('inspect-tab-menu')) as { entries: unknown[] | null }).entries !== null,
    {
      timeout: 3000,
      timeoutMsg: `The menu for ${tabId} did not open: ${JSON.stringify(await browserUi('inspect-tab-menu'))}`,
    },
  );
  const result = (await browserUi('click-context-item', undefined, label)) as { error?: string };
  assert.equal(result.error, undefined, result.error);
}

describe('saving tabs as bookmarks', () => {
  let tabsBefore: string[] = [];
  const tabs: Record<string, string> = {};

  before(async () => {
    tabsBefore = (await state()).tabs.map((tab) => tab.id);
    await browserUi('reset-tab-ui');
    // Seeding replaces the tab tree; the tabs opened next are added back to it.
    await browserUi('seed-tab-folders');
    tabs.solo = await openTab(page('solo'));
    tabs.first = await openTab(page('first'));
    tabs.second = await openTab(page('second'));
    await chooseTabMenuItem(tabs.first, folderTitle);
    await chooseTabMenuItem(tabs.second, folderTitle);
  });

  after(async () => {
    await browserUi('restore-confirm');
    await closeTabs(tabsBefore);
    await browserUi('reset-tab-ui');
  });

  it('Bookmark Tab saves one tab and keeps it open', async () => {
    await chooseTabMenuItem(tabs.solo, 'Bookmark Tab');
    await browser.waitUntil(
      async () => (await bookmarks()).some((node) => 'url' in node && node.url === page('solo')),
      {
        timeout: 5000,
        timeoutMsg: 'Bookmark Tab did not save a top-level bookmark',
      },
    );
    assert.ok(
      (await state()).tabs.some((tab) => tab.id === tabs.solo),
      'the tab should stay open',
    );

    await chooseTabMenuItem(tabs.solo, 'Bookmark Tab');
    await browser.pause(300);
    assert.equal(
      urls(await bookmarks()).filter((url) => url === page('solo')).length,
      1,
      'bookmarking the same page again should not add a duplicate',
    );
  });

  it('Bookmark Folder saves a tab folder as a bookmark folder and keeps its tabs open', async () => {
    await chooseTabMenuItem(folderId, 'Bookmark Folder', true);
    let saved: Folder | undefined;
    await browser.waitUntil(
      async () => {
        saved = (await bookmarks()).find(
          (node): node is Folder => node.type === 'folder' && node.title === folderTitle,
        );
        return Boolean(saved);
      },
      { timeout: 5000, timeoutMsg: 'Bookmark Folder did not save a bookmark folder' },
    );
    assert.deepEqual(urls(saved!.children), [page('first'), page('second')]);
    const open = (await state()).tabs.map((tab) => tab.id);
    assert.ok(open.includes(tabs.first) && open.includes(tabs.second), 'the folder tabs should stay open');
  });

  it('Tab Bankruptcy asks, then saves and closes every tab except pinned and private ones', async () => {
    tabs.private = await openTab(page('private'), { private: true });
    await chooseTabMenuItem('tab-1', 'Pin');
    const pinnedUrl = (await state()).tabs.find((tab) => tab.id === 'tab-1')?.url;

    await browserUi('answer-confirm', undefined, 'decline');
    await browserUi('run-shortcut', undefined, 'tab-bankruptcy');
    await browser.pause(500);
    const declined = (await browserUi('restore-confirm')) as { questions: string[] };
    assert.equal(declined.questions.length, 1, 'Tab Bankruptcy should ask first');
    assert.match(declined.questions[0], /Pinned and private tabs stay open/);
    assert.ok(
      (await state()).tabs.some((tab) => tab.id === tabs.solo),
      'declining should close nothing',
    );

    const foldersBefore = (await bookmarks()).filter((node) => node.title.startsWith('Tab Bankruptcy')).length;
    assert.equal(foldersBefore, 0, 'declining should save nothing');
    await browserUi('answer-confirm', undefined, 'accept');
    await browserUi('run-shortcut', undefined, 'tab-bankruptcy');
    await browser.waitUntil(
      async () => {
        const ids = (await state()).tabs.map((tab) => tab.id).sort();
        return JSON.stringify(ids) === JSON.stringify(['tab-1', tabs.private].sort());
      },
      { timeout: 10000, timeoutMsg: `Tab Bankruptcy did not close the other tabs: ${JSON.stringify(await state())}` },
    );

    let saved: Folder | undefined;
    await browser.waitUntil(
      async () => {
        saved = (await bookmarks()).find(
          (node): node is Folder => node.type === 'folder' && node.title.startsWith('Tab Bankruptcy'),
        );
        return Boolean(saved);
      },
      { timeout: 5000, timeoutMsg: 'Tab Bankruptcy did not save a bookmark folder' },
    );
    const savedUrls = urls(saved!.children);
    assert.ok(savedUrls.includes(page('solo')), JSON.stringify(saved));
    const nested = saved!.children.find((node): node is Folder => node.type === 'folder' && node.title === folderTitle);
    assert.deepEqual(nested && urls(nested.children), [page('first'), page('second')], 'tab folders become subfolders');
    assert.ok(!savedUrls.includes(page('private')), 'private tabs are not saved');
    assert.ok(!pinnedUrl || !savedUrls.includes(pinnedUrl), 'pinned tabs are not saved');
    await browserUi('choose-bookmarks-menu-show-all');
    await browser.pause(300);
    captureNativeWindow('tab-bankruptcy.png');
    // after() resets the tab UI, which also unpins tab-1.
  });
});
