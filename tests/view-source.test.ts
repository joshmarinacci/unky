import { expect, test } from 'vitest';
import {
  canViewSource,
  parseStoredSourceTabs,
  serializeSourceTabs,
  sourceTabTitle,
  sourceTabUrl,
  viewSourceUrl,
} from '../src/viewSource.ts';

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

test('source tabs save only their addresses and come back loading', () => {
  const saved = serializeSourceTabs({
    a: { status: 'ready', page: { url: 'https://example.com/', source: '<html>secret</html>', original: true } },
    b: { status: 'error', url: 'http://example.org/', message: 'offline' },
  });
  expect(saved).not.toContain('secret');
  expect(parseStoredSourceTabs(saved)).toEqual({
    a: { status: 'loading', url: 'https://example.com/' },
    b: { status: 'loading', url: 'http://example.org/' },
  });
});

test('saved source tabs ignore bad data and pages that cannot be downloaded again', () => {
  expect(parseStoredSourceTabs(null)).toEqual({});
  expect(parseStoredSourceTabs('not json')).toEqual({});
  expect(parseStoredSourceTabs('["https://example.com/"]')).toEqual({});
  expect(parseStoredSourceTabs('{"a":"file:///tmp/x.html","b":3,"c":"javascript:alert(1)"}')).toEqual({});
});
