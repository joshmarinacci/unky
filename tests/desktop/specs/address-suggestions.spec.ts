import assert from 'node:assert/strict';
import { invoke } from '../wdio.conf.js';

describe('native address suggestions popup', () => {
  it('renders React results above the page and opens a selected URL', async () => {
    await invoke('control_address_suggestions_popover', {
      action: 'show',
      anchor: { x: 300, y: 10, width: 440, height: 30 },
      rows: [{ url: 'http://127.0.0.1:4179/two', title: 'Desktop fixture · Two', source: 'History' }],
      selectedIndex: 0,
    });
    await browser.waitUntil(async () => (await browser.getWindowHandles()).includes('address-suggestions-main'));
    await browser.switchToWindow('address-suggestions-main');
    const result = await $('.address-popup .address-suggestion');
    await result.waitForExist();
    assert.match(await result.getText(), /Desktop fixture · Two/);
    await browser.saveScreenshot('test-results/address-suggestions-popup.png');
    await result.click();
    await browser.switchToWindow('wdio-host');
    await browser.waitUntil(async () => {
      const state = await invoke('get_browser_state') as { tabs: Array<{ url: string }> };
      return state.tabs.some(tab => tab.url === 'http://127.0.0.1:4179/two');
    }, { timeout: 5000, timeoutMsg: 'Selecting the popup result did not navigate the browser' });
  });
});
