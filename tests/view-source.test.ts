import { expect, test } from 'vitest';
import { canViewSource, sourceTabTitle, sourceTabUrl, viewSourceUrl } from '../src/viewSource.ts';

test('source tabs show a view-source: address for the page they came from', () => {
  expect(viewSourceUrl('https://example.com/a?b=1')).toBe('view-source:https://example.com/a?b=1');
  expect(sourceTabUrl({ status: 'loading', url: 'https://example.com/' })).toBe('https://example.com/');
  expect(sourceTabUrl({ status: 'ready', page: { url: 'https://example.com/x', source: '<p>', original: true } })).toBe(
    'https://example.com/x',
  );
});

test('source tab names use the page title, then the host, then the address', () => {
  expect(sourceTabTitle('Example Domain', 'https://example.com/')).toBe('Source of Example Domain');
  expect(sourceTabTitle('  ', 'https://example.com/path')).toBe('Source of example.com');
  expect(sourceTabTitle('', 'not a url')).toBe('Source of not a url');
});

test('only web and file pages have source to view', () => {
  expect(canViewSource('https://example.com/')).toBe(true);
  expect(canViewSource('http://127.0.0.1:4179/index.html')).toBe(true);
  expect(canViewSource('file:///Users/me/page.html')).toBe(true);
  expect(canViewSource('')).toBe(false);
  expect(canViewSource(undefined)).toBe(false);
  expect(canViewSource('about:blank')).toBe(false);
});
