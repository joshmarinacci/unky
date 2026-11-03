import type { FlatNode, TreeNode } from './bookmarkTree';

export type SidebarRow<N extends TreeNode> =
  | { type: 'single'; row: FlatNode<N> }
  | { type: 'split'; first: FlatNode<N>; second: FlatNode<N>; depth: number };

/** Group only the presentation: unsplitting restores each tab's original folder and order. */
export function groupSplitTabRows<N extends TreeNode>(
  visible: FlatNode<N>[],
  all: FlatNode<N>[],
  split: { firstTabId: string; secondTabId: string } | null,
): SidebarRow<N>[] {
  const singles = (): SidebarRow<N>[] => visible.map(row => ({ type: 'single', row }));
  if (!split || split.firstTabId === split.secondTabId) return singles();
  const first = all.find(row => row.node.id === split.firstTabId);
  const second = all.find(row => row.node.id === split.secondTabId);
  const anchor = visible.find(row => row.node.id === split.firstTabId || row.node.id === split.secondTabId);
  if (!first || !second || !anchor) return singles();
  return visible.flatMap<SidebarRow<N>>(row => {
    if (row.node.id === anchor.node.id) return [{ type: 'split', first, second, depth: anchor.depth }];
    if (row.node.id === first.node.id || row.node.id === second.node.id) return [];
    return [{ type: 'single', row }];
  });
}
