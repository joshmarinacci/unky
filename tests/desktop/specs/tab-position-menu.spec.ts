import assert from 'node:assert/strict';
import { invoke } from '../wdio.conf.js';

type Layout = { position: string; persistedPosition: string; sidebarSide: string };
type Checks = Record<'left' | 'right' | 'top' | 'bottom', boolean>;

async function browserUi(action: string, tabPosition?: string) {
  return invoke('desktop_test_browser_ui', { action, tabPosition });
}

describe('native tabs position menu', () => {
  it('keeps one item checked and changes the focused browser window layout', async () => {
    const layout = () => browserUi('inspect-tab-layout') as Promise<Layout>;
    const checks = () => browserUi('inspect-tab-position-menu') as Promise<Checks>;
    const original = (await layout()).position;
    try {
      for (const position of ['right', 'top', 'bottom', 'left'] as const) {
        await browserUi('choose-tab-position-menu', position);
        await browser.waitUntil(async () => {
          const current = await layout();
          return current.position === position && current.persistedPosition === position;
        });
        assert.deepEqual(await checks(), {
          left: position === 'left',
          right: position === 'right',
          top: position === 'top',
          bottom: position === 'bottom',
        });
        if (position === 'left' || position === 'right') {
          assert.equal((await layout()).sidebarSide, position);
        }
      }
      await browserUi('set-tab-position', 'top');
      await browser.waitUntil(async () => (await checks()).top);
      assert.deepEqual(await checks(), { left: false, right: false, top: true, bottom: false });
    } finally {
      await browserUi('set-tab-position', original);
    }
  });
});
