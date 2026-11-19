import assert from 'node:assert/strict';
import test from 'node:test';
import { filterSiteDomain, siteDomain } from '../src/siteDomain.ts';
import { isContextMenuKey } from '../src/tabUiActions.ts';

test('site domain is the host of http and https pages only', () => {
  assert.equal(siteDomain('https://news.example.com/a?b=1'), 'news.example.com');
  assert.equal(siteDomain('http://127.0.0.1:4179/'), '127.0.0.1');
  assert.equal(siteDomain(''), '');
  assert.equal(siteDomain(undefined), '');
  assert.equal(siteDomain('about:blank'), '');
  assert.equal(siteDomain('file:///Users/me/page.html'), '');
  assert.equal(siteDomain('not a url'), '');
});

test('the filter site falls back to the tab Settings was opened from, only while Settings shows', () => {
  assert.equal(filterSiteDomain('https://a.example/', false, 'https://b.example/'), 'a.example');
  assert.equal(filterSiteDomain('', true, 'https://b.example/'), 'b.example');
  assert.equal(filterSiteDomain('', false, 'https://b.example/'), '');
  assert.equal(filterSiteDomain('', true, undefined), '');
});

test('the Menu key and Shift+F10 open a context menu; plain F10 does not', () => {
  assert.equal(isContextMenuKey({ key: 'ContextMenu', shiftKey: false }), true);
  assert.equal(isContextMenuKey({ key: 'F10', shiftKey: true }), true);
  assert.equal(isContextMenuKey({ key: 'F10', shiftKey: false }), false);
  assert.equal(isContextMenuKey({ key: 'Enter', shiftKey: true }), false);
});
