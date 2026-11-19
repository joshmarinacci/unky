import assert from 'node:assert/strict';
import test from 'node:test';
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
  assert.deepEqual(tabTreeReducer([tab('a')], { type: 'folderCreated', folder: folder('f') }), [folder('f'), tab('a')]);
});

test('renaming, toggling and expanding affect only folders', () => {
  const nodes = [folder('f', [], true), tab('a')];
  assert.equal(
    (tabTreeReducer(nodes, { type: 'folderRenamed', id: 'f', title: 'Work' })[0] as TabFolder).title,
    'Work',
  );
  assert.equal((tabTreeReducer(nodes, { type: 'folderToggled', id: 'f' })[0] as TabFolder).collapsed, false);
  assert.equal((tabTreeReducer(nodes, { type: 'folderExpanded', id: 'f' })[0] as TabFolder).collapsed, false);
  assert.deepEqual(tabTreeReducer(nodes, { type: 'folderToggled', id: 'a' }), nodes);
});

test('unwrapping a folder keeps its tabs in place, and a missing folder changes nothing', () => {
  const nodes = [tab('a'), folder('f', [tab('b'), tab('c')]), tab('d')];
  assert.deepEqual(tabTreeReducer(nodes, { type: 'folderUnwrapped', id: 'f' }), [
    tab('a'),
    tab('b'),
    tab('c'),
    tab('d'),
  ]);
  assert.equal(tabTreeReducer(nodes, { type: 'folderUnwrapped', id: 'missing' }), nodes);
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
  assert.deepEqual(next, [folder('f', [tab('a')])]);
});

test('moving next to a target, into a folder, or to the end', () => {
  const nodes = [tab('a'), tab('b'), folder('f', [], true)];
  assert.deepEqual(tabTreeReducer(nodes, { type: 'moved', id: 'a', targetId: 'b', position: 'after' }), [
    tab('b'),
    tab('a'),
    folder('f', [], true),
  ]);
  assert.deepEqual(tabTreeReducer(nodes, { type: 'moved', id: 'a', folderId: 'f' }), [
    tab('b'),
    folder('f', [tab('a')]),
  ]);
  assert.deepEqual(tabTreeReducer(nodes, { type: 'moved', id: 'a' }), [tab('b'), folder('f', [], true), tab('a')]);
});

test('moves that make no sense return the same tree', () => {
  const nodes = [folder('f', [folder('g')]), tab('a')];
  assert.equal(tabTreeReducer(nodes, { type: 'moved', id: 'a', targetId: 'a' }), nodes);
  assert.equal(tabTreeReducer(nodes, { type: 'moved', id: 'missing', targetId: 'a' }), nodes);
  assert.equal(tabTreeReducer(nodes, { type: 'moved', id: 'f', folderId: 'g' }), nodes);
});
