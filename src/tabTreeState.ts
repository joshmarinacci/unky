/**
 * Tab-tree edits as one pure reducer. App.tsx applies these synchronously against its tab-tree ref
 * because tab-order changes must reach Rust (`reorder_tabs`) with the new order right away, so
 * this is a plain function rather than a `useReducer` hook. An action that changes nothing
 * returns the same array, so callers can skip the native reorder.
 */
import type { TabFolder, TabNode } from './tabTree';
import { appendTabNodeToFolder, insertTabNode, unwrapTabFolder } from './tabTree';
import { containsNode, findNode, moveNodeToDropZone, removeNode, updateNode, type DropZone } from './tree';

export type TabTreeAction =
  /** Replace the tree, for example after reconciling it with the open tabs. */
  | { type: 'replaced'; nodes: TabNode[] }
  | { type: 'folderCreated'; folder: TabFolder }
  /** Put a new folder where a tab is and move the tab into it. */
  | { type: 'tabWrappedInFolder'; tabId: string; folder: TabFolder }
  | { type: 'folderRenamed'; id: string; title: string }
  | { type: 'folderToggled'; id: string }
  | { type: 'folderExpanded'; id: string }
  /** Remove a folder and put its children where it was. */
  | { type: 'folderUnwrapped'; id: string }
  /** A pointer drop at a resolved zone; expands the folder the node lands in. */
  | {
      type: 'dropped';
      activeId: string;
      overId: string;
      zone: DropZone;
      originDepth: number;
      indentDelta: number;
    }
  /** Move into a folder, next to a node, or to the end; used by keyboard and menu moves. */
  | { type: 'moved'; id: string; targetId?: string; folderId?: string; position?: 'before' | 'after' };

function setCollapsed(nodes: TabNode[], id: string, collapsed: (current: boolean) => boolean): TabNode[] {
  return updateNode(nodes, id, (node) =>
    node.type === 'folder' ? { ...node, collapsed: collapsed(node.collapsed) } : node,
  );
}

export function tabTreeReducer(nodes: TabNode[], action: TabTreeAction): TabNode[] {
  switch (action.type) {
    case 'replaced':
      return action.nodes;
    case 'folderCreated':
      return [action.folder, ...nodes];
    case 'tabWrappedInFolder': {
      const tab = findNode(nodes, action.tabId);
      if (!tab || tab.type !== 'tab') return nodes;
      return updateNode(nodes, action.tabId, (node) => ({ ...action.folder, collapsed: false, children: [node] }));
    }
    case 'folderRenamed':
      return updateNode(nodes, action.id, (node) => (node.type === 'folder' ? { ...node, title: action.title } : node));
    case 'folderToggled':
      return setCollapsed(nodes, action.id, (collapsed) => !collapsed);
    case 'folderExpanded':
      return setCollapsed(nodes, action.id, () => false);
    case 'folderUnwrapped': {
      const result = unwrapTabFolder(nodes, action.id);
      return result.unwrapped ? result.nodes : nodes;
    }
    case 'dropped': {
      const result = moveNodeToDropZone(
        nodes,
        action.activeId,
        action.overId,
        action.zone,
        action.originDepth,
        action.indentDelta,
      );
      return result.parentId ? setCollapsed(result.nodes, result.parentId, () => false) : result.nodes;
    }
    case 'moved': {
      const { id, targetId, folderId, position = 'before' } = action;
      if (!id || id === targetId || id === folderId) return nodes;
      const moving = findNode(nodes, id);
      const destinationId = folderId ?? targetId;
      if (!moving || (destinationId && moving.type === 'folder' && containsNode(moving, destinationId))) return nodes;
      const remaining = removeNode(nodes, id).nodes;
      // appendTabNodeToFolder also expands the destination folder.
      if (folderId) return appendTabNodeToFolder(remaining, folderId, moving).nodes;
      if (targetId) return insertTabNode(remaining, targetId, moving, position === 'after').nodes;
      return [...remaining, moving];
    }
  }
}
