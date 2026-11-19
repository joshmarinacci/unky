/**
 * Bookmark tree state as a reducer: the persisted bookmark nodes, which folders are expanded,
 * and whether the initial load has finished (saving waits for it). Pure, so it is unit-tested directly.
 */
import type { BookmarkFolder, BookmarkLink, BookmarkNode } from './bookmarks';
import { appendToFolder, moveNodeToDropZone, removeNode, updateNode, type DropZone } from './tree';

export type BookmarkState = {
  nodes: BookmarkNode[];
  expandedFolderIds: string[];
  loaded: boolean;
};

export type BookmarkAction =
  /** The initial load finished; `nodes` is omitted when loading failed or there is nothing to load. */
  | { type: 'loaded'; nodes?: BookmarkNode[] }
  /** The whole tree was replaced, for example by an import or another window's change. */
  | { type: 'replaced'; nodes: BookmarkNode[] }
  /** Add a node at the top level (first) or at the end of a folder, expanding that folder. */
  | { type: 'added'; node: BookmarkLink | BookmarkFolder; parentId?: string | null }
  | { type: 'bookmarkEdited'; id: string; title: string; url: string; description: string }
  | { type: 'folderRenamed'; id: string; title: string }
  | { type: 'removed'; id: string }
  | {
      type: 'moved';
      activeId: string;
      overId: string;
      zone: DropZone;
      originDepth: number;
      horizontalDelta: number;
    }
  | { type: 'folderExpanded'; id: string }
  | { type: 'folderToggled'; id: string };

export function initialBookmarkState(nodes: BookmarkNode[]): BookmarkState {
  return { nodes, expandedFolderIds: [], loaded: false };
}

function expand(ids: string[], ...add: (string | null | undefined)[]): string[] {
  const missing = add.filter((id): id is string => Boolean(id) && !ids.includes(id!));
  return missing.length ? [...ids, ...new Set(missing)] : ids;
}

export function bookmarkReducer(state: BookmarkState, action: BookmarkAction): BookmarkState {
  switch (action.type) {
    case 'loaded':
      return { ...state, nodes: action.nodes ?? state.nodes, loaded: true };
    case 'replaced':
      return { ...state, nodes: action.nodes };
    case 'added': {
      const { node, parentId } = action;
      const nodes = parentId ? appendToFolder(state.nodes, parentId, node).nodes : [node, ...state.nodes];
      const newFolderId = node.type === 'folder' ? node.id : undefined;
      return { ...state, nodes, expandedFolderIds: expand(state.expandedFolderIds, parentId, newFolderId) };
    }
    case 'bookmarkEdited': {
      const { id, title, url, description } = action;
      return {
        ...state,
        nodes: updateNode(state.nodes, id, (node) =>
          node.type === 'bookmark' ? { ...node, title, url, description } : node,
        ),
      };
    }
    case 'folderRenamed':
      return {
        ...state,
        nodes: updateNode(state.nodes, action.id, (node) =>
          node.type === 'folder' ? { ...node, title: action.title } : node,
        ),
      };
    case 'removed':
      return { ...state, nodes: removeNode(state.nodes, action.id).nodes };
    case 'moved': {
      const result = moveNodeToDropZone(
        state.nodes,
        action.activeId,
        action.overId,
        action.zone,
        action.originDepth,
        action.horizontalDelta,
      );
      return { ...state, nodes: result.nodes, expandedFolderIds: expand(state.expandedFolderIds, result.parentId) };
    }
    case 'folderExpanded': {
      const expandedFolderIds = expand(state.expandedFolderIds, action.id);
      // Same state when already expanded, so the drag hover timer causes no re-render.
      return expandedFolderIds === state.expandedFolderIds ? state : { ...state, expandedFolderIds };
    }
    case 'folderToggled':
      return {
        ...state,
        expandedFolderIds: state.expandedFolderIds.includes(action.id)
          ? state.expandedFolderIds.filter((id) => id !== action.id)
          : [...state.expandedFolderIds, action.id],
      };
  }
}
