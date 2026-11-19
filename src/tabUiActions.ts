export function selectInputText(input: Pick<HTMLInputElement, 'select'>): void {
  input.select();
}

export type ExternalBrowserChoice = { id: string; name: string };

export function externalBrowserMenuItems(browsers: ExternalBrowserChoice[]) {
  return browsers.map((browser) => ({
    id: browser.id,
    label: browser.name,
    command: 'open_in_external_browser' as const,
  }));
}

/** The keys that open a context menu from the keyboard: the Menu key, or Shift+F10. */
export function isContextMenuKey(event: Pick<KeyboardEvent, 'key' | 'shiftKey'>): boolean {
  return event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10');
}

/** The one row of a tree that Tab reaches: the first candidate still shown, else the first row. */
export function rovingTabStop(rowIds: string[], ...preferred: string[]): string {
  return preferred.find((id) => id && rowIds.includes(id)) ?? rowIds[0] ?? '';
}
