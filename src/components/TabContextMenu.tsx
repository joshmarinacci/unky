import { useRef, useState } from 'react';
import { Menu, MenuItem, Popover, Separator } from 'react-aria-components';
import { ChevronDown, ChevronRight } from 'lucide-react';

export type TabContextMenuTarget = { id: string; type: 'tab' | 'folder'; x: number; y: number };

export type SplitSideChoice = 'left' | 'right' | 'top' | 'bottom';

const splitSides: { side: SplitSideChoice; label: string }[] = [
  { side: 'left', label: 'Left' },
  { side: 'right', label: 'Right' },
  { side: 'top', label: 'Up' },
  { side: 'bottom', label: 'Down' },
];

type TabActions = {
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
  onSplit: (side: SplitSideChoice) => void;
  onUnsplit: () => void;
  onMoveToFolder: (folderId: string) => void;
  onCloseTab: () => void;
};

type FolderActions = {
  onRename: () => void;
  onDeleteFolder: () => void;
};

type TabContextMenuProps = { target: TabContextMenuTarget; onClose: () => void } & (
  ({ kind: 'tab' } & TabActions) | ({ kind: 'folder' } & FolderActions)
);

/**
 * Context menu for sidebar tabs and tab folders, anchored at the pointer (or the focused row
 * when opened from the keyboard). React Aria provides focus, arrow keys, typeahead and Escape.
 * Submenus expand inline because a flyout could land over the native page WebView, which
 * always draws above this UI.
 */
export function TabContextMenu(props: TabContextMenuProps) {
  const anchorRef = useRef<HTMLSpanElement>(null);
  const [expanded, setExpanded] = useState<'split' | 'group' | null>(null);
  const { target, onClose } = props;
  // Close first and run the action in a later task. The popover's focus containment is torn down
  // in a passive effect, and until then it pulls focus back from anything the action focuses
  // (such as the rename field), leaving focus on the page body.
  const run = (action: () => void) => () => {
    onClose();
    window.setTimeout(action, 0);
  };
  const toggle = (section: 'split' | 'group') => setExpanded((current) => (current === section ? null : section));
  const chevron = (section: 'split' | 'group') =>
    expanded === section ? (
      <ChevronDown className="ui-icon context-menu-chevron" size={13} aria-hidden="true" />
    ) : (
      <ChevronRight className="ui-icon context-menu-chevron" size={13} aria-hidden="true" />
    );

  return (
    <>
      <span ref={anchorRef} className="context-menu-anchor" style={{ left: target.x, top: target.y }} />
      <Popover
        triggerRef={anchorRef}
        isOpen
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
        placement="bottom start"
        offset={2}
        className="sidebar-context-popover"
      >
        <Menu
          className="sidebar-context-menu"
          aria-label={target.type === 'folder' ? 'Tab folder actions' : 'Tab actions'}
          autoFocus="first"
        >
          {props.kind === 'folder' ? (
            <>
              <MenuItem id="rename" onAction={run(props.onRename)}>
                Rename
              </MenuItem>
              <MenuItem id="delete-folder" onAction={run(props.onDeleteFolder)}>
                Delete folder
              </MenuItem>
            </>
          ) : (
            <>
              <MenuItem id="rename" onAction={run(props.onRename)}>
                Rename
              </MenuItem>
              <MenuItem id="pin" onAction={run(props.onTogglePin)}>
                {props.pinned ? 'Unpin' : 'Pin'}
              </MenuItem>
              <MenuItem id="reload" isDisabled={!props.isWebsite} onAction={run(props.onReload)}>
                Reload
              </MenuItem>
              <MenuItem id="new-below" onAction={run(props.onNewTabBelow)}>
                New tab below
              </MenuItem>
              <MenuItem id="duplicate" onAction={run(props.onDuplicate)}>
                Duplicate
              </MenuItem>
              <Separator className="sidebar-context-separator" />
              <MenuItem
                id="split"
                textValue="Split"
                isDisabled={!props.isWebsite}
                aria-expanded={expanded === 'split'}
                onAction={() => toggle('split')}
              >
                Split {chevron('split')}
              </MenuItem>
              {expanded === 'split' &&
                splitSides.map(({ side, label }) => (
                  <MenuItem
                    key={side}
                    id={`split-${side}`}
                    className="react-aria-MenuItem context-submenu-item"
                    onAction={run(() => props.onSplit(side))}
                  >
                    {label}
                  </MenuItem>
                ))}
              {expanded === 'split' && props.inSplit && (
                <MenuItem
                  id="unsplit"
                  className="react-aria-MenuItem context-submenu-item"
                  onAction={run(props.onUnsplit)}
                >
                  Unsplit from other tab
                </MenuItem>
              )}
              <MenuItem
                id="group"
                textValue="Move to group"
                isDisabled={props.folders.length === 0}
                aria-expanded={expanded === 'group'}
                onAction={() => toggle('group')}
              >
                Move to group {chevron('group')}
              </MenuItem>
              {expanded === 'group' &&
                props.folders.map((folder) => (
                  <MenuItem
                    key={folder.id}
                    id={`group-${folder.id}`}
                    className="react-aria-MenuItem context-submenu-item"
                    onAction={run(() => props.onMoveToFolder(folder.id))}
                  >
                    {folder.title}
                  </MenuItem>
                ))}
              <Separator className="sidebar-context-separator" />
              <MenuItem id="close" onAction={run(props.onCloseTab)}>
                Close tab
              </MenuItem>
            </>
          )}
        </Menu>
      </Popover>
    </>
  );
}
