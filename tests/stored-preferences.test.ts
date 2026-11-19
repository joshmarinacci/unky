import { expect, test } from 'vitest';
import {
  parseCustomPageContextMenu,
  parseSidebarCollapsed,
  parseSidebarSide,
  parseSidebarWidth,
  parseStringArray,
  parseStringRecord,
  parseTabNodes,
  parseTabPosition,
  parseTheme,
  sidebarDefaultWidth,
  sidebarMaxWidth,
  sidebarMinWidth,
} from '../src/storedPreferences.ts';

test('sidebar width keeps saved values in range and falls back otherwise', () => {
  expect(parseSidebarWidth('300')).toBe(300);
  expect(parseSidebarWidth(String(sidebarMinWidth))).toBe(sidebarMinWidth);
  expect(parseSidebarWidth(String(sidebarMaxWidth))).toBe(sidebarMaxWidth);
  for (const stored of [null, '', 'wide', '10', '9999', 'NaN'])
    expect(parseSidebarWidth(stored)).toBe(sidebarDefaultWidth);
});

test('tab position, theme, and booleans fall back to their defaults', () => {
  expect(parseTabPosition('top')).toBe('top');
  expect(parseTabPosition('diagonal')).toBe('left');
  expect(parseTabPosition(null)).toBe('left');
  expect(parseTheme('dark')).toBe('dark');
  expect(parseTheme('neon')).toBe('system');
  expect(parseSidebarCollapsed('true')).toBe(true);
  expect(parseSidebarCollapsed(null)).toBe(false);
  expect(parseCustomPageContextMenu(null), 'the custom menu defaults on').toBe(true);
  expect(parseCustomPageContextMenu('false')).toBe(false);
});

test('sidebar side uses its saved value, else follows a right-docked tab strip', () => {
  expect(parseSidebarSide('right', 'left')).toBe('right');
  expect(parseSidebarSide(null, 'right')).toBe('right');
  expect(parseSidebarSide(null, 'top')).toBe('left');
  expect(parseSidebarSide('middle', null)).toBe('left');
});

test('JSON preferences survive corrupt or mistyped storage', () => {
  expect(parseStringArray('["a", 2, "b"]')).toStrictEqual(['a', 'b']);
  expect(parseStringArray('{not json')).toStrictEqual([]);
  expect(parseStringArray('{"a": 1}')).toStrictEqual([]);
  expect(parseStringRecord('{"tab-1": "Mail", "tab-2": 3}')).toStrictEqual({ 'tab-1': 'Mail' });
  expect(parseStringRecord('["x"]')).toStrictEqual({});
  expect(parseStringRecord(null)).toStrictEqual({});
  expect(parseTabNodes('[{"id":"tab-1","type":"tab"}]')).toStrictEqual([{ id: 'tab-1', type: 'tab' }]);
  expect(parseTabNodes('oops')).toStrictEqual([]);
});
