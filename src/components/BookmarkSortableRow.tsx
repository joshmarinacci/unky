import { ChevronDown, ChevronRight, Folder, FolderPlus, Pencil, Star, X } from 'lucide-react';
import { AppInput } from '../components/ui';
import { useSortable } from '@dnd-kit/sortable';
import type { DropZone } from '../tree';
import { selectInputText } from '../tabUiActions';
import type { BookmarkFolder, BookmarkLink, BookmarkNode } from '../bookmarks';

export function BookmarkSortableRow({
  node,
  depth,
  expanded,
  dropZone,
  editing,
  onToggle,
  onOpen,
  onEdit,
  onDelete,
  onNewFolder,
  onRename,
  onCancelRename,
  editingFolder,
  folderTitle,
  setFolderTitle,
  saveFolderTitle,
  editForm,
  onContextMenu,
  tabbable,
}: {
  node: BookmarkNode;
  depth: number;
  expanded: boolean;
  dropZone?: DropZone;
  editing: boolean;
  onToggle: () => void;
  onOpen: (url: string) => void;
  onEdit: (node: BookmarkLink) => void;
  onDelete: (node: BookmarkNode) => void;
  onNewFolder: (id: string) => void;
  onContextMenu: (event: React.MouseEvent, bookmark: BookmarkNode) => void;
  onRename: (node: BookmarkFolder) => void;
  onCancelRename: () => void;
  editingFolder: boolean;
  folderTitle: string;
  setFolderTitle: (value: string) => void;
  saveFolderTitle: () => void;
  editForm: React.ReactNode;
  /** Whether Tab reaches this row; arrows move between rows. */
  tabbable: boolean;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useSortable({
    id: node.id,
    disabled: editing || editingFolder,
  });
  const style = { opacity: isDragging ? 0.35 : 1 };
  const itemProps = {
    ...attributes,
    role: 'treeitem',
    tabIndex: tabbable ? 0 : -1,
    'data-bookmark-id': node.id,
    'aria-level': depth + 1,
    'aria-expanded': node.type === 'folder' ? expanded : undefined,
  };
  const itemClass = `bookmark-sortable-item ${dropZone ? `drop-${dropZone}` : ''}`;
  const stopDrag = (event: React.PointerEvent) => event.stopPropagation();
  if (node.type === 'folder')
    return (
      <div ref={setNodeRef} style={style} className={itemClass} {...itemProps} {...listeners}>
        <div
          className="folder-row bookmark-dnd-folder"
          style={{ paddingLeft: depth * 14 }}
          onClick={() => {
            if (!editingFolder) onToggle();
          }}
          onContextMenu={(event) => onContextMenu(event, node)}
        >
          <button
            className="folder-toggle"
            aria-label={`${expanded ? 'Collapse' : 'Expand'} ${node.title}`}
            onPointerDown={stopDrag}
            onClick={(event) => {
              event.stopPropagation();
              onToggle();
            }}
          >
            {expanded ? (
              <ChevronDown className="ui-icon" size={14} aria-hidden="true" />
            ) : (
              <ChevronRight className="ui-icon" size={14} aria-hidden="true" />
            )}
          </button>
          <span className="bookmark-icon folder-icon" aria-hidden="true">
            <Folder className="ui-icon" size={14} />
          </span>
          {editingFolder ? (
            <AppInput
              className="folder-title-input"
              aria-label="Folder name"
              autoFocus
              value={folderTitle}
              onFocus={(event) => selectInputText(event.currentTarget)}
              onPointerDown={stopDrag}
              onChange={(event) => setFolderTitle(event.target.value)}
              onBlur={saveFolderTitle}
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === 'Enter') {
                  event.preventDefault();
                  saveFolderTitle();
                }
                if (event.key === 'Escape') {
                  onCancelRename();
                }
              }}
            />
          ) : (
            <span className="folder-title" title={node.title}>
              {node.title}
            </span>
          )}
          {!node.children.length && expanded && <span className="tree-empty-hint">Empty folder</span>}
          <span className="folder-actions">
            <button
              type="button"
              className="folder-action"
              aria-label={`Create subfolder in ${node.title}`}
              title="New subfolder"
              onPointerDown={stopDrag}
              onClick={(event) => {
                event.stopPropagation();
                onNewFolder(node.id);
              }}
            >
              <FolderPlus className="ui-icon" size={14} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="folder-action"
              aria-label={`Rename ${node.title}`}
              title="Rename folder"
              onPointerDown={stopDrag}
              onClick={(event) => {
                event.stopPropagation();
                onRename(node);
              }}
            >
              <Pencil className="ui-icon" size={14} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="folder-action"
              aria-label={`Delete ${node.title}`}
              title="Delete folder and contents"
              onPointerDown={stopDrag}
              onClick={(event) => {
                event.stopPropagation();
                onDelete(node);
              }}
            >
              <X className="ui-icon" size={14} aria-hidden="true" />
            </button>
          </span>
        </div>
      </div>
    );
  if (editing)
    return (
      <div ref={setNodeRef} className="bookmark-sortable-item" style={{ paddingLeft: depth * 14 }}>
        {editForm}
      </div>
    );
  return (
    <div ref={setNodeRef} style={style} className={itemClass} {...itemProps} {...listeners}>
      <div
        className="bookmark-row bookmark-tree-row bookmark-dnd-link"
        style={{ paddingLeft: depth * 14 }}
        onClick={() => onOpen(node.url)}
        onContextMenu={(event) => onContextMenu(event, node)}
      >
        <span className="bookmark-open">
          <span className="bookmark-icon">
            {node.favicon ? (
              <img
                className="bookmark-favicon"
                src={node.favicon}
                alt=""
                onError={(event) => {
                  event.currentTarget.hidden = true;
                }}
              />
            ) : (
              <Star className="ui-icon" size={14} aria-hidden="true" />
            )}
          </span>
          <span>
            <strong>{node.title}</strong>
            <small>{node.url}</small>
          </span>
        </span>
        <button
          type="button"
          className="bookmark-edit"
          aria-label={`Edit ${node.title}`}
          onPointerDown={stopDrag}
          onClick={(event) => {
            event.stopPropagation();
            onEdit(node);
          }}
        >
          <Pencil className="ui-icon" size={14} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="bookmark-delete"
          aria-label={`Delete ${node.title}`}
          onPointerDown={stopDrag}
          onClick={(event) => {
            event.stopPropagation();
            onDelete(node);
          }}
        >
          <X className="ui-icon" size={14} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
