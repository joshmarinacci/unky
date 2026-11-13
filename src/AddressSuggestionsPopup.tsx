import { useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';

type Suggestion = { url: string; title: string; source: string };
type SuggestionsState = { rows: Suggestion[]; selectedIndex: number };

const params = new URLSearchParams(window.location.search);
function initialSuggestions(): SuggestionsState {
  try { return JSON.parse(params.get('initial') ?? '') as SuggestionsState; }
  catch { return { rows: [], selectedIndex: 0 }; }
}

export default function AddressSuggestionsPopup() {
  const [suggestions, setSuggestions] = useState(initialSuggestions);
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<SuggestionsState>('browser://address-suggestions', event => setSuggestions(event.payload)).then(stop => {
      if (disposed) stop();
      else unlisten = stop;
    });
    return () => { disposed = true; unlisten?.(); };
  }, []);
  return <div className="address-popup" role="listbox" aria-label="Bookmarks and history suggestions">
    {suggestions.rows.map((suggestion, index) => <button key={`${suggestion.source}-${suggestion.url}`} type="button" role="option" aria-selected={index === suggestions.selectedIndex} className={`address-suggestion${index === suggestions.selectedIndex ? ' is-active' : ''}`} onClick={() => { void invoke('select_address_suggestion', { url: suggestion.url }); }}>
      <span className="address-suggestion-copy"><strong>{suggestion.title}</strong><small>{suggestion.url}</small></span><span className="address-suggestion-source">{suggestion.source}</span>
    </button>)}
  </div>;
}
