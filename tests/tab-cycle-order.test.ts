import { expect, test } from 'vitest';
import {
  nextVisibleTab,
  tabAtShortcutPosition,
  tabCycleOrder,
  visibleTabCycleOrder,
  type TabFolder,
  type TabNode,
} from '../src/tabTree.ts';

const tab = (id: string): TabNode => ({ id, type: 'tab' });
const folder = (id: string, children: TabNode[], collapsed = false): TabFolder => ({
  id,
  type: 'folder',
  title: id,
  collapsed,
  children,
});
const open = (...ids: string[]) => new Set(ids);

test('follows the tree, including tabs inside folders and collapsed folders', () => {
  const nodes = [tab('a'), folder('f', [tab('b'), folder('g', [tab('c')], true)]), tab('d')];
  expect(tabCycleOrder(nodes, [], open('a', 'b', 'c', 'd'), null)).toStrictEqual(['a', 'b', 'c', 'd']);
});

test('pinned tabs come first, in pinned order, and are not repeated from the tree', () => {
  const nodes = [tab('a'), tab('b'), tab('c')];
  expect(tabCycleOrder(nodes, ['c', 'a'], open('a', 'b', 'c'), null)).toStrictEqual(['c', 'a', 'b']);
});

test('a split pair stays together where the sidebar shows it (regression: cycling jumped out of order)', () => {
  // The split row is drawn at the first of the two tabs in the tree, with firstTabId on the left.
  const nodes = [tab('a'), tab('b'), tab('c'), tab('d')];
  expect(tabCycleOrder(nodes, [], open('a', 'b', 'c', 'd'), { firstTabId: 'd', secondTabId: 'b' })).toStrictEqual([
    'a',
    'd',
    'b',
    'c',
  ]);
});

test('a split with a pinned tab is not grouped, and tabs from other windows are skipped', () => {
  const nodes = [tab('a'), tab('b'), tab('c')];
  expect(tabCycleOrder(nodes, ['c'], open('a', 'b', 'c'), { firstTabId: 'c', secondTabId: 'a' })).toStrictEqual([
    'c',
    'a',
    'b',
  ]);
  expect(tabCycleOrder(nodes, ['zz'], open('a', 'c'), null)).toStrictEqual(['a', 'c']);
});

test('⌘1–⌘8 pick by position and ⌘9 picks the last tab', () => {
  const order = ['a', 'b', 'c'];
  expect(tabAtShortcutPosition(order, 1)).toBe('a');
  expect(tabAtShortcutPosition(order, 3)).toBe('c');
  expect(tabAtShortcutPosition(order, 5)).toBeUndefined();
  expect(tabAtShortcutPosition(order, 'last')).toBe('c');
  expect(tabAtShortcutPosition([], 'last')).toBeUndefined();
});

test('the visible order skips tabs inside collapsed folders, including nested ones', () => {
  const nodes = [tab('a'), folder('f', [tab('b'), folder('g', [tab('c')])], true), tab('d'), folder('h', [tab('e')])];
  expect(visibleTabCycleOrder(nodes, [], open('a', 'b', 'c', 'd', 'e'), null)).toStrictEqual(['a', 'd', 'e']);
  const nested = [folder('f', [tab('b'), folder('g', [tab('c')], true)]), tab('d')];
  expect(visibleTabCycleOrder(nested, [], open('b', 'c', 'd'), null)).toStrictEqual(['b', 'd']);
});

test('pinned tabs and a visible split pair stay in the visible order', () => {
  // 'b' is pinned out of the collapsed folder; 'c' is split with visible 'd', so the pair row shows both.
  const nodes = [folder('f', [tab('b'), tab('c'), tab('x')], true), tab('d')];
  expect(
    visibleTabCycleOrder(nodes, ['b'], open('b', 'c', 'd', 'x'), { firstTabId: 'd', secondTabId: 'c' }),
  ).toStrictEqual(['b', 'd', 'c']);
});

test('next/previous tab skips tabs in collapsed folders and wraps around', () => {
  const full = ['a', 'b', 'c', 'd'];
  const visible = ['a', 'd']; // b and c are in a collapsed folder
  expect(nextVisibleTab(full, visible, 'a', false)).toBe('d');
  expect(nextVisibleTab(full, visible, 'd', false)).toBe('a');
  expect(nextVisibleTab(full, visible, 'a', true)).toBe('d');
  expect(nextVisibleTab(full, visible, 'd', true)).toBe('a');
});

test('cycling from a hidden active tab continues from where it sits in the tree', () => {
  const full = ['a', 'b', 'c', 'd'];
  expect(nextVisibleTab(full, ['a', 'd'], 'b', false)).toBe('d');
  expect(nextVisibleTab(full, ['a', 'd'], 'c', true)).toBe('a');
});

test('cycling does nothing when the active tab is the only visible one', () => {
  expect(nextVisibleTab(['a', 'b'], ['a'], 'a', false)).toBeUndefined();
  expect(nextVisibleTab(['a', 'b'], [], 'b', false)).toBeUndefined();
  expect(nextVisibleTab(['a', 'b'], ['a', 'b'], null, true)).toBe('b');
});
