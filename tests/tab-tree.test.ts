import assert from 'node:assert/strict';
import test from 'node:test';
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
  assert.equal(findNode(tabs, 'tab-3')?.id, 'tab-3');
  assert.equal(findNode(tabs, 'missing'), undefined);
  assert.deepEqual(folderIds(tabs), ['work', 'inner']);

  const renamed = updateNode(tabs, 'inner', (node) => (node.type === 'folder' ? { ...node, title: 'Renamed' } : node));
  assert.equal((findNode(renamed, 'inner') as Extract<TabNode, { type: 'folder' }>).title, 'Renamed');
  assert.equal(
    (findNode(tabs, 'inner') as Extract<TabNode, { type: 'folder' }>).title,
    'Inner',
    'input is not mutated',
  );

  const removed = removeNode(tabs, 'tab-2');
  assert.equal(removed.removed?.id, 'tab-2');
  assert.deepEqual(flattenTabIds(removed.nodes), ['tab-1', 'tab-3', 'tab-4']);

  assert.ok(containsNode(tabs[1], 'tab-3'));
  assert.ok(!containsNode(tabs[1], 'tab-4'));
});

test('appendToFolder adds to the end of a nested folder and reports misses', () => {
  const appended = appendToFolder(tabs, 'inner', { id: 'tab-9', type: 'tab' });
  assert.ok(appended.inserted);
  assert.deepEqual(flattenTabIds(appended.nodes), ['tab-1', 'tab-2', 'tab-3', 'tab-9', 'tab-4']);
  assert.deepEqual(appendToFolder(tabs, 'missing', { id: 'tab-9', type: 'tab' }), { nodes: tabs, inserted: false });
});

test('appending a tab to a collapsed folder expands it', () => {
  const { nodes, inserted } = appendTabNodeToFolder(tabs, 'work', { id: 'tab-9', type: 'tab' });
  assert.ok(inserted);
  assert.deepEqual(expandedTabFolderIds(nodes), ['work', 'inner']);
  assert.deepEqual(expandedTabFolderIds(tabs), ['inner']);
});

test('normalizeTabNodes keeps valid tabs and folders and fills missing folder IDs', () => {
  const nodes = normalizeTabNodes([
    { id: 'tab-1', type: 'tab' },
    { type: 'folder', title: 'No id', children: [{ id: 'tab-2', type: 'tab' }, { type: 'tab' }] },
    { type: 'bookmark', url: 'https://example.com' },
    null,
  ]);
  assert.equal(nodes.length, 2);
  assert.equal(nodes[1].type, 'folder');
  assert.equal(typeof nodes[1].id, 'string');
  assert.deepEqual(flattenTabIds(nodes), ['tab-1', 'tab-2']);
  assert.deepEqual(normalizeTabNodes('not an array'), []);
});

test('reconcileTabNodes drops closed and duplicate tabs and appends unlisted open tabs', () => {
  const stale: TabNode[] = [...tabs, { id: 'tab-1', type: 'tab' }, { id: 'closed', type: 'tab' }];
  const reconciled = reconcileTabNodes(stale, [{ id: 'tab-1' }, { id: 'tab-3' }, { id: 'tab-4' }, { id: 'tab-new' }]);
  assert.deepEqual(flattenTabIds(reconciled), ['tab-1', 'tab-3', 'tab-4', 'tab-new']);
  assert.deepEqual(
    tabFolders(reconciled).map((folder) => folder.id),
    ['work', 'inner'],
  );
});

test('insertTabNode places a tab before or after a nested target', () => {
  const after = insertTabNode(tabs, 'tab-2', { id: 'tab-9', type: 'tab' }, true);
  assert.ok(after.inserted);
  assert.deepEqual(flattenTabIds(after.nodes), ['tab-1', 'tab-2', 'tab-9', 'tab-3', 'tab-4']);
  const before = insertTabNode(tabs, 'tab-4', { id: 'tab-9', type: 'tab' }, false);
  assert.deepEqual(flattenTabIds(before.nodes), ['tab-1', 'tab-2', 'tab-3', 'tab-9', 'tab-4']);
  assert.equal(insertTabNode(tabs, 'missing', { id: 'tab-9', type: 'tab' }, true).inserted, false);
});

test('unwrapTabFolder replaces a nested folder with its children in place', () => {
  const { nodes, unwrapped } = unwrapTabFolder(tabs, 'inner');
  assert.ok(unwrapped);
  assert.deepEqual(flattenTabIds(nodes), ['tab-1', 'tab-2', 'tab-3', 'tab-4']);
  assert.deepEqual(folderIds(nodes), ['work']);
  assert.equal(unwrapTabFolder(tabs, 'tab-1').unwrapped, false);
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
  assert.equal(bookmarks.length, 2);
  assert.equal(findBookmarkByUrl(bookmarks, 'https://rust-lang.org')?.id, 'b2');
  assert.equal(findBookmarkByUrl(bookmarks, 'https://missing.test'), undefined);
  const filtered = filterBookmarkNodes(bookmarks, 'systems');
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].id, 'f1');
  assert.equal(filterBookmarkNodes(bookmarks, ''), bookmarks);
});
