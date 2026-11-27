import assert from 'node:assert/strict';
import { closeBrowserWindows, invoke } from '../wdio.conf.js';

/**
 * Arrow keys in the tab tree (`TreeKeyboardNavigation`): ↑/↓ move between rows, Home/End jump to
 * the ends, ←/→ collapse and expand folders, and the focused row becomes the single Tab stop.
 */

type Snapshot = { activeTabId: string };
type TreeRow = { id: string; level: number; expanded: string | null; tabbable: boolean };

const bridge = (action: string, tabId?: string, menuItem?: string) =>
  invoke('desktop_test_browser_ui', { action, tabId, menuItem });
const rows = () => bridge('inspect-tree-rows') as Promise<TreeRow[]>;
const press = async (rowId: string, key: string) => {
  const result = (await bridge('press-tree-key', rowId, key)) as { focused?: string | null; error?: string };
  assert.equal(result.error, undefined, result.error);
  return result.focused ?? null;
};

describe('tab tree keyboard navigation', () => {
  const created: string[] = [];
  const folder = 'desktop-test-folder';

  before(async () => {
    await closeBrowserWindows();
    // An empty folder ahead of the tabs, so the tree has a row that expands and collapses. Seeding
    // replaces the tree; creating tabs afterwards makes the UI reconcile them back in after it.
    await bridge('seed-tab-folders');
    for (let i = 0; i < 2; i += 1) created.push(((await invoke('create_tab')) as Snapshot).activeTabId);
    let seen: unknown;
    await browser
      .waitUntil(async () => {
        seen = await rows();
        const ids = (seen as TreeRow[]).map((row) => row.id);
        return ids[0] === folder && created.every((id) => ids.includes(id));
      })
      .catch(() => assert.fail(`tree rows: ${JSON.stringify(seen)}, created: ${created.join(', ')}`));
  });
  after(async () => {
    for (const id of created) await invoke('close_tab', { tabId: id });
    await bridge('reset-tab-ui');
  });

  it('moves between rows with ↓, ↑, Home and End', async () => {
    const ids = (await rows()).map((row) => row.id);
    assert.equal(await press(ids[0], 'ArrowDown'), ids[1]);
    assert.equal(await press(ids[1], 'ArrowUp'), ids[0]);
    assert.equal(await press(ids[0], 'End'), ids.at(-1));
    assert.equal(await press(ids.at(-1)!, 'Home'), ids[0]);
  });

  it('makes the focused row the only Tab stop', async () => {
    const ids = (await rows()).map((row) => row.id);
    await press(ids[0], 'ArrowDown');
    await browser.waitUntil(async () => {
      const tabbable = (await rows()).filter((row) => row.tabbable).map((row) => row.id);
      return tabbable.length === 1 && tabbable[0] === ids[1];
    });
  });

  it('collapses a folder with ← and expands it with →', async () => {
    const expanded = async () => (await rows()).find((row) => row.id === folder)?.expanded;
    assert.equal(await expanded(), 'true');
    await press(folder, 'ArrowLeft');
    await browser.waitUntil(async () => (await expanded()) === 'false', { timeoutMsg: '← did not collapse' });
    await press(folder, 'ArrowRight');
    await browser.waitUntil(async () => (await expanded()) === 'true', { timeoutMsg: '→ did not expand' });
  });
});
