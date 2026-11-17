import assert from 'node:assert/strict';
import test from 'node:test';
import {
  findAddressSuggestions,
  initialAddressSuggestions,
  moveAddressSuggestionSelection,
} from '../src/addressSuggestions.ts';
import type { BookmarkNode } from '../src/bookmarkTree.ts';

const bookmarks: BookmarkNode[] = [
  { id: 'one', type: 'bookmark', title: 'Hacker News', url: 'https://news.ycombinator.com/' },
  {
    id: 'folder',
    type: 'folder',
    title: 'Reading',
    children: [{ id: 'two', type: 'bookmark', title: '', url: 'https://news.example.com/archive' }],
  },
];
const history = [
  { title: 'Visited copy', url: 'https://news.ycombinator.com/' },
  { title: 'Latest NEWS', url: 'https://example.com/latest' },
  { title: 'Unrelated page', url: 'https://example.com/other' },
];

test('autocomplete matches nested bookmarks and history by title or URL, ignoring case and surrounding spaces', () => {
  assert.deepEqual(findAddressSuggestions('  NeWs  ', bookmarks, history), [
    { title: 'Hacker News', url: 'https://news.ycombinator.com/', source: 'Bookmark' },
    { title: 'https://news.example.com/archive', url: 'https://news.example.com/archive', source: 'Bookmark' },
    { title: 'Latest NEWS', url: 'https://example.com/latest', source: 'History' },
  ]);
  assert.deepEqual(findAddressSuggestions('  ', bookmarks, history), []);
});

test('autocomplete keeps bookmark priority for duplicate URLs and limits the popup to eight results', () => {
  const manyBookmarks: BookmarkNode[] = Array.from({ length: 9 }, (_, index) => ({
    id: String(index),
    type: 'bookmark',
    title: `Result ${index}`,
    url: `https://example.com/${index}`,
  }));
  const matches = findAddressSuggestions('example.com', manyBookmarks, [
    { title: 'Duplicate', url: 'https://example.com/0' },
    { title: 'History result', url: 'https://example.com/history' },
  ]);
  assert.equal(matches.length, 8);
  assert.deepEqual(
    matches.map((match) => match.url),
    Array.from({ length: 8 }, (_, index) => `https://example.com/${index}`),
  );
  assert.ok(matches.every((match) => match.source === 'Bookmark'));
});

test('arrow selection wraps at both ends of the popup', () => {
  assert.equal(moveAddressSuggestionSelection(2, 3, 1), 0);
  assert.equal(moveAddressSuggestionSelection(0, 3, -1), 2);
  assert.equal(moveAddressSuggestionSelection(1, 3, 1), 2);
  assert.equal(moveAddressSuggestionSelection(0, 0, 1), 0);
});

test('popup restores its initial rows and falls back to empty state for invalid JSON', () => {
  const state = {
    rows: [{ title: 'Hacker News', url: 'https://news.ycombinator.com/', source: 'Bookmark' as const }],
    selectedIndex: 0,
  };
  const params = new URLSearchParams({ initial: JSON.stringify(state) });
  assert.deepEqual(initialAddressSuggestions(`?${params}`), state);
  assert.deepEqual(initialAddressSuggestions('?initial=invalid'), { rows: [], selectedIndex: 0 });
  assert.deepEqual(initialAddressSuggestions(''), { rows: [], selectedIndex: 0 });
});
