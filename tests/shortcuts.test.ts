import { expect, test } from 'vitest';
import { shortcutForKey, shortcutFromMenu } from '../src/shortcuts.ts';

const press = (key: string, mods: { meta?: boolean; ctrl?: boolean; shift?: boolean; alt?: boolean } = {}) => ({
  key,
  metaKey: Boolean(mods.meta),
  ctrlKey: Boolean(mods.ctrl),
  shiftKey: Boolean(mods.shift),
  altKey: Boolean(mods.alt),
});

test('macOS uses Command for the shared shortcuts and ignores Ctrl versions', () => {
  expect(shortcutForKey(press('t', { meta: true }), true)).toBe('new-tab');
  expect(shortcutForKey(press('T', { meta: true, shift: true }), true)).toBe('reopen-closed-tab');
  expect(shortcutForKey(press('N', { meta: true, shift: true }), true)).toBe('new-private-tab');
  expect(shortcutForKey(press('w', { meta: true }), true)).toBe('close-tab');
  expect(shortcutForKey(press('l', { meta: true }), true)).toBe('focus-address');
  expect(shortcutForKey(press('f', { meta: true }), true)).toBe('find');
  expect(shortcutForKey(press('r', { meta: true }), true)).toBe('reload');
  expect(shortcutForKey(press('t', { ctrl: true }), true)).toBe(null);
  expect(shortcutForKey(press('n', { ctrl: true }), true)).toBe(null);
});

test('macOS navigation and tab-cycling variants match the menu accelerators', () => {
  expect(shortcutForKey(press('[', { meta: true }), true)).toBe('go-back');
  expect(shortcutForKey(press(']', { meta: true }), true)).toBe('go-forward');
  expect(shortcutForKey(press('}', { meta: true, shift: true }), true)).toBe('next-tab');
  expect(shortcutForKey(press('{', { meta: true, shift: true }), true)).toBe('previous-tab');
  expect(shortcutForKey(press('ArrowRight', { meta: true, alt: true }), true)).toBe('next-tab');
  expect(shortcutForKey(press('ArrowLeft', { meta: true, alt: true }), true)).toBe('previous-tab');
  expect(shortcutForKey(press('Tab', { ctrl: true }), true)).toBe('next-tab');
  expect(shortcutForKey(press('Tab', { ctrl: true, shift: true }), true)).toBe('previous-tab');
});

test('Windows and Linux use Ctrl, Alt+arrows for history and Ctrl+PageUp/PageDown for tabs', () => {
  expect(shortcutForKey(press('t', { ctrl: true }), false)).toBe('new-tab');
  expect(shortcutForKey(press('t', { meta: true }), false)).toBe(null);
  expect(shortcutForKey(press('ArrowLeft', { alt: true }), false)).toBe('go-back');
  expect(shortcutForKey(press('ArrowRight', { alt: true }), false)).toBe('go-forward');
  expect(shortcutForKey(press('PageDown', { ctrl: true }), false)).toBe('next-tab');
  expect(shortcutForKey(press('PageUp', { ctrl: true }), false)).toBe('previous-tab');
  expect(shortcutForKey(press('[', { ctrl: true }), false)).toBe(null);
});

test('plain typing and unrelated combinations are not shortcuts', () => {
  expect(shortcutForKey(press('t'), true)).toBe(null);
  expect(shortcutForKey(press('ArrowLeft'), false)).toBe(null);
  expect(shortcutForKey(press('c', { meta: true }), true)).toBe(null);
});

test('menu item IDs map to one action per command', () => {
  expect(shortcutFromMenu('new-tab')).toBe('new-tab');
  expect(shortcutFromMenu('next-tab-safari')).toBe('next-tab');
  expect(shortcutFromMenu('previous-tab-page')).toBe('previous-tab');
  expect(shortcutFromMenu('capture-full-page')).toBe('capture-full-page');
  expect(shortcutFromMenu('unknown')).toBe(null);
});

test('Command+1–9 select tabs, Command+. stops loading on macOS', () => {
  expect(shortcutForKey(press('1', { meta: true }), true)).toBe('select-tab-1');
  expect(shortcutForKey(press('8', { meta: true }), true)).toBe('select-tab-8');
  expect(shortcutForKey(press('9', { meta: true }), true)).toBe('select-last-tab');
  expect(shortcutForKey(press('0', { meta: true }), true)).toBe(null);
  expect(shortcutForKey(press('.', { meta: true }), true)).toBe('stop-loading');
  expect(shortcutForKey(press('1', { ctrl: true }), false)).toBe('select-tab-1');
  expect(shortcutForKey(press('9', { ctrl: true }), false)).toBe('select-last-tab');
  expect(shortcutForKey(press('.', { ctrl: true }), false)).toBe(null);
  expect(shortcutForKey(press('1', { meta: true, shift: true }), true)).toBe(null);
});

test('the new menu items map to their shortcuts', () => {
  expect(shortcutFromMenu('select-tab-3')).toBe('select-tab-3');
  expect(shortcutFromMenu('select-last-tab')).toBe('select-last-tab');
  expect(shortcutFromMenu('stop-loading')).toBe('stop-loading');
  expect(shortcutFromMenu('select-tab-9')).toBe(null);
});

test('window, find, bookmark, sidebar and print shortcuts match Safari and Chrome on macOS', () => {
  expect(shortcutForKey(press('n', { meta: true }), true)).toBe('new-window');
  expect(shortcutForKey(press('W', { meta: true, shift: true }), true)).toBe('close-window');
  expect(shortcutForKey(press('d', { meta: true }), true)).toBe('bookmark-page');
  expect(shortcutForKey(press('g', { meta: true }), true)).toBe('find-next');
  expect(shortcutForKey(press('G', { meta: true, shift: true }), true)).toBe('find-previous');
  expect(shortcutForKey(press('R', { meta: true, shift: true }), true)).toBe('reload-ignoring-cache');
  expect(shortcutForKey(press('L', { meta: true, shift: true }), true)).toBe('toggle-sidebar');
  expect(shortcutForKey(press('p', { meta: true }), true)).toBe('print');
  // ⌥⌘R and ⌥⌘I are left to their native menu items, since Option changes event.key.
  expect(shortcutForKey(press('®', { meta: true, alt: true }), true)).toBe(null);
  expect(shortcutForKey(press('I', { meta: true, shift: true }), true)).toBe(null);
});

test('Windows and Linux use Ctrl for the same commands, plus Ctrl+F5 and Ctrl+Shift+I', () => {
  expect(shortcutForKey(press('n', { ctrl: true }), false)).toBe('new-window');
  expect(shortcutForKey(press('W', { ctrl: true, shift: true }), false)).toBe('close-window');
  expect(shortcutForKey(press('d', { ctrl: true }), false)).toBe('bookmark-page');
  expect(shortcutForKey(press('G', { ctrl: true, shift: true }), false)).toBe('find-previous');
  expect(shortcutForKey(press('F5', { ctrl: true }), false)).toBe('reload-ignoring-cache');
  expect(shortcutForKey(press('I', { ctrl: true, shift: true }), false)).toBe('toggle-devtools');
  expect(shortcutForKey(press('p', { ctrl: true }), false)).toBe('print');
});

test('menu items for the added shortcuts map to their actions', () => {
  for (const id of [
    'new-window',
    'close-window',
    'bookmark-page',
    'find-next',
    'find-previous',
    'toggle-sidebar',
    'toggle-devtools',
    'print',
  ]) {
    expect(shortcutFromMenu(id)).toBe(id);
  }
  expect(shortcutFromMenu('reload-ignoring-cache')).toBe('reload-ignoring-cache');
  expect(shortcutFromMenu('reload-ignoring-cache-safari')).toBe('reload-ignoring-cache');
});
