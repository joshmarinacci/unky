import assert from 'node:assert/strict';
import { browserWindowLabels, closeBrowserWindows, inspect, invoke } from '../wdio.conf.js';

/**
 * Real menu-bar shortcuts. `press-key-equivalent` offers a synthesized key-down to the app's main
 * menu (`NSMenu performKeyEquivalent:`), the same path AppKit takes for a real key press, so these
 * tests exercise accelerator matching and the routing of menu events to the focused window.
 * macOS will not let a background app take focus during automation, so `focus-window` also sets a
 * debug-only override that menu routing treats as the focused window.
 */

type Snapshot = { tabs: Array<{ id: string; zoom: number }>; activeTabId: string | null };
type WindowUi = { sidebarCollapsed: boolean; findOpen: boolean };

const bridge = (action: string, extra: { menuItem?: string; windowLabel?: string } = {}) =>
  invoke('desktop_test_browser_ui', { action, ...extra });
const pressKey = (shortcut: string) => bridge('press-key-equivalent', { menuItem: shortcut }) as Promise<boolean>;
const windowUi = (windowLabel: string) => bridge('inspect-window-ui', { windowLabel }) as Promise<WindowUi>;

async function focusWindow(label: string) {
  await bridge('focus-window', { windowLabel: label });
  await browser.waitUntil(async () => (await bridge('focused-window')) === label, {
    timeout: 5000,
    timeoutMsg: `${label} did not take focus`,
  });
}

/** Tab IDs in a browser window, read from the main window's full snapshot. */
async function tabsIn(windowLabel: string) {
  const main = (await invoke('get_browser_state')) as Snapshot;
  const page = await inspect(main.activeTabId);
  return (page.browser.tabs as Array<{ id: string; windowLabel: string }>)
    .filter((tab) => tab.windowLabel === windowLabel)
    .map((tab) => tab.id);
}

async function openWindow() {
  const label = (await invoke('new_browser_window')) as string;
  await browser.waitUntil(async () => (await browserWindowLabels()).includes(label), { timeout: 5000 });
  // Wait for the new window's UI to render before driving it.
  await browser.waitUntil(async () => (await windowUi(label).catch(() => null)) !== null, { timeout: 5000 });
  return label;
}

describe('native menu shortcuts', () => {
  before(async () => {
    await closeBrowserWindows();
    await focusWindow('main');
  });
  after(async () => {
    // Later specs rely on real OS focus again.
    await bridge('clear-focus-override');
  });

  it('⌘N from the menu bar opens a new browser window', async () => {
    const windowsBefore = await browserWindowLabels();
    try {
      assert.equal(await pressKey('cmd+n'), true, 'the File > New Window accelerator should claim ⌘N');
      await browser.waitUntil(async () => (await browserWindowLabels()).length === windowsBefore.length + 1, {
        timeout: 5000,
        timeoutMsg: '⌘N did not open a window',
      });
    } finally {
      await closeBrowserWindows(windowsBefore);
      await focusWindow('main');
    }
  });

  it('a menu shortcut runs only in the focused window (regression: ⌘P ran in every window)', async () => {
    const windowsBefore = await browserWindowLabels();
    try {
      const other = await openWindow();
      await focusWindow('main');
      const mainBefore = (await windowUi('main')).sidebarCollapsed;
      const otherBefore = (await windowUi(other)).sidebarCollapsed;

      assert.equal(await pressKey('cmd+shift+l'), true, 'View > Show/Hide Sidebar should claim ⇧⌘L');
      await browser.waitUntil(async () => (await windowUi('main')).sidebarCollapsed !== mainBefore, {
        timeout: 3000,
        timeoutMsg: '⇧⌘L did not toggle the focused window sidebar',
      });
      await browser.pause(300);
      assert.equal((await windowUi(other)).sidebarCollapsed, otherBefore, 'the unfocused window must not react');

      await pressKey('cmd+shift+l');
      await browser.waitUntil(async () => (await windowUi('main')).sidebarCollapsed === mainBefore, { timeout: 3000 });
    } finally {
      await closeBrowserWindows(windowsBefore);
      await focusWindow('main');
    }
  });

  it('⇧⌘W from the menu bar closes only the focused window (regression: it closed a tab)', async () => {
    const windowsBefore = await browserWindowLabels();
    try {
      const other = await openWindow();
      await focusWindow(other);
      assert.equal(await pressKey('cmd+shift+w'), true, 'File > Close Window should claim ⇧⌘W');
      await browser.waitUntil(async () => !(await browserWindowLabels()).includes(other), {
        timeout: 5000,
        timeoutMsg: '⇧⌘W did not close the focused window',
      });
      const labels = (await bridge('inspect-windows')) as string[];
      assert.ok(labels.includes('main'), 'the main window must stay open');
    } finally {
      await closeBrowserWindows(windowsBefore);
      await focusWindow('main');
    }
  });

  it('⌘W closes the tab, not the window (⇧⌘W must not fall through to it)', async () => {
    const windowsBefore = await browserWindowLabels();
    try {
      const other = await openWindow();
      await focusWindow(other);
      const [firstTab] = await tabsIn(other);
      assert.equal(await pressKey('cmd+w'), true, 'File > Close Tab should claim ⌘W');
      // Closing a window's last tab opens a fresh blank tab in its place.
      await browser.waitUntil(async () => !(await tabsIn(other)).includes(firstTab), {
        timeout: 5000,
        timeoutMsg: '⌘W did not close the tab',
      });
      assert.ok((await browserWindowLabels()).includes(other), '⌘W must leave the window open');
    } finally {
      await closeBrowserWindows(windowsBefore);
      await focusWindow('main');
    }
  });

  it('⇧⌘] and ⇧⌘[ from the menu bar switch tabs (regression: shifted punctuation never matched)', async () => {
    await focusWindow('main');
    const first = ((await invoke('get_browser_state')) as Snapshot).activeTabId!;
    const created = (await invoke('create_tab')) as Snapshot;
    const second = created.activeTabId!;
    const active = async () => ((await invoke('get_browser_state')) as Snapshot).activeTabId;
    try {
      await invoke('select_tab', { tabId: first });
      await browser.waitUntil(async () => (await active()) === first, { timeout: 3000 });
      assert.equal(await pressKey('cmd+shift+]'), true, 'Show Next Tab should claim ⇧⌘]');
      await browser.waitUntil(async () => (await active()) !== first, {
        timeout: 3000,
        timeoutMsg: '⇧⌘] did not move to another tab',
      });
      assert.equal(await pressKey('cmd+shift+['), true, 'Show Previous Tab should claim ⇧⌘[');
      await browser.waitUntil(async () => (await active()) === first, {
        timeout: 3000,
        timeoutMsg: '⇧⌘[ did not move back',
      });
    } finally {
      await invoke('close_tab', { tabId: second });
    }
  });

  it('⌘= zooms in without Shift, and ⌘0 resets', async () => {
    const zoom = async () => {
      const state = (await invoke('get_browser_state')) as Snapshot;
      return state.tabs.find((tab) => tab.id === state.activeTabId)?.zoom ?? NaN;
    };
    await focusWindow('main');
    const before = await zoom();
    try {
      assert.equal(await pressKey('cmd+='), true, 'View > Zoom In should claim ⌘=');
      await browser.waitUntil(async () => (await zoom()) > before, {
        timeout: 3000,
        timeoutMsg: '⌘= did not zoom in',
      });
    } finally {
      await pressKey('cmd+0');
      await browser.waitUntil(async () => (await zoom()) === 1, { timeout: 3000 });
    }
  });
});
