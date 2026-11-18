/** Parsers for UI preferences kept in localStorage. Each takes the raw stored string (or null). */
import { isTabPosition, type TabPosition } from './tabLayout';
import { normalizeTabNodes, type TabNode } from './tabTree';

export type Theme = 'system' | 'light' | 'dark';
export type SidebarSide = 'left' | 'right';

export const storageKeys = {
  sidebarWidth: 'browser.sidebarWidth',
  sidebarCollapsed: 'browser.sidebarCollapsed',
  sidebarSide: 'browser.sidebarSide',
  tabPosition: 'browser.tabPosition',
  tabTree: 'browser.tabTree',
  tabNames: 'browser.tabNames',
  historyTabs: 'browser.historyTabs',
  settingsTabs: 'browser.settingsTabs',
  pinnedTabs: 'browser.pinnedTabs',
  theme: 'browser.theme',
  customPageContextMenu: 'browser.customPageContextMenu',
  bookmarks: 'browser.bookmarks',
} as const;

export const sidebarDefaultWidth = 240;
export const sidebarMinWidth = 176;
export const sidebarMaxWidth = 360;

function parseJson(stored: string | null, fallback: string): unknown {
  try {
    return JSON.parse(stored ?? fallback);
  } catch {
    return undefined;
  }
}

export function parseSidebarWidth(stored: string | null): number {
  const saved = Number(stored);
  return stored !== null && Number.isFinite(saved) && saved >= sidebarMinWidth && saved <= sidebarMaxWidth
    ? saved
    : sidebarDefaultWidth;
}

export function parseTabPosition(stored: string | null): TabPosition {
  return isTabPosition(stored) ? stored : 'left';
}

/** A saved side wins; otherwise follow the tab strip when it is docked on the right. */
export function parseSidebarSide(stored: string | null, storedTabPosition: string | null): SidebarSide {
  if (stored === 'left' || stored === 'right') return stored;
  return parseTabPosition(storedTabPosition) === 'right' ? 'right' : 'left';
}

export const parseSidebarCollapsed = (stored: string | null): boolean => stored === 'true';

/** Defaults to enabled; only an explicit `'false'` turns the custom page context menu off. */
export const parseCustomPageContextMenu = (stored: string | null): boolean => stored !== 'false';

export function parseTheme(stored: string | null): Theme {
  return stored === 'light' || stored === 'dark' ? stored : 'system';
}

export function parseTabNodes(stored: string | null): TabNode[] {
  return normalizeTabNodes(parseJson(stored, '[]'));
}

export function parseStringArray(stored: string | null): string[] {
  const value = parseJson(stored, '[]');
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];
}

export function parseStringRecord(stored: string | null): Record<string, string> {
  const value = parseJson(stored, '{}');
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
}
