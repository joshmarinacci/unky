import assert from 'node:assert/strict';
import test from 'node:test';
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
  assert.equal(parseSidebarWidth('300'), 300);
  assert.equal(parseSidebarWidth(String(sidebarMinWidth)), sidebarMinWidth);
  assert.equal(parseSidebarWidth(String(sidebarMaxWidth)), sidebarMaxWidth);
  for (const stored of [null, '', 'wide', '10', '9999', 'NaN'])
    assert.equal(parseSidebarWidth(stored), sidebarDefaultWidth);
});

test('tab position, theme, and booleans fall back to their defaults', () => {
  assert.equal(parseTabPosition('top'), 'top');
  assert.equal(parseTabPosition('diagonal'), 'left');
  assert.equal(parseTabPosition(null), 'left');
  assert.equal(parseTheme('dark'), 'dark');
  assert.equal(parseTheme('neon'), 'system');
  assert.equal(parseSidebarCollapsed('true'), true);
  assert.equal(parseSidebarCollapsed(null), false);
  assert.equal(parseCustomPageContextMenu(null), true, 'the custom menu defaults on');
  assert.equal(parseCustomPageContextMenu('false'), false);
});

test('sidebar side uses its saved value, else follows a right-docked tab strip', () => {
  assert.equal(parseSidebarSide('right', 'left'), 'right');
  assert.equal(parseSidebarSide(null, 'right'), 'right');
  assert.equal(parseSidebarSide(null, 'top'), 'left');
  assert.equal(parseSidebarSide('middle', null), 'left');
});

test('JSON preferences survive corrupt or mistyped storage', () => {
  assert.deepEqual(parseStringArray('["a", 2, "b"]'), ['a', 'b']);
  assert.deepEqual(parseStringArray('{not json'), []);
  assert.deepEqual(parseStringArray('{"a": 1}'), []);
  assert.deepEqual(parseStringRecord('{"tab-1": "Mail", "tab-2": 3}'), { 'tab-1': 'Mail' });
  assert.deepEqual(parseStringRecord('["x"]'), {});
  assert.deepEqual(parseStringRecord(null), {});
  assert.deepEqual(parseTabNodes('[{"id":"tab-1","type":"tab"}]'), [{ id: 'tab-1', type: 'tab' }]);
  assert.deepEqual(parseTabNodes('oops'), []);
});
