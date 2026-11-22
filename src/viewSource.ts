/** View Source: a built-in page that shows a tab's HTML, addressed like Chrome's `view-source:`. */

export const viewSourcePrefix = 'view-source:';

/** What `get_page_source` returns: the downloaded HTML, or the live DOM when the download failed. */
export type PageSource = { url: string; source: string; original: boolean };

export type SourceTabState =
  | { status: 'loading'; url: string }
  | { status: 'ready'; page: PageSource }
  | { status: 'error'; url: string; message: string };

export function viewSourceUrl(url: string): string {
  return `${viewSourcePrefix}${url}`;
}

export function sourceTabUrl(state: SourceTabState): string {
  return state.status === 'ready' ? state.page.url : state.url;
}

/** The sidebar name for a source tab: "Source of <page title>", else the host, else the address. */
export function sourceTabTitle(title: string, url: string): string {
  let host = '';
  try {
    host = new URL(url).host;
  } catch {
    // Not a parseable URL; fall back to the address itself.
  }
  return `Source of ${title.trim() || host || url}`;
}

/** The addresses of open source tabs, by tab ID, as saved across restarts. The HTML is not saved. */
export function serializeSourceTabs(tabs: Record<string, SourceTabState>): string {
  return JSON.stringify(Object.fromEntries(Object.entries(tabs).map(([id, state]) => [id, sourceTabUrl(state)])));
}

/**
 * Source tabs saved by `serializeSourceTabs`, ready to download again. Only web addresses are
 * kept: a `file:` page's source came from its live tab, which may be gone after a restart.
 */
export function parseStoredSourceTabs(stored: string | null): Record<string, SourceTabState> {
  let value: unknown;
  try {
    value = JSON.parse(stored ?? '{}');
  } catch {
    return {};
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).flatMap(([id, url]) =>
      typeof url === 'string' && /^https?:/i.test(url) ? [[id, { status: 'loading', url } as const]] : [],
    ),
  );
}

/** View Source needs a page with an address; blank tabs and built-in pages have none. */
export function canViewSource(url: string | undefined): url is string {
  return Boolean(url && /^(https?|file):/i.test(url));
}
