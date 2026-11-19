import { FocusScope, useFocusManager } from 'react-aria';

type TreeKeyboardNavigationProps = {
  orientation?: 'vertical' | 'horizontal';
  /** Turn off while a keyboard drag owns the arrow keys. */
  disabled?: boolean;
  /** Expand or collapse the folder row that has focus. */
  onToggle: (item: HTMLElement) => void;
  /** A row received focus; the tree makes it the row that Tab returns to. */
  onFocusItem: (item: HTMLElement) => void;
  children: React.ReactNode;
};

/**
 * Arrow-key movement between the `treeitem` rows of a sortable tree, using React Aria's focus
 * manager. The rows stay dnd-kit sortables, so this adds only the tree keys dnd-kit lacks:
 * next/previous row, Home/End, expand/collapse, and moving to a row's parent.
 */
export function TreeKeyboardNavigation(props: TreeKeyboardNavigationProps) {
  return (
    <FocusScope>
      <TreeKeys {...props} />
    </FocusScope>
  );
}

const isTreeItem = (node: Element) => node.getAttribute('role') === 'treeitem';
const levelOf = (node: Element) => Number(node.getAttribute('aria-level') ?? 1);

function TreeKeys({
  orientation = 'vertical',
  disabled,
  onToggle,
  onFocusItem,
  children,
}: TreeKeyboardNavigationProps) {
  const focusManager = useFocusManager();
  const horizontal = orientation === 'horizontal';
  const keys = {
    next: horizontal ? 'ArrowRight' : 'ArrowDown',
    previous: horizontal ? 'ArrowLeft' : 'ArrowUp',
    expand: horizontal ? 'ArrowDown' : 'ArrowRight',
    collapse: horizontal ? 'ArrowUp' : 'ArrowLeft',
  };

  function onKeyDown(event: React.KeyboardEvent) {
    const item = event.target;
    // Only rows navigate; buttons and fields inside a row keep their own keys.
    if (disabled || !focusManager || !(item instanceof HTMLElement) || !isTreeItem(item)) return;
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const options = { accept: isTreeItem, tabbable: false };
    const expanded = item.getAttribute('aria-expanded');
    let handled = true;
    if (event.key === keys.next) focusManager.focusNext(options);
    else if (event.key === keys.previous) focusManager.focusPrevious(options);
    else if (event.key === 'Home') focusManager.focusFirst(options);
    else if (event.key === 'End') focusManager.focusLast(options);
    else if (event.key === keys.expand) {
      if (expanded === 'false') onToggle(item);
      else if (expanded === 'true') focusManager.focusNext(options);
      else handled = false;
    } else if (event.key === keys.collapse) {
      const level = levelOf(item);
      if (expanded === 'true') onToggle(item);
      else if (level > 1)
        focusManager.focusPrevious({ ...options, accept: (node) => isTreeItem(node) && levelOf(node) < level });
      else handled = false;
    } else handled = false;
    if (handled) {
      event.preventDefault();
      event.stopPropagation();
    }
  }

  return (
    <div
      className="tree-keyboard-scope"
      onKeyDown={onKeyDown}
      onFocus={(event) => {
        if (event.target instanceof HTMLElement && isTreeItem(event.target)) onFocusItem(event.target);
      }}
    >
      {children}
    </div>
  );
}
