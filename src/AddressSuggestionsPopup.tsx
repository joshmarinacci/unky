import { useEffect, useState } from 'react';
import { initialAddressSuggestions } from './addressSuggestions';
import { addressSuggestionsEvent, call, onEvent } from './ipc';

export default function AddressSuggestionsPopup() {
  const [suggestions, setSuggestions] = useState(() => initialAddressSuggestions(window.location.search));
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void onEvent(addressSuggestionsEvent, (event) => setSuggestions(event.payload)).then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
  return (
    <div className="address-popup" role="listbox" aria-label="Bookmarks and history suggestions">
      {suggestions.rows.map((suggestion, index) => (
        <button
          key={`${suggestion.source}-${suggestion.url}`}
          type="button"
          role="option"
          aria-selected={index === suggestions.selectedIndex}
          className={`address-suggestion${index === suggestions.selectedIndex ? ' is-active' : ''}`}
          onClick={() => {
            void call('select_address_suggestion', { url: suggestion.url });
          }}
        >
          <span className="address-suggestion-copy">
            <strong>{suggestion.title}</strong>
            <small>{suggestion.url}</small>
          </span>
          <span className="address-suggestion-source">{suggestion.source}</span>
        </button>
      ))}
    </div>
  );
}
