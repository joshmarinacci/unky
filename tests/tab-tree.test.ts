import { expect, test } from 'vitest';
import { appendToFolder, containsNode, findNode, folderIds, removeNode, updateNode } from '../src/tree.ts';
import {
  appendTabNodeToFolder,
  expandedTabFolderIds,
  flattenTabIds,
  insertTabNode,
  normalizeTabNodes,
  reconcileTabNodes,
  tabFolders,
  unwrapTabFolder,
  type TabNode,
} from '../src/tabTree.ts';
import { filterBookmarkNodes, findBookmarkByUrl, normalizeBookmarkNodes, type BookmarkNode } from '../src/bookmarks.ts';

const tabs: TabNode[] = [
  { id: 'tab-1', type: 'tab' },
  {
    id: 'work',
    type: 'folder',
    title: 'Work',
    collapsed: true,
    children: [
      { id: 'tab-2', type: 'tab' },
      { id: 'inner', type: 'folder', title: 'Inner', collapsed: false, children: [{ id: 'tab-3', type: 'tab' }] },
    ],
  },
  { id: 'tab-4', type: 'tab' },
];

test('generic tree operations find, update, remove, and contain nested nodes', () => {
  expect(findNode(tabs, 'tab-3')?.id).toBe('tab-3');
  expect(findNode(tabs, 'missing')).toBe(undefined);
  expect(folderIds(tabs)).toStrictEqual(['work', 'inner']);

  const renamed = updateNode(tabs, 'inner', (node) => (node.type === 'folder' ? { ...node, title: 'Renamed' } : node));
  expect((findNode(renamed, 'inner') as Extract<TabNode, { type: 'folder' }>).title).toBe('Renamed');
  expect((findNode(tabs, 'inner') as Extract<TabNode, { type: 'folder' }>).title, 'input is not mutated').toBe('Inner');

  const removed = removeNode(tabs, 'tab-2');
  expect(removed.removed?.id).toBe('tab-2');
  expect(flattenTabIds(removed.nodes)).toStrictEqual(['tab-1', 'tab-3', 'tab-4']);

  expect(containsNode(tabs[1], 'tab-3')).toBeTruthy();
  expect(!containsNode(tabs[1], 'tab-4')).toBeTruthy();
});

test('appendToFolder adds to the end of a nested folder and reports misses', () => {
  const appended = appendToFolder(tabs, 'inner', { id: 'tab-9', type: 'tab' });
  expect(appended.inserted).toBeTruthy();
  expect(flattenTabIds(appended.nodes)).toStrictEqual(['tab-1', 'tab-2', 'tab-3', 'tab-9', 'tab-4']);
  expect(appendToFolder(tabs, 'missing', { id: 'tab-9', type: 'tab' })).toStrictEqual({ nodes: tabs, inserted: false });
});

test('appending a tab to a collapsed folder expands it', () => {
  const { nodes, inserted } = appendTabNodeToFolder(tabs, 'work', { id: 'tab-9', type: 'tab' });
  expect(inserted).toBeTruthy();
  expect(expandedTabFolderIds(nodes)).toStrictEqual(['work', 'inner']);
  expect(expandedTabFolderIds(tabs)).toStrictEqual(['inner']);
});

test('normalizeTabNodes keeps valid tabs and folders and fills missing folder IDs', () => {
  const nodes = normalizeTabNodes([
    { id: 'tab-1', type: 'tab' },
    { type: 'folder', title: 'No id', children: [{ id: 'tab-2', type: 'tab' }, { type: 'tab' }] },
    { type: 'bookmark', url: 'https://example.com' },
    null,
  ]);
  expect(nodes.length).toBe(2);
  expect(nodes[1].type).toBe('folder');
  expect(typeof nodes[1].id).toBe('string');
  expect(flattenTabIds(nodes)).toStrictEqual(['tab-1', 'tab-2']);
  expect(normalizeTabNodes('not an array')).toStrictEqual([]);
});

test('reconcileTabNodes drops closed and duplicate tabs and appends unlisted open tabs', () => {
  const stale: TabNode[] = [...tabs, { id: 'tab-1', type: 'tab' }, { id: 'closed', type: 'tab' }];
  const reconciled = reconcileTabNodes(stale, [{ id: 'tab-1' }, { id: 'tab-3' }, { id: 'tab-4' }, { id: 'tab-new' }]);
  expect(flattenTabIds(reconciled)).toStrictEqual(['tab-1', 'tab-3', 'tab-4', 'tab-new']);
  expect(tabFolders(reconciled).map((folder) => folder.id)).toStrictEqual(['work', 'inner']);
});

test('insertTabNode places a tab before or after a nested target', () => {
  const after = insertTabNode(tabs, 'tab-2', { id: 'tab-9', type: 'tab' }, true);
  expect(after.inserted).toBeTruthy();
  expect(flattenTabIds(after.nodes)).toStrictEqual(['tab-1', 'tab-2', 'tab-9', 'tab-3', 'tab-4']);
  const before = insertTabNode(tabs, 'tab-4', { id: 'tab-9', type: 'tab' }, false);
  expect(flattenTabIds(before.nodes)).toStrictEqual(['tab-1', 'tab-2', 'tab-3', 'tab-9', 'tab-4']);
  expect(insertTabNode(tabs, 'missing', { id: 'tab-9', type: 'tab' }, true).inserted).toBe(false);
});

test('unwrapTabFolder replaces a nested folder with its children in place', () => {
  const { nodes, unwrapped } = unwrapTabFolder(tabs, 'inner');
  expect(unwrapped).toBeTruthy();
  expect(flattenTabIds(nodes)).toStrictEqual(['tab-1', 'tab-2', 'tab-3', 'tab-4']);
  expect(folderIds(nodes)).toStrictEqual(['work']);
  expect(unwrapTabFolder(tabs, 'tab-1').unwrapped).toBe(false);
});

test('bookmark helpers normalize, find by URL, and filter with folder context', () => {
  const bookmarks: BookmarkNode[] = normalizeBookmarkNodes([
    { id: 'b1', title: 'Example', url: 'https://example.com' },
    {
      id: 'f1',
      type: 'folder',
      title: 'Docs',
      children: [{ id: 'b2', title: 'Rust', url: 'https://rust-lang.org', description: 'systems' }],
    },
    { title: 42 },
  ]);
  expect(bookmarks.length).toBe(2);
  expect(findBookmarkByUrl(bookmarks, 'https://rust-lang.org')?.id).toBe('b2');
  expect(findBookmarkByUrl(bookmarks, 'https://missing.test')).toBe(undefined);
  const filtered = filterBookmarkNodes(bookmarks, 'systems');
  expect(filtered.length).toBe(1);
  expect(filtered[0].id).toBe('f1');
  expect(filterBookmarkNodes(bookmarks, '')).toBe(bookmarks);
});
