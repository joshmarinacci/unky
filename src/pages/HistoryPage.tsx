import { Clock3, Search, X } from 'lucide-react';
import { AppButton, AppInput } from '../components/ui';
import type { HistoryEntry } from '../ipc';

/** Searchable browsing history, shown in its own browser tab. */
export function HistoryPage({
  history,
  historySearch,
  setHistorySearch,
  openHistoryEntry,
  onClose,
}: {
  history: HistoryEntry[];
  historySearch: string;
  setHistorySearch: (query: string) => void;
  openHistoryEntry: (url: string) => Promise<void>;
  onClose: () => void;
}) {
  return (
    <section className="history-page" aria-label="Browsing history">
      <header className="settings-heading">
        <div>
          <p className="eyebrow">UNKY</p>
          <h1>History</h1>
        </div>
        <AppButton className="settings-close" onClick={onClose} aria-label="Close history tab">
          <X className="ui-icon" size={17} aria-hidden="true" />
        </AppButton>
      </header>
      <div className="history-content">
        <label className="history-search">
          <Search className="ui-icon" size={16} aria-hidden="true" />
          <AppInput
            aria-label="Search history"
            placeholder="Search history"
            value={historySearch}
            onChange={(event) => setHistorySearch(event.target.value)}
          />
        </label>
        <div className="history-list" aria-label="History entries">
          {history
            .filter((item) => `${item.title} ${item.url}`.toLowerCase().includes(historySearch.trim().toLowerCase()))
            .map((item, index) => (
              <div className="history-entry" key={`${item.url}-${item.visitedAt}-${index}`}>
                <span className="history-entry-icon" aria-hidden="true">
                  {item.favicon ? (
                    <img
                      className="history-favicon"
                      src={item.favicon}
                      alt=""
                      onError={(event) => {
                        event.currentTarget.hidden = true;
                      }}
                    />
                  ) : (
                    <Clock3 className="ui-icon" size={15} />
                  )}
                </span>
                <AppButton className="history-entry-open" onClick={() => void openHistoryEntry(item.url)}>
                  <strong>{item.title || item.url}</strong>
                  <small>{item.url}</small>
                </AppButton>
                <time dateTime={new Date(item.visitedAt * 1000).toISOString()}>
                  {new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
                    item.visitedAt * 1000,
                  )}
                </time>
              </div>
            ))}
          {history.length === 0 && <p className="history-empty">Pages you visit will appear here.</p>}
          {history.length > 0 &&
            !history.some((item) =>
              `${item.title} ${item.url}`.toLowerCase().includes(historySearch.trim().toLowerCase()),
            ) && <p className="history-empty">No matching pages.</p>}
        </div>
      </div>
    </section>
  );
}
