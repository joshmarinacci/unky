/**
 * Built-in pages that the trusted UI draws in place of a website. Like `chrome://settings`, each has
 * an address the address bar shows and accepts. Rust never navigates to these: the UI intercepts
 * them before calling `navigate`.
 */
export type InternalPage = 'settings' | 'history' | 'downloads' | 'shortcuts' | 'bookmarks';

export const internalPageScheme = 'unky:';

const internalPages: readonly InternalPage[] = ['settings', 'history', 'downloads', 'shortcuts', 'bookmarks'];

export function internalPageUrl(page: InternalPage): string {
  return `${internalPageScheme}//${page}`;
}

/** The built-in page an address names, accepting `unky://settings`, `unky:settings` and a trailing slash. */
export function parseInternalPageUrl(input: string): InternalPage | null {
  const match = /^unky:(?:\/\/)?([a-z]+)\/?$/i.exec(input.trim());
  const page = match?.[1].toLowerCase();
  return internalPages.find((candidate) => candidate === page) ?? null;
}
