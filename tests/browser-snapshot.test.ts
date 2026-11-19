import { expect, test } from 'vitest';
import { snapshotBelongsToWindow } from '../src/browserSnapshot';

test('a browser window ignores another window’s tab snapshot', () => {
  expect(snapshotBelongsToWindow([{ windowLabel: 'browser-window-1' }], 'main')).toBe(false);
  expect(snapshotBelongsToWindow([{ windowLabel: 'main' }, { windowLabel: 'browser-window-1' }], 'main')).toBe(false);
  expect(snapshotBelongsToWindow([{ windowLabel: 'main' }], 'main')).toBe(true);
  expect(snapshotBelongsToWindow([], 'main')).toBe(true);
});
