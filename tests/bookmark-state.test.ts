import assert from 'node:assert/strict';
import test from 'node:test';
import { bookmarkReducer, initialBookmarkState, type BookmarkState } from '../src/bookmarkState.ts';
import type { BookmarkFolder, BookmarkLink, BookmarkNode } from '../src/bookmarks.ts';

const link = (id: string, url = `https://${id}.test/`): BookmarkLink => ({ id, type: 'bookmark', title: id, url });
const folder = (id: string, children: BookmarkNode[] = []): BookmarkFolder => ({
  id,
  type: 'folder',
  title: id,
  children,
});
const state = (nodes: BookmarkNode[], expandedFolderIds: string[] = []): BookmarkState => ({
  nodes,
  expandedFolderIds,
  loaded: true,
});

test('loading marks bookmarks loaded and keeps the current tree when nothing was loaded', () => {
  const initial = initialBookmarkState([link('a')]);
  assert.equal(initial.loaded, false);
  assert.deepEqual(bookmarkReducer(initial, { type: 'loaded' }), { ...initial, loaded: true });
  assert.deepEqual(bookmarkReducer(initial, { type: 'loaded', nodes: [link('b')] }).nodes, [link('b')]);
});

test('replacing the tree keeps expanded folders and the loaded flag', () => {
  const next = bookmarkReducer(state([link('a')], ['f']), { type: 'replaced', nodes: [link('b')] });
  assert.deepEqual(next, state([link('b')], ['f']));
});

test('adding at the top level puts the bookmark first', () => {
  const next = bookmarkReducer(state([link('a')]), { type: 'added', node: link('b') });
  assert.deepEqual(
    next.nodes.map((node) => node.id),
    ['b', 'a'],
  );
  assert.deepEqual(next.expandedFolderIds, []);
});

test('adding a bookmark to a folder appends it and expands the folder', () => {
  const next = bookmarkReducer(state([folder('f', [link('a')])]), { type: 'added', node: link('b'), parentId: 'f' });
  assert.deepEqual(next.nodes, [folder('f', [link('a'), link('b')])]);
  assert.deepEqual(next.expandedFolderIds, ['f']);
});

test('creating a folder inside another expands both, once each', () => {
  const next = bookmarkReducer(state([folder('f')], ['f']), { type: 'added', node: folder('g'), parentId: 'f' });
  assert.deepEqual(next.nodes, [folder('f', [folder('g')])]);
  assert.deepEqual(next.expandedFolderIds, ['f', 'g']);
});

test('editing changes only bookmarks and renaming changes only folders', () => {
  const start = state([link('a'), folder('f')]);
  const edited = bookmarkReducer(start, {
    type: 'bookmarkEdited',
    id: 'a',
    title: 'A',
    url: 'https://a.example/',
    description: 'note',
  });
  assert.deepEqual(edited.nodes[0], { ...link('a'), title: 'A', url: 'https://a.example/', description: 'note' });
  assert.deepEqual(
    bookmarkReducer(start, { type: 'bookmarkEdited', id: 'f', title: 'x', url: 'y', description: '' }).nodes,
    start.nodes,
  );
  assert.equal(
    (bookmarkReducer(start, { type: 'folderRenamed', id: 'f', title: 'Work' }).nodes[1] as BookmarkFolder).title,
    'Work',
  );
  assert.deepEqual(bookmarkReducer(start, { type: 'folderRenamed', id: 'a', title: 'Work' }).nodes, start.nodes);
});

test('removing a folder removes everything inside it', () => {
  const next = bookmarkReducer(state([folder('f', [link('a')]), link('b')]), { type: 'removed', id: 'f' });
  assert.deepEqual(next.nodes, [link('b')]);
});

test('dropping a bookmark inside a folder moves it there and expands the folder', () => {
  const next = bookmarkReducer(state([link('a'), folder('f')]), {
    type: 'moved',
    activeId: 'a',
    overId: 'f',
    zone: 'inside',
    originDepth: 0,
    horizontalDelta: 0,
  });
  assert.deepEqual(next.nodes, [folder('f', [link('a')])]);
  assert.deepEqual(next.expandedFolderIds, ['f']);
});

test('expanding is idempotent and toggling flips a folder', () => {
  const expanded = bookmarkReducer(state([folder('f')]), { type: 'folderExpanded', id: 'f' });
  assert.deepEqual(expanded.expandedFolderIds, ['f']);
  assert.equal(bookmarkReducer(expanded, { type: 'folderExpanded', id: 'f' }), expanded);
  const collapsed = bookmarkReducer(expanded, { type: 'folderToggled', id: 'f' });
  assert.deepEqual(collapsed.expandedFolderIds, []);
  assert.deepEqual(bookmarkReducer(collapsed, { type: 'folderToggled', id: 'f' }).expandedFolderIds, ['f']);
});
