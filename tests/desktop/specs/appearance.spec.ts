import assert from 'node:assert/strict';
import { closeBrowserWindows, closeTabs, invoke } from '../wdio.conf.js';

type Appearance = {
  theme: string | null;
  accent: string | null;
  tint: string;
  tint1000: string;
  accentColor: string;
  address: string | null;
  selectedSwatch: string | null;
  pressedTheme: string[];
  sidebarView: string | null;
  settingsHeadings: string[];
};
type ThemeChecks = Record<'system' | 'light' | 'dark', boolean>;

async function browserUi(action: string, menuItem?: string) {
  return invoke('desktop_test_browser_ui', { action, menuItem });
}
const appearance = () => browserUi('inspect-appearance') as Promise<Appearance>;
const themeChecks = () => browserUi('inspect-theme-menu') as Promise<ThemeChecks>;
const openTabIds = async () =>
  ((await invoke('get_browser_state')) as { tabs: Array<{ id: string }> }).tabs.map((tab) => tab.id);

describe('appearance, accent color and built-in page addresses', () => {
  before(async () => {
    await closeBrowserWindows();
  });

  it('shows unky:// addresses for built-in pages and opens them from the address bar', async () => {
    const tabsBefore = await openTabIds();
    try {
      await browserUi('submit-address', 'unky://settings');
      await browser.waitUntil(async () => (await appearance()).address === 'unky://settings', {
        timeout: 5000,
        timeoutMsg: 'Typing unky://settings should open Settings and show its address',
      });
      // Appearance comes first in Settings, with the color scheme and accent pickers.
      assert.equal((await appearance()).settingsHeadings[0], 'Appearance');

      await browserUi('submit-address', 'unky://shortcuts');
      await browser.waitUntil(async () => (await appearance()).address === 'unky://shortcuts', {
        timeout: 5000,
        timeoutMsg: 'Typing unky://shortcuts should open the shortcuts page',
      });
      await browserUi('submit-address', 'unky://history');
      await browser.waitUntil(async () => (await appearance()).address === 'unky://history', {
        timeout: 5000,
        timeoutMsg: 'Typing unky://history should open the history page',
      });
      // Switching back to an existing built-in tab shows its address again.
      await browserUi('submit-address', 'unky://settings');
      await browser.waitUntil(async () => (await appearance()).address === 'unky://settings', {
        timeout: 5000,
        timeoutMsg: 'Returning to Settings should show unky://settings',
      });
    } finally {
      await closeTabs(tabsBefore);
    }
  });

  it('opens the bookmarks manager from the Bookmarks menu', async () => {
    const items = (await browserUi('inspect-bookmarks-menu')) as Array<{ id: string; text: string }>;
    assert.deepEqual(items[0], { id: 'show-bookmarks', text: 'Show All Bookmarks' });
    await browserUi('reset-tab-ui');
    try {
      assert.equal((await appearance()).sidebarView, 'tabs');
      await browserUi('choose-bookmarks-menu-show-all');
      await browser.waitUntil(async () => (await appearance()).sidebarView === 'bookmarks', {
        timeout: 3000,
        timeoutMsg: 'Show All Bookmarks should switch the sidebar to the bookmarks manager',
      });
    } finally {
      // Later specs expect the tab list in the sidebar.
      await browserUi('reset-tab-ui');
    }
  });

  it('keeps View > Appearance, the Settings picker and the page theme in sync', async () => {
    const tabsBefore = await openTabIds();
    try {
      await browserUi('choose-theme-menu', 'light');
      await browser.waitUntil(async () => (await appearance()).theme === 'light', {
        timeout: 3000,
        timeoutMsg: 'Choosing Light from the menu should switch the UI to light',
      });
      assert.deepEqual(await themeChecks(), { system: false, light: true, dark: false });

      await browserUi('submit-address', 'unky://settings');
      await browser.waitUntil(async () => (await appearance()).pressedTheme.length === 1, { timeout: 5000 });
      assert.deepEqual((await appearance()).pressedTheme, ['Light']);

      await browserUi('choose-theme-button', 'Dark');
      await browser.waitUntil(async () => (await themeChecks()).dark, {
        timeout: 3000,
        timeoutMsg: 'Choosing Dark in Settings should check View > Appearance > Dark',
      });
      assert.equal((await appearance()).theme, 'dark');
      assert.deepEqual(await themeChecks(), { system: false, light: false, dark: true });
    } finally {
      await browserUi('choose-theme-menu', 'system');
      await browser.waitUntil(async () => (await themeChecks()).system, { timeout: 3000 });
      await closeTabs(tabsBefore);
    }
  });

  it('applies the chosen accent color and can follow the system accent', async () => {
    const tabsBefore = await openTabIds();
    try {
      await browserUi('submit-address', 'unky://settings');
      await browser.waitUntil(async () => (await appearance()).selectedSwatch !== null, { timeout: 5000 });
      assert.equal((await appearance()).accent, 'orange', 'orange stays the default accent');
      const orange = (await appearance()).tint1000;

      await browserUi('choose-accent', 'blue');
      await browser.waitUntil(async () => (await appearance()).accent === 'blue', { timeout: 3000 });
      const blue = await appearance();
      assert.equal(blue.selectedSwatch, 'blue');
      assert.notEqual(blue.tint1000, orange, 'the derived tint shades should change with the accent');

      await browserUi('choose-accent', 'system');
      await browser.waitUntil(async () => (await appearance()).accent === 'system', { timeout: 3000 });
      const system = await appearance();
      assert.ok(system.tint1000, `the system accent should resolve to a color: ${JSON.stringify(system)}`);
    } finally {
      await browserUi('choose-accent', 'orange').catch(() => undefined);
      await closeTabs(tabsBefore);
    }
  });
});
