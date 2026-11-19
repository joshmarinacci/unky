import assert from 'node:assert/strict';
import test from 'node:test';
import { shortcutForKey, shortcutFromMenu } from '../src/shortcuts.ts';

const press = (key: string, mods: { meta?: boolean; ctrl?: boolean; shift?: boolean; alt?: boolean } = {}) => ({
  key,
  metaKey: Boolean(mods.meta),
  ctrlKey: Boolean(mods.ctrl),
  shiftKey: Boolean(mods.shift),
  altKey: Boolean(mods.alt),
});

test('macOS uses Command for the shared shortcuts and ignores Ctrl versions', () => {
  assert.equal(shortcutForKey(press('t', { meta: true }), true), 'new-tab');
  assert.equal(shortcutForKey(press('T', { meta: true, shift: true }), true), 'reopen-closed-tab');
  assert.equal(shortcutForKey(press('N', { meta: true, shift: true }), true), 'new-private-tab');
  assert.equal(shortcutForKey(press('w', { meta: true }), true), 'close-tab');
  assert.equal(shortcutForKey(press('l', { meta: true }), true), 'focus-address');
  assert.equal(shortcutForKey(press('f', { meta: true }), true), 'find');
  assert.equal(shortcutForKey(press('r', { meta: true }), true), 'reload');
  assert.equal(shortcutForKey(press('t', { ctrl: true }), true), null);
  assert.equal(shortcutForKey(press('n', { meta: true }), true), null);
});

test('macOS navigation and tab-cycling variants match the menu accelerators', () => {
  assert.equal(shortcutForKey(press('[', { meta: true }), true), 'go-back');
  assert.equal(shortcutForKey(press(']', { meta: true }), true), 'go-forward');
  assert.equal(shortcutForKey(press('}', { meta: true, shift: true }), true), 'next-tab');
  assert.equal(shortcutForKey(press('{', { meta: true, shift: true }), true), 'previous-tab');
  assert.equal(shortcutForKey(press('ArrowRight', { meta: true, alt: true }), true), 'next-tab');
  assert.equal(shortcutForKey(press('ArrowLeft', { meta: true, alt: true }), true), 'previous-tab');
  assert.equal(shortcutForKey(press('Tab', { ctrl: true }), true), 'next-tab');
  assert.equal(shortcutForKey(press('Tab', { ctrl: true, shift: true }), true), 'previous-tab');
});

test('Windows and Linux use Ctrl, Alt+arrows for history and Ctrl+PageUp/PageDown for tabs', () => {
  assert.equal(shortcutForKey(press('t', { ctrl: true }), false), 'new-tab');
  assert.equal(shortcutForKey(press('t', { meta: true }), false), null);
  assert.equal(shortcutForKey(press('ArrowLeft', { alt: true }), false), 'go-back');
  assert.equal(shortcutForKey(press('ArrowRight', { alt: true }), false), 'go-forward');
  assert.equal(shortcutForKey(press('PageDown', { ctrl: true }), false), 'next-tab');
  assert.equal(shortcutForKey(press('PageUp', { ctrl: true }), false), 'previous-tab');
  assert.equal(shortcutForKey(press('[', { ctrl: true }), false), null);
});

test('plain typing and unrelated combinations are not shortcuts', () => {
  assert.equal(shortcutForKey(press('t'), true), null);
  assert.equal(shortcutForKey(press('ArrowLeft'), false), null);
  assert.equal(shortcutForKey(press('c', { meta: true }), true), null);
});

test('menu item IDs map to one action per command', () => {
  assert.equal(shortcutFromMenu('new-tab'), 'new-tab');
  assert.equal(shortcutFromMenu('next-tab-safari'), 'next-tab');
  assert.equal(shortcutFromMenu('previous-tab-page'), 'previous-tab');
  assert.equal(shortcutFromMenu('capture-full-page'), 'capture-full-page');
  assert.equal(shortcutFromMenu('unknown'), null);
});
