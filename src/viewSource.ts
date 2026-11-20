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

/** View Source needs a page with an address; blank tabs and built-in pages have none. */
export function canViewSource(url: string | undefined): url is string {
  return Boolean(url && /^(https?|file):/i.test(url));
}
