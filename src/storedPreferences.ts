/** Parsers for UI preferences kept in localStorage. Each takes the raw stored string (or null). */
import { isTabPosition, type TabPosition } from './tabLayout';
import { normalizeTabNodes, type TabNode } from './tabTree';

export type Theme = 'system' | 'light' | 'dark';

/** Browser chrome accent hues, matching the macOS accent swatches, plus the system's own accent. */
export const accentColors = [
  'system',
  'blue',
  'purple',
  'pink',
  'red',
  'orange',
  'yellow',
  'green',
  'graphite',
] as const;
export type AccentColor = (typeof accentColors)[number];
/** Orange was the only accent before the setting existed, so it stays the default. */
export const defaultAccentColor: AccentColor = 'orange';
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
  sourceTabs: 'browser.sourceTabs',
  pinnedTabs: 'browser.pinnedTabs',
  theme: 'browser.theme',
  accentColor: 'browser.accentColor',
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

export function isTheme(value: unknown): value is Theme {
  return value === 'system' || value === 'light' || value === 'dark';
}

export function parseAccentColor(stored: string | null): AccentColor {
  return accentColors.find((color) => color === stored) ?? defaultAccentColor;
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
