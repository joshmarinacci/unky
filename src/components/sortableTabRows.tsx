import { closestCenter, useDroppable, type CollisionDetection } from '@dnd-kit/core';
import { useSortable } from '@dnd-kit/sortable';
import type { DropZone } from '../tree';

/** Droppable ID for the empty space after the last pinned tab. */
export const pinnedTabsEndId = '__pinned_tabs_end__';

export function SortableRow({
  id,
  depth,
  expanded,
  dropZone,
  disabled,
  className,
  label,
  current,
  onActivate,
  onContextMenu,
  children,
  style,
}: {
  id: string;
  depth: number;
  expanded?: boolean;
  dropZone?: DropZone;
  disabled: boolean;
  className: string;
  label: string;
  current?: boolean;
  onActivate?: () => void;
  onContextMenu: (event: React.MouseEvent) => void;
  children: React.ReactNode;
  style?: React.CSSProperties;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useSortable({
    id,
    disabled,
    data: { container: 'tabs', nodeId: id },
  });
  return (
    <div
      ref={setNodeRef}
      style={{ opacity: isDragging ? 0.35 : 1, ...style }}
      className={`${className} ${dropZone ? `drop-${dropZone}` : ''}`}
      data-tab-node-id={id}
      {...attributes}
      {...listeners}
      role="treeitem"
      aria-label={label}
      aria-level={depth + 1}
      aria-expanded={expanded}
      aria-current={current ? 'page' : undefined}
      onContextMenu={onContextMenu}
      onKeyDown={(event) => {
        listeners?.onKeyDown?.(event);
        if (event.key === 'Enter' && event.target === event.currentTarget) onActivate?.();
      }}
    >
      {children}
    </div>
  );
}

export function SortablePinnedTab({
  id,
  tabId,
  title,
  selected,
  compact,
  dropZone,
  children,
  onClick,
  onContextMenu,
}: {
  id: string;
  tabId: string;
  title: string;
  selected: boolean;
  compact?: boolean;
  dropZone?: DropZone;
  children: React.ReactNode;
  onClick: () => void;
  onContextMenu: (event: React.MouseEvent) => void;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useSortable({
    id,
    disabled: compact,
    data: { container: 'pinned', nodeId: tabId },
  });
  return (
    <button
      ref={setNodeRef}
      type="button"
      className={`${compact ? 'rail-button' : 'pinned-tab-button'} ${selected ? 'selected' : ''} ${isDragging ? 'dragging' : ''} ${dropZone ? `drop-${dropZone}` : ''}`}
      style={{ opacity: isDragging ? 0.4 : 1 }}
      title={title}
      aria-label={`Pinned tab: ${title}`}
      aria-current={selected ? 'page' : undefined}
      data-tab-id={tabId}
      onClick={onClick}
      onContextMenu={onContextMenu}
      {...attributes}
      {...listeners}
    >
      {children}
    </button>
  );
}

export function PinnedTabsDock({
  children,
  active,
  empty,
}: {
  children: React.ReactNode;
  active: boolean;
  empty: boolean;
}) {
  const { setNodeRef } = useDroppable({ id: pinnedTabsEndId, data: { container: 'pinned', nodeId: null } });
  return (
    <div
      ref={setNodeRef}
      className={`pinned-tabs-row${active ? ' drop-active' : ''}`}
      role="group"
      aria-label="Pinned tabs"
    >
      {children}
      {empty && <span className="pinned-tabs-hint">Drop tabs here to pin</span>}
    </div>
  );
}

export const tabCollisionDetection: CollisionDetection = (args) => {
  const { pointerCoordinates: pointer, droppableContainers, droppableRects } = args;
  if (!pointer) return closestCenter(args);

  const dock = droppableContainers.find((container) => container.id === pinnedTabsEndId);
  const dockRect = dock && droppableRects.get(dock.id);
  const inDock = Boolean(
    dockRect &&
    pointer.x >= dockRect.left &&
    pointer.x <= dockRect.right &&
    pointer.y >= dockRect.top &&
    pointer.y <= dockRect.bottom,
  );
  const candidates = droppableContainers.filter(
    (container) => container.data.current?.container === (inDock ? 'pinned' : 'tabs'),
  );
  if (!candidates.length) return [];

  if (inDock) {
    const chips = candidates.filter((container) => container.id !== pinnedTabsEndId);
    if (!chips.length) return dock ? [{ id: dock.id, data: { droppableContainer: dock } }] : [];
    return chips
      .map((container) => {
        const rect = droppableRects.get(container.id);
        return {
          id: container.id,
          data: {
            droppableContainer: container,
            value: Math.abs(pointer.x - (rect ? rect.left + rect.width / 2 : pointer.x)),
          },
        };
      })
      .sort((a, b) => (a.data?.value ?? 0) - (b.data?.value ?? 0));
  }

  const horizontal =
    document.querySelector('.browser-shell')?.getAttribute('data-tab-position') === 'top' ||
    document.querySelector('.browser-shell')?.getAttribute('data-tab-position') === 'bottom';
  return candidates
    .map((container) => {
      const rect = droppableRects.get(container.id);
      const center = rect ? (horizontal ? rect.left + rect.width / 2 : rect.top + rect.height / 2) : 0;
      const coordinate = horizontal ? pointer.x : pointer.y;
      return { id: container.id, data: { droppableContainer: container, value: Math.abs(coordinate - center) } };
    })
    .sort((a, b) => (a.data?.value ?? 0) - (b.data?.value ?? 0));
};
