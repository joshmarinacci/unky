import { expect, test } from 'vitest';
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
  expect(initial.loaded).toBe(false);
  expect(bookmarkReducer(initial, { type: 'loaded' })).toStrictEqual({ ...initial, loaded: true });
  expect(bookmarkReducer(initial, { type: 'loaded', nodes: [link('b')] }).nodes).toStrictEqual([link('b')]);
});

test('replacing the tree keeps expanded folders and the loaded flag', () => {
  const next = bookmarkReducer(state([link('a')], ['f']), { type: 'replaced', nodes: [link('b')] });
  expect(next).toStrictEqual(state([link('b')], ['f']));
});

test('adding at the top level puts the bookmark first', () => {
  const next = bookmarkReducer(state([link('a')]), { type: 'added', node: link('b') });
  expect(next.nodes.map((node) => node.id)).toStrictEqual(['b', 'a']);
  expect(next.expandedFolderIds).toStrictEqual([]);
});

test('adding a bookmark to a folder appends it and expands the folder', () => {
  const next = bookmarkReducer(state([folder('f', [link('a')])]), { type: 'added', node: link('b'), parentId: 'f' });
  expect(next.nodes).toStrictEqual([folder('f', [link('a'), link('b')])]);
  expect(next.expandedFolderIds).toStrictEqual(['f']);
});

test('creating a folder inside another expands both, once each', () => {
  const next = bookmarkReducer(state([folder('f')], ['f']), { type: 'added', node: folder('g'), parentId: 'f' });
  expect(next.nodes).toStrictEqual([folder('f', [folder('g')])]);
  expect(next.expandedFolderIds).toStrictEqual(['f', 'g']);
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
  expect(edited.nodes[0]).toStrictEqual({ ...link('a'), title: 'A', url: 'https://a.example/', description: 'note' });
  expect(
    bookmarkReducer(start, { type: 'bookmarkEdited', id: 'f', title: 'x', url: 'y', description: '' }).nodes,
  ).toStrictEqual(start.nodes);
  expect(
    (bookmarkReducer(start, { type: 'folderRenamed', id: 'f', title: 'Work' }).nodes[1] as BookmarkFolder).title,
  ).toBe('Work');
  expect(bookmarkReducer(start, { type: 'folderRenamed', id: 'a', title: 'Work' }).nodes).toStrictEqual(start.nodes);
});

test('removing a folder removes everything inside it', () => {
  const next = bookmarkReducer(state([folder('f', [link('a')]), link('b')]), { type: 'removed', id: 'f' });
  expect(next.nodes).toStrictEqual([link('b')]);
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
  expect(next.nodes).toStrictEqual([folder('f', [link('a')])]);
  expect(next.expandedFolderIds).toStrictEqual(['f']);
});

test('expanding is idempotent and toggling flips a folder', () => {
  const expanded = bookmarkReducer(state([folder('f')]), { type: 'folderExpanded', id: 'f' });
  expect(expanded.expandedFolderIds).toStrictEqual(['f']);
  expect(bookmarkReducer(expanded, { type: 'folderExpanded', id: 'f' })).toBe(expanded);
  const collapsed = bookmarkReducer(expanded, { type: 'folderToggled', id: 'f' });
  expect(collapsed.expandedFolderIds).toStrictEqual([]);
  expect(bookmarkReducer(collapsed, { type: 'folderToggled', id: 'f' }).expandedFolderIds).toStrictEqual(['f']);
});
