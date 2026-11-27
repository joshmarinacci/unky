import { expect, test } from 'vitest';
import {
  countBookmarks,
  isBookmarkableUrl,
  tabBankruptcy,
  tabFolderToBookmarkFolder,
  tabToBookmark,
  type BookmarkableTab,
  type TabLookup,
} from '../src/tabBookmarks.ts';
import type { TabFolder, TabNode } from '../src/tabTree.ts';

function ids() {
  let next = 0;
  return () => `id-${(next += 1)}`;
}

const tabList: BookmarkableTab[] = [
  { id: 'news', url: 'https://news.example/', title: 'News', favicon: 'data:image/png;base64,AA' },
  { id: 'blank', url: '', title: 'New Tab' },
  { id: 'docs', url: 'https://docs.example/guide', title: 'My renamed docs' },
  { id: 'secret', url: 'https://secret.example/', title: 'Secret', private: true },
  { id: 'pinned', url: 'https://mail.example/', title: 'Mail' },
  { id: 'deep', url: 'http://deep.example/', title: '' },
  { id: 'settings', url: '', title: 'Settings' },
];
const lookup: TabLookup = {
  tabs: new Map(tabList.map((tab) => [tab.id, tab])),
  pinnedIds: new Set(['pinned']),
};
const work: TabFolder = {
  id: 'work',
  type: 'folder',
  title: 'Work',
  collapsed: true,
  children: [
    { id: 'docs', type: 'tab' },
    { id: 'secret', type: 'tab' },
    { id: 'pinned', type: 'tab' },
    { id: 'inner', type: 'folder', title: 'Inner', collapsed: false, children: [{ id: 'deep', type: 'tab' }] },
    { id: 'empty', type: 'folder', title: 'Empty', collapsed: false, children: [{ id: 'blank', type: 'tab' }] },
  ],
};
const tree: TabNode[] = [
  { id: 'news', type: 'tab' },
  work,
  { id: 'settings', type: 'tab' },
  { id: 'blank', type: 'tab' },
];

test('only website addresses can be bookmarked', () => {
  expect(isBookmarkableUrl('https://example.com/')).toBe(true);
  expect(isBookmarkableUrl('HTTP://example.com/')).toBe(true);
  expect(isBookmarkableUrl('')).toBe(false);
  expect(isBookmarkableUrl('about:blank')).toBe(false);
  expect(isBookmarkableUrl('unky://settings')).toBe(false);
});

test('a tab becomes a bookmark with its shown name and icon, falling back to its address', () => {
  expect(tabToBookmark(tabList[0], ids())).toStrictEqual({
    id: 'id-1',
    type: 'bookmark',
    title: 'News',
    url: 'https://news.example/',
    favicon: 'data:image/png;base64,AA',
  });
  expect(tabToBookmark(tabList[5], ids())).toMatchObject({ title: 'http://deep.example/' });
  expect(tabToBookmark(tabList[5], ids())).not.toHaveProperty('favicon');
  expect(tabToBookmark(tabList[1], ids()), 'blank tabs are not bookmarked').toBe(undefined);
});

test('a tab folder becomes a bookmark folder, keeping nesting and dropping what cannot be saved', () => {
  const folder = tabFolderToBookmarkFolder(work, lookup, ids());
  expect(folder).toMatchObject({
    type: 'folder',
    title: 'Work',
    children: [
      { type: 'bookmark', title: 'My renamed docs', url: 'https://docs.example/guide' },
      { type: 'folder', title: 'Inner', children: [{ type: 'bookmark', url: 'http://deep.example/' }] },
    ],
  });
  expect(countBookmarks(folder!.children), 'private and pinned tabs and empty folders are left out').toBe(2);
  const blankOnly: TabFolder = { ...work, children: [{ id: 'blank', type: 'tab' }] };
  expect(tabFolderToBookmarkFolder(blankOnly, lookup, ids())).toBe(undefined);
});

test('tab bankruptcy saves every website tab in sidebar order and closes all but pinned and private tabs', () => {
  const result = tabBankruptcy(tree, lookup, 'Tab Bankruptcy', ids());
  expect(result.folder).toMatchObject({
    type: 'folder',
    title: 'Tab Bankruptcy',
    children: [
      { type: 'bookmark', url: 'https://news.example/' },
      { type: 'folder', title: 'Work', children: [{ url: 'https://docs.example/guide' }, { title: 'Inner' }] },
    ],
  });
  expect(countBookmarks(result.folder!.children)).toBe(3);
  expect(result.closeIds, 'each tab once, in sidebar order').toStrictEqual([
    'news',
    'docs',
    'deep',
    'blank',
    'settings',
  ]);
});

test('tab bankruptcy also closes open tabs the tree has not listed yet, and saves nothing when there are no websites', () => {
  const late: BookmarkableTab = { id: 'late', url: 'https://late.example/', title: 'Late' };
  const withLate: TabLookup = { ...lookup, tabs: new Map([...lookup.tabs, ['late', late]]) };
  expect(tabBankruptcy(tree, withLate, 'T', ids()).closeIds.at(-1)).toBe('late');

  const blankOnly = tabBankruptcy([{ id: 'blank', type: 'tab' }], lookup, 'T', ids());
  expect(blankOnly.folder).toBe(undefined);
  expect(blankOnly.closeIds).toContain('blank');
});
