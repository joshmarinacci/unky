import { expect, test } from 'vitest';
import { tabTreeReducer } from '../src/tabTreeState.ts';
import type { TabFolder, TabNode } from '../src/tabTree.ts';

const tab = (id: string): TabNode => ({ id, type: 'tab' });
const folder = (id: string, children: TabNode[] = [], collapsed = false): TabFolder => ({
  id,
  type: 'folder',
  title: id,
  collapsed,
  children,
});

test('creating a folder puts it first', () => {
  expect(tabTreeReducer([tab('a')], { type: 'folderCreated', folder: folder('f') })).toStrictEqual([
    folder('f'),
    tab('a'),
  ]);
});

test('renaming, toggling and expanding affect only folders', () => {
  const nodes = [folder('f', [], true), tab('a')];
  expect((tabTreeReducer(nodes, { type: 'folderRenamed', id: 'f', title: 'Work' })[0] as TabFolder).title).toBe('Work');
  expect((tabTreeReducer(nodes, { type: 'folderToggled', id: 'f' })[0] as TabFolder).collapsed).toBe(false);
  expect((tabTreeReducer(nodes, { type: 'folderExpanded', id: 'f' })[0] as TabFolder).collapsed).toBe(false);
  expect(tabTreeReducer(nodes, { type: 'folderToggled', id: 'a' })).toStrictEqual(nodes);
});

test('unwrapping a folder keeps its tabs in place, and a missing folder changes nothing', () => {
  const nodes = [tab('a'), folder('f', [tab('b'), tab('c')]), tab('d')];
  expect(tabTreeReducer(nodes, { type: 'folderUnwrapped', id: 'f' })).toStrictEqual([
    tab('a'),
    tab('b'),
    tab('c'),
    tab('d'),
  ]);
  expect(tabTreeReducer(nodes, { type: 'folderUnwrapped', id: 'missing' })).toBe(nodes);
});

test('dropping a tab inside a collapsed folder moves it there and expands the folder', () => {
  const next = tabTreeReducer([tab('a'), folder('f', [], true)], {
    type: 'dropped',
    activeId: 'a',
    overId: 'f',
    zone: 'inside',
    originDepth: 0,
    indentDelta: 0,
  });
  expect(next).toStrictEqual([folder('f', [tab('a')])]);
});

test('moving next to a target, into a folder, or to the end', () => {
  const nodes = [tab('a'), tab('b'), folder('f', [], true)];
  expect(tabTreeReducer(nodes, { type: 'moved', id: 'a', targetId: 'b', position: 'after' })).toStrictEqual([
    tab('b'),
    tab('a'),
    folder('f', [], true),
  ]);
  expect(tabTreeReducer(nodes, { type: 'moved', id: 'a', folderId: 'f' })).toStrictEqual([
    tab('b'),
    folder('f', [tab('a')]),
  ]);
  expect(tabTreeReducer(nodes, { type: 'moved', id: 'a' })).toStrictEqual([tab('b'), folder('f', [], true), tab('a')]);
});

test('moves that make no sense return the same tree', () => {
  const nodes = [folder('f', [folder('g')]), tab('a')];
  expect(tabTreeReducer(nodes, { type: 'moved', id: 'a', targetId: 'a' })).toBe(nodes);
  expect(tabTreeReducer(nodes, { type: 'moved', id: 'missing', targetId: 'a' })).toBe(nodes);
  expect(tabTreeReducer(nodes, { type: 'moved', id: 'f', folderId: 'g' })).toBe(nodes);
});

test('wrapping a tab in a new folder keeps its place, even inside another folder', () => {
  const group = folder('g');
  expect(
    tabTreeReducer([tab('a'), tab('b'), tab('c')], { type: 'tabWrappedInFolder', tabId: 'b', folder: group }),
  ).toStrictEqual([tab('a'), folder('g', [tab('b')]), tab('c')]);
  expect(
    tabTreeReducer([folder('outer', [tab('a'), tab('b')])], { type: 'tabWrappedInFolder', tabId: 'b', folder: group }),
  ).toStrictEqual([folder('outer', [tab('a'), folder('g', [tab('b')])])]);
});

test('wrapping a folder or a missing tab changes nothing', () => {
  const nodes = [folder('f', [tab('a')]), tab('b')];
  expect(tabTreeReducer(nodes, { type: 'tabWrappedInFolder', tabId: 'f', folder: folder('g') })).toBe(nodes);
  expect(tabTreeReducer(nodes, { type: 'tabWrappedInFolder', tabId: 'zz', folder: folder('g') })).toBe(nodes);
});
