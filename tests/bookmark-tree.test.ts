import assert from 'node:assert/strict';
import test from 'node:test';
import { groupSplitTabRows } from '../src/splitTabRows.ts';
import { flattenBookmarkNodes } from '../src/bookmarkTree.ts';
import { externalBrowserMenuItems, selectInputText } from '../src/tabUiActions.ts';

test('tab and folder rename focus selects the existing input text', () => {
  let selected = false;
  selectInputText({ select: () => { selected = true; } });
  assert.equal(selected, true);
});

test('external browser submenu lists each browser and targets the external-open command', () => {
  assert.deepEqual(externalBrowserMenuItems([
    { id: 'firefox', name: 'Firefox' },
    { id: 'safari', name: 'Safari' },
  ]), [
    { id: 'firefox', label: 'Firefox', command: 'open_in_external_browser' },
    { id: 'safari', label: 'Safari', command: 'open_in_external_browser' },
  ]);
  assert.deepEqual(externalBrowserMenuItems([]), []);
});

test('split rows use pane order once and restore the original rows when unsplit', () => {
  const rows = ['a', 'middle', 'b'].map(id => ({ node: { id, type: 'tab' }, depth: 0, parentId: null }));
  const grouped = groupSplitTabRows(rows, rows, { firstTabId: 'b', secondTabId: 'a' });
  assert.equal(grouped.length, 2);
  assert.equal(grouped[0].type, 'split');
  if (grouped[0].type === 'split') {
    assert.equal(grouped[0].first.node.id, 'b');
    assert.equal(grouped[0].second.node.id, 'a');
  }
  assert.deepEqual(groupSplitTabRows(rows, rows, null).map(row => row.type === 'single' && row.row.node.id), ['a', 'middle', 'b']);
  assert.ok(groupSplitTabRows(rows.slice(0, 2), rows.slice(0, 2), { firstTabId: 'a', secondTabId: 'b' }).every(row => row.type === 'single'));
});

test('split pairs span collapsed folders without mutating folder membership', () => {
  const all = flattenBookmarkNodes(tree, new Set(['work', 'archive']));
  const visible = flattenBookmarkNodes(tree, new Set(['work']));
  const saved = JSON.stringify(tree);
  const grouped = groupSplitTabRows(visible, all, { firstTabId: 'draft', secondTabId: 'old' });
  const pair = grouped.find(row => row.type === 'split');
  assert.ok(pair?.type === 'split');
  assert.equal(pair.depth, 1);
  assert.equal(pair.second.parentId, 'archive');
  assert.equal(JSON.stringify(tree), saved);
  const collapsed = flattenBookmarkNodes(tree, new Set());
  assert.ok(groupSplitTabRows(collapsed, all, { firstTabId: 'draft', secondTabId: 'old' }).every(row => row.type === 'single'));
});
import { moveBookmarkToDepth, moveBookmarkToDropZone, resolveBookmarkDropDepth, resolveBookmarkDropZone, type BookmarkNode } from '../src/bookmarkTree.ts';

const tree: BookmarkNode[] = [
  { id: 'work', type: 'folder', title: 'Work', children: [
    { id: 'draft', type: 'bookmark', title: 'Draft', url: 'https://example.com/draft' },
    { id: 'reference', type: 'bookmark', title: 'Reference', url: 'https://example.com/reference' },
  ] },
  { id: 'middle', type: 'bookmark', title: 'Middle', url: 'https://example.com/middle' },
  { id: 'last', type: 'bookmark', title: 'Last', url: 'https://example.com/last' },
  { id: 'archive', type: 'folder', title: 'Archive', children: [
    { id: 'old', type: 'bookmark', title: 'Old', url: 'https://example.com/old' },
  ] },
];

function ids(nodes: BookmarkNode[]): string[] {
  return nodes.flatMap(node => [node.id, ...(node.type === 'folder' ? ids(node.children) : [])]);
}

test('moves a bottom-level bookmark to the top of the root list', () => {
  const depth = resolveBookmarkDropDepth(0, 0, 0);
  const result = moveBookmarkToDepth(tree, 'last', 'work', depth, false);
  assert.deepEqual(result.nodes.map(node => node.id), ['last', 'work', 'middle', 'archive']);
  assert.equal(result.parentId, null);
});

test('moves a nested bookmark to the root when dropped over a shallower row without horizontal movement', () => {
  const depth = resolveBookmarkDropDepth(1, 0, 0);
  const result = moveBookmarkToDepth(tree, 'draft', 'middle', depth, false);
  assert.deepEqual(result.nodes.map(node => node.id), ['work', 'draft', 'middle', 'last', 'archive']);
  assert.deepEqual((result.nodes[0] as Extract<BookmarkNode, { type: 'folder' }>).children.map(node => node.id), ['reference']);
});

test('reorders a bookmark to just after the hovered sibling', () => {
  const result = moveBookmarkToDepth(tree, 'middle', 'last', 0, true);
  assert.deepEqual(result.nodes.map(node => node.id), ['work', 'last', 'middle', 'archive']);
});

test('nests a bookmark into a folder when horizontal movement requests its child depth', () => {
  const depth = resolveBookmarkDropDepth(0, 0, 14);
  const result = moveBookmarkToDepth(tree, 'middle', 'work', depth, false);
  const work = result.nodes[0] as Extract<BookmarkNode, { type: 'folder' }>;
  assert.equal(result.parentId, 'work');
  assert.deepEqual(work.children.map(node => node.id), ['draft', 'reference', 'middle']);
});

test('moves an item between folders before the hovered child', () => {
  const result = moveBookmarkToDepth(tree, 'draft', 'old', 1, false);
  const archive = result.nodes.find(node => node.id === 'archive') as Extract<BookmarkNode, { type: 'folder' }>;
  assert.equal(result.parentId, 'archive');
  assert.deepEqual(archive.children.map(node => node.id), ['draft', 'old']);
  assert.deepEqual(ids(result.nodes), ['work', 'reference', 'middle', 'last', 'archive', 'draft', 'old']);
});

test('rejects moving a folder into one of its descendants', () => {
  const result = moveBookmarkToDepth(tree, 'work', 'draft', 1, false);
  assert.deepEqual(result.nodes, tree);
});

test('uses the hovered shallower row depth unless the pointer is deliberately indented', () => {
  assert.equal(resolveBookmarkDropDepth(2, 0, 0), 0);
  assert.equal(resolveBookmarkDropDepth(2, 0, -14), 0);
  assert.equal(resolveBookmarkDropDepth(0, 0, 14), 1);
  assert.equal(resolveBookmarkDropDepth(0, 1, 0), 0);
});

test('classifies drop zones: folders have a middle nesting band, links split in half', () => {
  assert.equal(resolveBookmarkDropZone(105, 100, 40, true), 'before');
  assert.equal(resolveBookmarkDropZone(120, 100, 40, true), 'inside');
  assert.equal(resolveBookmarkDropZone(135, 100, 40, true), 'after');
  assert.equal(resolveBookmarkDropZone(110, 100, 40, false), 'before');
  assert.equal(resolveBookmarkDropZone(130, 100, 40, false), 'after');
});

test('dropping inside a folder appends to it without any horizontal movement', () => {
  const nodes: BookmarkNode[] = [
    { id: 'a', type: 'bookmark', title: 'A', url: 'https://a' },
    { id: 'f', type: 'folder', title: 'F', children: [{ id: 'c', type: 'bookmark', title: 'C', url: 'https://c' }] },
  ];
  const result = moveBookmarkToDropZone(nodes, 'a', 'f', 'inside', 0, 0);
  assert.equal(result.parentId, 'f');
  assert.deepEqual(result.nodes.map(n => n.id), ['f']);
  const folder = result.nodes[0];
  assert.equal(folder.type === 'folder' && folder.children.map(n => n.id).join(), 'c,a');
});

test('dropping before/after a row places the item as its sibling', () => {
  const nodes: BookmarkNode[] = [
    { id: 'a', type: 'bookmark', title: 'A', url: 'https://a' },
    { id: 'b', type: 'bookmark', title: 'B', url: 'https://b' },
    { id: 'c', type: 'bookmark', title: 'C', url: 'https://c' },
  ];
  assert.deepEqual(moveBookmarkToDropZone(nodes, 'a', 'c', 'after', 0, 0).nodes.map(n => n.id), ['b', 'c', 'a']);
  assert.deepEqual(moveBookmarkToDropZone(nodes, 'c', 'a', 'before', 0, 0).nodes.map(n => n.id), ['c', 'a', 'b']);
});

test('dropping onto an unknown row fails loudly', () => {
  assert.throws(() => moveBookmarkToDropZone([], 'a', 'missing', 'after', 0, 0), /missing/);
});

test('the tree helpers also move tab nodes between folders', () => {
  type TabNode = { id: string; type: 'tab' } | { id: string; type: 'folder'; collapsed: boolean; children: TabNode[] };
  const nodes: TabNode[] = [
    { id: 't1', type: 'tab' },
    { id: 'f', type: 'folder', collapsed: true, children: [{ id: 't2', type: 'tab' }] },
    { id: 't3', type: 'tab' },
  ];
  const nested = moveBookmarkToDropZone(nodes, 't3', 'f', 'inside', 0, 0);
  assert.equal(nested.parentId, 'f');
  const folder = nested.nodes[1];
  assert.equal(folder.type === 'folder' && folder.collapsed, true, 'extra folder fields are preserved');
  assert.equal(folder.type === 'folder' && folder.children.map(n => n.id).join(), 't2,t3');
  const reordered = moveBookmarkToDropZone(nodes, 't3', 't1', 'before', 0, 0);
  assert.deepEqual(reordered.nodes.map(n => n.id), ['t3', 't1', 'f']);
});
