import type { MenuEntry } from './nativeMenu';

export type TabContextMenuTarget = { id: string; type: 'tab' | 'folder'; x: number; y: number };

export type SplitSideChoice = 'left' | 'right' | 'top' | 'bottom';

const splitSides: { side: SplitSideChoice; label: string }[] = [
  { side: 'left', label: 'Left' },
  { side: 'right', label: 'Right' },
  { side: 'top', label: 'Up' },
  { side: 'bottom', label: 'Down' },
];

export type TabMenuOptions = {
  pinned: boolean;
  /** Reload and split need a website, not a blank or internal page. */
  isWebsite: boolean;
  inSplit: boolean;
  folders: { id: string; title: string }[];
  onRename: () => void;
  onTogglePin: () => void;
  onReload: () => void;
  onNewTabBelow: () => void;
  onDuplicate: () => void;
  onBookmark: () => void;
  onSplit: (side: SplitSideChoice) => void;
  onUnsplit: () => void;
  onMoveToNewFolder: () => void;
  onMoveToFolder: (folderId: string) => void;
  onCloseTab: () => void;
};

export type FolderMenuOptions = {
  onRename: () => void;
  onBookmarkFolder: () => void;
  onDeleteFolder: () => void;
};

/**
 * The sidebar tab menu. Items that have a browser shortcut show its accelerator, which macOS draws
 * at the right edge of the native menu the same way the app menus do.
 */
export function tabMenuEntries(options: TabMenuOptions): MenuEntry[] {
  return [
    { type: 'item', id: 'rename', label: 'Rename', action: options.onRename },
    { type: 'item', id: 'pin', label: options.pinned ? 'Unpin' : 'Pin', action: options.onTogglePin },
    {
      type: 'item',
      id: 'reload',
      label: 'Reload',
      enabled: options.isWebsite,
      accelerator: 'CmdOrCtrl+R',
      action: options.onReload,
    },
    { type: 'item', id: 'new-below', label: 'New Tab Below', action: options.onNewTabBelow },
    { type: 'item', id: 'duplicate', label: 'Duplicate', action: options.onDuplicate },
    { type: 'item', id: 'bookmark', label: 'Bookmark Tab', enabled: options.isWebsite, action: options.onBookmark },
    { type: 'separator' },
    {
      type: 'submenu',
      id: 'split',
      label: 'Split',
      enabled: options.isWebsite,
      items: [
        ...splitSides.map(({ side, label }): MenuEntry => ({
          type: 'item',
          id: `split-${side}`,
          label,
          action: () => options.onSplit(side),
        })),
        ...(options.inSplit
          ? ([
              { type: 'separator' },
              { type: 'item', id: 'unsplit', label: 'Unsplit from Other Tab', action: options.onUnsplit },
            ] satisfies MenuEntry[])
          : []),
      ],
    },
    {
      type: 'submenu',
      id: 'group',
      label: 'Move to Group',
      items: [
        { type: 'item', id: 'group-new', label: 'New Group', action: options.onMoveToNewFolder },
        ...(options.folders.length ? ([{ type: 'separator' }] satisfies MenuEntry[]) : []),
        ...options.folders.map((folder): MenuEntry => ({
          type: 'item',
          id: `group-${folder.id}`,
          label: folder.title,
          action: () => options.onMoveToFolder(folder.id),
        })),
      ],
    },
    { type: 'separator' },
    { type: 'item', id: 'close', label: 'Close Tab', accelerator: 'CmdOrCtrl+W', action: options.onCloseTab },
  ];
}

export function folderMenuEntries(options: FolderMenuOptions): MenuEntry[] {
  return [
    { type: 'item', id: 'rename', label: 'Rename', action: options.onRename },
    { type: 'item', id: 'bookmark-folder', label: 'Bookmark Folder', action: options.onBookmarkFolder },
    { type: 'item', id: 'delete-folder', label: 'Delete Folder', action: options.onDeleteFolder },
  ];
}
