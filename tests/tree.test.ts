import { expect, test } from 'vitest';
import { groupSplitTabRows } from '../src/splitTabRows.ts';
import { flattenTree } from '../src/tree.ts';
import { externalBrowserMenuItems, selectInputText } from '../src/tabUiActions.ts';

test('tab and folder rename focus selects the existing input text', () => {
  let selected = false;
  selectInputText({
    select: () => {
      selected = true;
    },
  });
  expect(selected).toBe(true);
});

test('external browser submenu lists each browser and targets the external-open command', () => {
  expect(
    externalBrowserMenuItems([
      { id: 'firefox', name: 'Firefox' },
      { id: 'safari', name: 'Safari' },
    ]),
  ).toStrictEqual([
    { id: 'firefox', label: 'Firefox', command: 'open_in_external_browser' },
    { id: 'safari', label: 'Safari', command: 'open_in_external_browser' },
  ]);
  expect(externalBrowserMenuItems([])).toStrictEqual([]);
});

test('split rows use pane order once and restore the original rows when unsplit', () => {
  const rows = ['a', 'middle', 'b'].map((id) => ({ node: { id, type: 'tab' }, depth: 0, parentId: null }));
  const grouped = groupSplitTabRows(rows, rows, { firstTabId: 'b', secondTabId: 'a' });
  expect(grouped.length).toBe(2);
  expect(grouped[0].type).toBe('split');
  if (grouped[0].type === 'split') {
    expect(grouped[0].first.node.id).toBe('b');
    expect(grouped[0].second.node.id).toBe('a');
  }
  expect(groupSplitTabRows(rows, rows, null).map((row) => row.type === 'single' && row.row.node.id)).toStrictEqual([
    'a',
    'middle',
    'b',
  ]);
  expect(
    groupSplitTabRows(rows.slice(0, 2), rows.slice(0, 2), { firstTabId: 'a', secondTabId: 'b' }).every(
      (row) => row.type === 'single',
    ),
  ).toBeTruthy();
});

test('split pairs span collapsed folders without mutating folder membership', () => {
  const all = flattenTree(tree, new Set(['work', 'archive']));
  const visible = flattenTree(tree, new Set(['work']));
  const saved = JSON.stringify(tree);
  const grouped = groupSplitTabRows(visible, all, { firstTabId: 'draft', secondTabId: 'old' });
  const pair = grouped.find((row) => row.type === 'split');
  // node:assert's ok() narrowed the type; Vitest's expect does not.
  if (pair?.type !== 'split') throw new Error('expected a split row');
  expect(pair.depth).toBe(1);
  expect(pair.second.parentId).toBe('archive');
  expect(JSON.stringify(tree)).toBe(saved);
  const collapsed = flattenTree(tree, new Set());
  expect(
    groupSplitTabRows(collapsed, all, { firstTabId: 'draft', secondTabId: 'old' }).every(
      (row) => row.type === 'single',
    ),
  ).toBeTruthy();
});
import { moveNodeToDepth, moveNodeToDropZone, resolveDropDepth, resolveDropZone } from '../src/tree.ts';
import type { BookmarkNode } from '../src/bookmarks.ts';
import { isTabPosition, reorderTabIds, tabAxisForPosition, resolveTabDragPreview } from '../src/tabLayout.ts';

const tree: BookmarkNode[] = [
  {
    id: 'work',
    type: 'folder',
    title: 'Work',
    children: [
      { id: 'draft', type: 'bookmark', title: 'Draft', url: 'https://example.com/draft' },
      { id: 'reference', type: 'bookmark', title: 'Reference', url: 'https://example.com/reference' },
    ],
  },
  { id: 'middle', type: 'bookmark', title: 'Middle', url: 'https://example.com/middle' },
  { id: 'last', type: 'bookmark', title: 'Last', url: 'https://example.com/last' },
  {
    id: 'archive',
    type: 'folder',
    title: 'Archive',
    children: [{ id: 'old', type: 'bookmark', title: 'Old', url: 'https://example.com/old' }],
  },
];

function ids(nodes: BookmarkNode[]): string[] {
  return nodes.flatMap((node) => [node.id, ...(node.type === 'folder' ? ids(node.children) : [])]);
}

test('moves a bottom-level bookmark to the top of the root list', () => {
  const depth = resolveDropDepth(0, 0, 0);
  const result = moveNodeToDepth(tree, 'last', 'work', depth, false);
  expect(result.nodes.map((node) => node.id)).toStrictEqual(['last', 'work', 'middle', 'archive']);
  expect(result.parentId).toBe(null);
});

test('moves a nested bookmark to the root when dropped over a shallower row without horizontal movement', () => {
  const depth = resolveDropDepth(1, 0, 0);
  const result = moveNodeToDepth(tree, 'draft', 'middle', depth, false);
  expect(result.nodes.map((node) => node.id)).toStrictEqual(['work', 'draft', 'middle', 'last', 'archive']);
  expect((result.nodes[0] as Extract<BookmarkNode, { type: 'folder' }>).children.map((node) => node.id)).toStrictEqual([
    'reference',
  ]);
});

test('reorders a bookmark to just after the hovered sibling', () => {
  const result = moveNodeToDepth(tree, 'middle', 'last', 0, true);
  expect(result.nodes.map((node) => node.id)).toStrictEqual(['work', 'last', 'middle', 'archive']);
});

test('nests a bookmark into a folder when horizontal movement requests its child depth', () => {
  const depth = resolveDropDepth(0, 0, 14);
  const result = moveNodeToDepth(tree, 'middle', 'work', depth, false);
  const work = result.nodes[0] as Extract<BookmarkNode, { type: 'folder' }>;
  expect(result.parentId).toBe('work');
  expect(work.children.map((node) => node.id)).toStrictEqual(['draft', 'reference', 'middle']);
});

test('moves an item between folders before the hovered child', () => {
  const result = moveNodeToDepth(tree, 'draft', 'old', 1, false);
  const archive = result.nodes.find((node) => node.id === 'archive') as Extract<BookmarkNode, { type: 'folder' }>;
  expect(result.parentId).toBe('archive');
  expect(archive.children.map((node) => node.id)).toStrictEqual(['draft', 'old']);
  expect(ids(result.nodes)).toStrictEqual(['work', 'reference', 'middle', 'last', 'archive', 'draft', 'old']);
});

test('rejects moving a folder into one of its descendants', () => {
  const result = moveNodeToDepth(tree, 'work', 'draft', 1, false);
  expect(result.nodes).toStrictEqual(tree);
});

test('uses the hovered shallower row depth unless the pointer is deliberately indented', () => {
  expect(resolveDropDepth(2, 0, 0)).toBe(0);
  expect(resolveDropDepth(2, 0, -14)).toBe(0);
  expect(resolveDropDepth(0, 0, 14)).toBe(1);
  expect(resolveDropDepth(0, 1, 0)).toBe(0);
});

test('classifies drop zones: folders have a middle nesting band, links split in half', () => {
  expect(resolveDropZone(105, 100, 40, true)).toBe('before');
  expect(resolveDropZone(120, 100, 40, true)).toBe('inside');
  expect(resolveDropZone(135, 100, 40, true)).toBe('after');
  expect(resolveDropZone(110, 100, 40, false)).toBe('before');
  expect(resolveDropZone(130, 100, 40, false)).toBe('after');
});

test('tab positions select a horizontal or vertical strip', () => {
  expect(isTabPosition('left')).toBe(true);
  expect(isTabPosition('right')).toBe(true);
  expect(isTabPosition('top')).toBe(true);
  expect(isTabPosition('bottom')).toBe(true);
  expect(isTabPosition('center')).toBe(false);
  expect(tabAxisForPosition('left')).toBe('vertical');
  expect(tabAxisForPosition('right')).toBe('vertical');
  expect(tabAxisForPosition('top')).toBe('horizontal');
  expect(tabAxisForPosition('bottom')).toBe('horizontal');
});

test('pinned tabs reorder before, after, or at the end of the dock', () => {
  expect(reorderTabIds(['a', 'b', 'c'], 'c', 'a', false)).toStrictEqual(['c', 'a', 'b']);
  expect(reorderTabIds(['a', 'b', 'c'], 'a', 'b', true)).toStrictEqual(['b', 'a', 'c']);
  expect(reorderTabIds(['a', 'b'], 'a', null, false)).toStrictEqual(['b', 'a']);
  expect(reorderTabIds(['a', 'b'], 'a', 'missing', false)).toStrictEqual(['a', 'b']);
});

test('page drag feedback routes tabs to split targeting and marks folders invalid', () => {
  expect(resolveTabDragPreview(false, true)).toBe('split');
  expect(resolveTabDragPreview(true, true)).toBe('invalid');
  expect(resolveTabDragPreview(false, false)).toBe(null);
});

test('dropping inside a folder appends to it without any horizontal movement', () => {
  const nodes: BookmarkNode[] = [
    { id: 'a', type: 'bookmark', title: 'A', url: 'https://a' },
    { id: 'f', type: 'folder', title: 'F', children: [{ id: 'c', type: 'bookmark', title: 'C', url: 'https://c' }] },
  ];
  const result = moveNodeToDropZone(nodes, 'a', 'f', 'inside', 0, 0);
  expect(result.parentId).toBe('f');
  expect(result.nodes.map((n) => n.id)).toStrictEqual(['f']);
  const folder = result.nodes[0];
  expect(folder.type === 'folder' && folder.children.map((n) => n.id).join()).toBe('c,a');
});

test('dropping before/after a row places the item as its sibling', () => {
  const nodes: BookmarkNode[] = [
    { id: 'a', type: 'bookmark', title: 'A', url: 'https://a' },
    { id: 'b', type: 'bookmark', title: 'B', url: 'https://b' },
    { id: 'c', type: 'bookmark', title: 'C', url: 'https://c' },
  ];
  expect(moveNodeToDropZone(nodes, 'a', 'c', 'after', 0, 0).nodes.map((n) => n.id)).toStrictEqual(['b', 'c', 'a']);
  expect(moveNodeToDropZone(nodes, 'c', 'a', 'before', 0, 0).nodes.map((n) => n.id)).toStrictEqual(['c', 'a', 'b']);
});

test('dropping onto an unknown row fails loudly', () => {
  expect(() => moveNodeToDropZone([], 'a', 'missing', 'after', 0, 0)).toThrow(/missing/);
});

test('the tree helpers also move tab nodes between folders', () => {
  type TabNode = { id: string; type: 'tab' } | { id: string; type: 'folder'; collapsed: boolean; children: TabNode[] };
  const nodes: TabNode[] = [
    { id: 't1', type: 'tab' },
    { id: 'f', type: 'folder', collapsed: true, children: [{ id: 't2', type: 'tab' }] },
    { id: 't3', type: 'tab' },
  ];
  const nested = moveNodeToDropZone(nodes, 't3', 'f', 'inside', 0, 0);
  expect(nested.parentId).toBe('f');
  const folder = nested.nodes[1];
  expect(folder.type === 'folder' && folder.collapsed, 'extra folder fields are preserved').toBe(true);
  expect(folder.type === 'folder' && folder.children.map((n) => n.id).join()).toBe('t2,t3');
  const reordered = moveNodeToDropZone(nodes, 't3', 't1', 'before', 0, 0);
  expect(reordered.nodes.map((n) => n.id)).toStrictEqual(['t3', 't1', 'f']);
});
