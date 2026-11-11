export const TAB_POSITIONS = ['left', 'right', 'top', 'bottom'] as const;
export type TabPosition = (typeof TAB_POSITIONS)[number];
export type TabAxis = 'horizontal' | 'vertical';

export function isTabPosition(value: unknown): value is TabPosition {
  return typeof value === 'string' && TAB_POSITIONS.includes(value as TabPosition);
}

export function tabAxisForPosition(position: TabPosition): TabAxis {
  return position === 'top' || position === 'bottom' ? 'horizontal' : 'vertical';
}

export function resolveTabDragPreview(isFolder: boolean, overPage: boolean): 'split' | 'invalid' | null {
  if (!overPage) return null;
  return isFolder ? 'invalid' : 'split';
}

export function reorderTabIds(ids: string[], activeId: string, overId: string | null, after: boolean): string[] {
  if (!ids.includes(activeId) || activeId === overId) return ids;
  const remaining = ids.filter(id => id !== activeId);
  if (overId === null) return [...remaining, activeId];
  const index = remaining.indexOf(overId);
  if (index < 0) return ids;
  remaining.splice(index + Number(after), 0, activeId);
  return remaining;
}
