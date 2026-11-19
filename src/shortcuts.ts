/**
 * Browser keyboard shortcuts handled by the trusted UI. These mirror the native menu accelerators
 * in `src-tauri/src/setup.rs` (and the Windows page-view table in `platforms/windows.rs`), and the
 * UI's key handler and the menu's `browser://shortcut` event both run the same dispatcher.
 *
 * The UI handler calls `preventDefault` on a match. On macOS that makes the web view report the key
 * equivalent as handled, so the menu does not run the same shortcut a second time.
 */
export type ShortcutAction =
  | 'new-tab'
  | 'new-private-tab'
  | 'open-in-browser'
  | 'close-tab'
  | 'reopen-closed-tab'
  | 'focus-address'
  | 'reload'
  | 'go-back'
  | 'go-forward'
  | 'find'
  | 'next-tab'
  | 'previous-tab'
  | 'capture-full-page';

export type ShortcutKey = Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'>;

/** Map a menu item ID suffix (`shortcut-<id>`) to its action; the tab-cycling variants share one. */
export function shortcutFromMenu(id: string): ShortcutAction | null {
  if (id.startsWith('next-tab')) return 'next-tab';
  if (id.startsWith('previous-tab')) return 'previous-tab';
  const actions: ShortcutAction[] = [
    'new-tab',
    'new-private-tab',
    'open-in-browser',
    'close-tab',
    'reopen-closed-tab',
    'focus-address',
    'reload',
    'go-back',
    'go-forward',
    'find',
    'capture-full-page',
  ];
  return actions.find((action) => action === id) ?? null;
}

/** The shortcut for a key press, using ⌘ on Apple platforms and Ctrl elsewhere. */
export function shortcutForKey(event: ShortcutKey, apple: boolean): ShortcutAction | null {
  const { metaKey, ctrlKey, shiftKey, altKey } = event;
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  // Ctrl+Tab cycles tabs on every platform, including macOS.
  if (ctrlKey && !metaKey && !altKey && key === 'Tab') return shiftKey ? 'previous-tab' : 'next-tab';

  const mod = apple ? metaKey && !ctrlKey : ctrlKey && !metaKey;
  if (mod && !altKey) {
    if (key === 't') return shiftKey ? 'reopen-closed-tab' : 'new-tab';
    if (key === 'n' && shiftKey) return 'new-private-tab';
    if (shiftKey) {
      // Shift turns [ and ] into { and } on US layouts.
      if (apple && (key === ']' || key === '}')) return 'next-tab';
      if (apple && (key === '[' || key === '{')) return 'previous-tab';
      return null;
    }
    if (key === 'w') return 'close-tab';
    if (key === 'l') return 'focus-address';
    if (key === 'f') return 'find';
    if (key === 'r') return 'reload';
    if (apple && key === '[') return 'go-back';
    if (apple && key === ']') return 'go-forward';
    if (!apple && key === 'PageDown') return 'next-tab';
    if (!apple && key === 'PageUp') return 'previous-tab';
    return null;
  }
  if (apple && metaKey && altKey && !ctrlKey && !shiftKey) {
    if (key === 'ArrowRight') return 'next-tab';
    if (key === 'ArrowLeft') return 'previous-tab';
  }
  if (!apple && altKey && !ctrlKey && !metaKey && !shiftKey) {
    if (key === 'ArrowLeft') return 'go-back';
    if (key === 'ArrowRight') return 'go-forward';
  }
  return null;
}
