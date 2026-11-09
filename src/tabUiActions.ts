export function selectInputText(input: Pick<HTMLInputElement, 'select'>): void {
  input.select();
}

export type ExternalBrowserChoice = { id: string; name: string };

export function externalBrowserMenuItems(browsers: ExternalBrowserChoice[]) {
  return browsers.map(browser => ({
    id: browser.id,
    label: browser.name,
    command: 'open_in_external_browser' as const,
  }));
}
