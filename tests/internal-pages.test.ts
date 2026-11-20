import { expect, test } from 'vitest';
import { internalPageUrl, parseInternalPageUrl } from '../src/internalPages.ts';

test('built-in pages have unky:// addresses', () => {
  expect(internalPageUrl('settings')).toBe('unky://settings');
  expect(internalPageUrl('history')).toBe('unky://history');
  expect(internalPageUrl('downloads')).toBe('unky://downloads');
  expect(internalPageUrl('shortcuts')).toBe('unky://shortcuts');
  expect(internalPageUrl('bookmarks')).toBe('unky://bookmarks');
});

test('addresses round-trip and accept common spellings', () => {
  for (const page of ['settings', 'history', 'downloads', 'shortcuts', 'bookmarks'] as const)
    expect(parseInternalPageUrl(internalPageUrl(page))).toBe(page);
  expect(parseInternalPageUrl('  UNKY://Settings/ ')).toBe('settings');
  expect(parseInternalPageUrl('unky:history')).toBe('history');
});

test('other addresses are not built-in pages', () => {
  expect(parseInternalPageUrl('unky://nope')).toBeNull();
  expect(parseInternalPageUrl('unky://settings/extra')).toBeNull();
  expect(parseInternalPageUrl('https://unky.example/settings')).toBeNull();
  expect(parseInternalPageUrl('settings')).toBeNull();
  expect(parseInternalPageUrl('')).toBeNull();
});
