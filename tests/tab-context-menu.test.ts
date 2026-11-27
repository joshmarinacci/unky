import { expect, test, vi } from 'vitest';
import { flattenMenuEntries, nativeMenuItems } from '../src/nativeMenu.ts';
import { folderMenuEntries, tabMenuEntries, type TabMenuOptions } from '../src/tabContextMenu.ts';

function options(overrides: Partial<TabMenuOptions> = {}): TabMenuOptions {
  return {
    pinned: false,
    isWebsite: true,
    inSplit: false,
    folders: [],
    onRename: vi.fn(),
    onTogglePin: vi.fn(),
    onReload: vi.fn(),
    onNewTabBelow: vi.fn(),
    onDuplicate: vi.fn(),
    onBookmark: vi.fn(),
    onSplit: vi.fn(),
    onUnsplit: vi.fn(),
    onMoveToNewFolder: vi.fn(),
    onMoveToFolder: vi.fn(),
    onCloseTab: vi.fn(),
    ...overrides,
  };
}

test('items with a browser shortcut show its accelerator', () => {
  const items = flattenMenuEntries(tabMenuEntries(options()));
  const accelerators = Object.fromEntries(items.map((item) => [item.label, item.accelerator]));
  expect(accelerators).toMatchObject({ Reload: 'CmdOrCtrl+R', 'Close Tab': 'CmdOrCtrl+W' });
  expect(accelerators.Rename).toBeUndefined();
  expect(accelerators.Duplicate).toBeUndefined();
});

test('accelerators reach the native menu items', () => {
  const native = nativeMenuItems(tabMenuEntries(options()));
  expect(native).toContainEqual(expect.objectContaining({ text: 'Reload', accelerator: 'CmdOrCtrl+R' }));
  expect(native).toContainEqual({ item: 'Separator' });
  const split = native.find((item) => 'text' in item && item.text === 'Split');
  expect(split).toMatchObject({ items: expect.arrayContaining([expect.objectContaining({ text: 'Right' })]) });
});

test('Move to Group always offers New Group, then the existing groups', () => {
  const onMoveToNewFolder = vi.fn();
  const onMoveToFolder = vi.fn();
  const items = flattenMenuEntries(
    tabMenuEntries(options({ folders: [{ id: 'f1', title: 'Work' }], onMoveToNewFolder, onMoveToFolder })),
  );
  const groupItems = items.filter((item) => item.path[0] === 'Move to Group');
  expect(groupItems.map((item) => item.label)).toStrictEqual(['New Group', 'Work']);
  groupItems[0].action();
  groupItems[1].action();
  expect(onMoveToNewFolder).toHaveBeenCalledOnce();
  expect(onMoveToFolder).toHaveBeenCalledWith('f1');

  const withoutFolders = flattenMenuEntries(tabMenuEntries(options()));
  expect(withoutFolders.filter((item) => item.path[0] === 'Move to Group').map((item) => item.label)).toStrictEqual([
    'New Group',
  ]);
});

test('non-website tabs cannot reload or split, and Unsplit appears only in a split', () => {
  const internal = flattenMenuEntries(tabMenuEntries(options({ isWebsite: false })));
  expect(internal.find((item) => item.label === 'Reload')?.enabled).toBe(false);
  expect(internal.some((item) => item.path[0] === 'Split')).toBe(false);

  const split = flattenMenuEntries(tabMenuEntries(options({ inSplit: true })));
  expect(split.filter((item) => item.path[0] === 'Split').map((item) => item.label)).toStrictEqual([
    'Left',
    'Right',
    'Up',
    'Down',
    'Unsplit from Other Tab',
  ]);
  expect(flattenMenuEntries(tabMenuEntries(options())).some((item) => item.label === 'Unsplit from Other Tab')).toBe(
    false,
  );
});

test('pinning toggles the label and split items pass their side', () => {
  const onSplit = vi.fn();
  const items = flattenMenuEntries(tabMenuEntries(options({ pinned: true, onSplit })));
  expect(items.some((item) => item.label === 'Unpin')).toBe(true);
  items.find((item) => item.label === 'Up')?.action();
  expect(onSplit).toHaveBeenCalledWith('top');
});

test('folder menu offers rename, bookmark, and delete', () => {
  const onBookmarkFolder = vi.fn();
  const onDeleteFolder = vi.fn();
  const items = flattenMenuEntries(folderMenuEntries({ onRename: vi.fn(), onBookmarkFolder, onDeleteFolder }));
  expect(items.map((item) => item.label)).toStrictEqual(['Rename', 'Bookmark Folder', 'Delete Folder']);
  items[1].action();
  expect(onBookmarkFolder).toHaveBeenCalledOnce();
  items[2].action();
  expect(onDeleteFolder).toHaveBeenCalledOnce();
});

test('Bookmark Tab is offered only for website tabs', () => {
  const onBookmark = vi.fn();
  const website = flattenMenuEntries(tabMenuEntries(options({ onBookmark })));
  const item = website.find((entry) => entry.label === 'Bookmark Tab');
  expect(item?.enabled).toBe(true);
  item?.action();
  expect(onBookmark).toHaveBeenCalledOnce();
  const internal = flattenMenuEntries(tabMenuEntries(options({ isWebsite: false })));
  expect(internal.find((entry) => entry.label === 'Bookmark Tab')?.enabled).toBe(false);
});
