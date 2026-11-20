import { X } from 'lucide-react';
import { AppButton } from '../components/ui';
import { sourceTabUrl, type SourceTabState } from '../viewSource';

/** A tab's HTML source, shown as numbered plain-text lines in its own browser tab. */
export function SourcePage({ state, onClose }: { state: SourceTabState; onClose: () => void }) {
  const url = sourceTabUrl(state);
  return (
    <section className="history-page source-page" aria-label="Page source">
      <header className="settings-heading">
        <div>
          <p className="eyebrow">VIEW SOURCE</p>
          <h1 className="source-page-url">{url}</h1>
        </div>
        <AppButton className="settings-close" onClick={onClose} aria-label="Close source">
          <X className="ui-icon" size={17} aria-hidden="true" />
        </AppButton>
      </header>
      <div className="history-content">
        {state.status === 'loading' && <p className="source-page-note">Loading source…</p>}
        {state.status === 'error' && (
          <p className="source-page-note">Could not read the page source: {state.message}</p>
        )}
        {state.status === 'ready' && (
          <>
            {!state.page.original && (
              <p className="source-page-note">
                The original file could not be downloaded, so this is the page’s current HTML, including changes made by
                its scripts.
              </p>
            )}
            <pre className="source-page-code" tabIndex={0} aria-label="HTML source">
              {state.page.source.split('\n').map((line, index) => (
                <span className="source-line" key={index}>
                  {line}
                  {'\n'}
                </span>
              ))}
            </pre>
          </>
        )}
      </div>
    </section>
  );
}
