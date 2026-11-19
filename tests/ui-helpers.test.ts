import { expect, test } from 'vitest';
import { filterSiteDomain, siteDomain } from '../src/siteDomain.ts';
import { isContextMenuKey, rovingTabStop } from '../src/tabUiActions.ts';

test('site domain is the host of http and https pages only', () => {
  expect(siteDomain('https://news.example.com/a?b=1')).toBe('news.example.com');
  expect(siteDomain('http://127.0.0.1:4179/')).toBe('127.0.0.1');
  expect(siteDomain('')).toBe('');
  expect(siteDomain(undefined)).toBe('');
  expect(siteDomain('about:blank')).toBe('');
  expect(siteDomain('file:///Users/me/page.html')).toBe('');
  expect(siteDomain('not a url')).toBe('');
});

test('the filter site falls back to the tab Settings was opened from, only while Settings shows', () => {
  expect(filterSiteDomain('https://a.example/', false, 'https://b.example/')).toBe('a.example');
  expect(filterSiteDomain('', true, 'https://b.example/')).toBe('b.example');
  expect(filterSiteDomain('', false, 'https://b.example/')).toBe('');
  expect(filterSiteDomain('', true, undefined)).toBe('');
});

test('the Menu key and Shift+F10 open a context menu; plain F10 does not', () => {
  expect(isContextMenuKey({ key: 'ContextMenu', shiftKey: false })).toBe(true);
  expect(isContextMenuKey({ key: 'F10', shiftKey: true })).toBe(true);
  expect(isContextMenuKey({ key: 'F10', shiftKey: false })).toBe(false);
  expect(isContextMenuKey({ key: 'Enter', shiftKey: true })).toBe(false);
});

test('a tree keeps one tab stop: the first preferred row still shown, else the first row', () => {
  expect(rovingTabStop(['a', 'b', 'c'], 'b', 'c')).toBe('b');
  expect(rovingTabStop(['a', 'b', 'c'], 'gone', 'c')).toBe('c');
  expect(rovingTabStop(['a', 'b', 'c'], '', 'gone')).toBe('a');
  expect(rovingTabStop([], 'a')).toBe('');
});
