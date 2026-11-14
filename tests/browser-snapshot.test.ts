import assert from 'node:assert/strict';
import test from 'node:test';
import { snapshotBelongsToWindow } from '../src/browserSnapshot';

test('a browser window ignores another window’s tab snapshot', () => {
  assert.equal(snapshotBelongsToWindow([{ windowLabel: 'browser-window-1' }], 'main'), false);
  assert.equal(snapshotBelongsToWindow([{ windowLabel: 'main' }, { windowLabel: 'browser-window-1' }], 'main'), false);
  assert.equal(snapshotBelongsToWindow([{ windowLabel: 'main' }], 'main'), true);
  assert.equal(snapshotBelongsToWindow([], 'main'), true);
});
