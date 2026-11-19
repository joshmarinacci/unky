/** The host name of a website URL, or '' for blank, internal, or non-web pages. */
export function siteDomain(url: string | undefined): string {
  if (!url) return '';
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.hostname : '';
  } catch {
    return '';
  }
}

/**
 * The site the Settings filter exception applies to. Settings opens in its own blank tab, so
 * while it is showing, fall back to the website tab that was active when Settings was opened.
 */
export function filterSiteDomain(
  activeUrl: string | undefined,
  settingsOpen: boolean,
  settingsSourceUrl: string | undefined,
): string {
  return siteDomain(activeUrl) || (settingsOpen ? siteDomain(settingsSourceUrl) : '');
}
