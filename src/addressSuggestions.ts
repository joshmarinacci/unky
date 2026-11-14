import type { BookmarkNode } from './bookmarkTree';

export type AddressSuggestion = { url: string; title: string; source: 'Bookmark' | 'History' };
export type AddressSuggestionsState = { rows: AddressSuggestion[]; selectedIndex: number };

export function findAddressSuggestions(
  address: string,
  bookmarks: BookmarkNode[],
  history: ReadonlyArray<{ url: string; title: string }>,
): AddressSuggestion[] {
  const query = address.trim().toLocaleLowerCase();
  if (!query) return [];
  const matches: AddressSuggestion[] = [];
  const seen = new Set<string>();
  const add = (url: string, title: string, source: AddressSuggestion['source']) => {
    if (!url || seen.has(url) || !`${title} ${url}`.toLocaleLowerCase().includes(query)) return;
    seen.add(url);
    matches.push({ url, title: title || url, source });
  };
  const visitBookmarks = (nodes: BookmarkNode[]) => {
    for (const node of nodes) {
      if (node.type === 'folder') visitBookmarks(node.children);
      else add(node.url, node.title, 'Bookmark');
    }
  };
  visitBookmarks(bookmarks);
  for (const entry of history) add(entry.url, entry.title, 'History');
  return matches.slice(0, 8);
}

export function moveAddressSuggestionSelection(index: number, count: number, direction: 1 | -1): number {
  return count ? (index + direction + count) % count : 0;
}

export function initialAddressSuggestions(search: string): AddressSuggestionsState {
  try { return JSON.parse(new URLSearchParams(search).get('initial') ?? '') as AddressSuggestionsState; }
  catch { return { rows: [], selectedIndex: 0 }; }
}
