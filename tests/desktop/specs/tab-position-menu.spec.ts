import assert from 'node:assert/strict';
import { closeBrowserWindows, invoke } from '../wdio.conf.js';

type Layout = { position: string; persistedPosition: string; sidebarSide: string };
type Checks = Record<'left' | 'right' | 'top' | 'bottom', boolean>;

async function browserUi(action: string, tabPosition?: string) {
  return invoke('desktop_test_browser_ui', { action, tabPosition });
}

describe('native tabs position menu', () => {
  // Every spec file drives the same app process. The shared menu's check marks follow the
  // focused browser window, so make sure no window left by an earlier spec holds focus.
  before(async () => {
    await closeBrowserWindows();
  });

  it('keeps one item checked and changes the focused browser window layout', async () => {
    const layout = () => browserUi('inspect-tab-layout') as Promise<Layout>;
    const checks = () => browserUi('inspect-tab-position-menu') as Promise<Checks>;
    const original = (await layout()).position;
    try {
      for (const position of ['right', 'top', 'bottom', 'left'] as const) {
        await browserUi('choose-tab-position-menu', position);
        await browser.waitUntil(
          async () => {
            const current = await layout();
            return current.position === position && current.persistedPosition === position;
          },
          { timeoutMsg: `The main window did not switch to ${position} tabs` },
        );
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
      await browser.waitUntil(async () => (await checks()).top, {
        timeoutMsg: 'The tab position menu did not follow the main window (is another browser window focused?)',
      });
      assert.deepEqual(await checks(), { left: false, right: false, top: true, bottom: false });
    } finally {
      await browserUi('set-tab-position', original);
    }
  });
});
