import assert from 'node:assert/strict';
import { captureNativeWindow, inspect } from '../wdio.conf.js';

describe('release showcase screenshot', () => {
  it('captures the app with the curated showcase page', async function () {
    if (process.env.DESKTOP_TEST_SHOWCASE !== '1') this.skip();

    await browser.waitUntil(async () => {
      const page = await inspect('tab-1');
      return page.readyState === 'complete' && page.title === 'Wander · Field Notes';
    }, { timeout: 20000, timeoutMsg: 'The release showcase page did not finish loading' });

    const screenshot = captureNativeWindow('release-screenshot.png');
    assert.ok(screenshot.endsWith('release-screenshot.png'));
  });
});
