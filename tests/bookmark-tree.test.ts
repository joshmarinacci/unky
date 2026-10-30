import assert from 'node:assert/strict';
import test from 'node:test';
import { moveBookmarkToDepth, resolveBookmarkDropDepth, type BookmarkNode } from '../src/bookmarkTree.ts';

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
