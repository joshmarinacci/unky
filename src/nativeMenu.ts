import { LogicalPosition } from '@tauri-apps/api/dpi';
import { Menu, type MenuItemOptions, type PredefinedMenuItemOptions, type SubmenuOptions } from '@tauri-apps/api/menu';

/**
 * A platform-neutral description of a context menu. The UI builds one of these and either shows
 * it as a native menu, which can overlap the website WebViews and extend past the window, or (in
 * desktop-test builds) hands it to the WebDriver bridge, because a native menu runs a modal
 * tracking loop that cannot be driven from the DOM.
 */
export type MenuEntry =
  | {
      type: 'item';
      id: string;
      label: string;
      enabled?: boolean;
      /** Shown beside the item, in the native accelerator format such as `CmdOrCtrl+R`. */
      accelerator?: string;
      action: () => void;
    }
  | { type: 'separator' }
  | { type: 'submenu'; id: string; label: string; enabled?: boolean; items: MenuEntry[] };

type NativeItem = MenuItemOptions | SubmenuOptions | PredefinedMenuItemOptions;

export function nativeMenuItems(entries: MenuEntry[]): NativeItem[] {
  return entries.map((entry): NativeItem => {
    if (entry.type === 'separator') return { item: 'Separator' };
    if (entry.type === 'submenu')
      return { id: entry.id, text: entry.label, enabled: entry.enabled ?? true, items: nativeMenuItems(entry.items) };
    return {
      id: entry.id,
      text: entry.label,
      enabled: entry.enabled ?? true,
      accelerator: entry.accelerator,
      action: entry.action,
    };
  });
}

/** Enabled items with their submenu path, for the desktop-test bridge and unit tests. */
export function flattenMenuEntries(
  entries: MenuEntry[],
  path: string[] = [],
): { label: string; path: string[]; enabled: boolean; accelerator?: string; action: () => void }[] {
  return entries.flatMap((entry) => {
    if (entry.type === 'separator') return [];
    if (entry.type === 'submenu')
      return entry.enabled === false ? [] : flattenMenuEntries(entry.items, [...path, entry.label]);
    return [
      {
        label: entry.label,
        path,
        enabled: entry.enabled ?? true,
        accelerator: entry.accelerator,
        action: entry.action,
      },
    ];
  });
}

let openMenu: Menu | null = null;

/** Show the entries as a native popup menu at a point in the current window. */
export async function popupNativeMenu(entries: MenuEntry[], x: number, y: number): Promise<void> {
  await openMenu?.close();
  const menu = await Menu.new({ items: nativeMenuItems(entries) });
  openMenu = menu;
  await menu.popup(new LogicalPosition(x, y));
}
