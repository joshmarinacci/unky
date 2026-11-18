import { Download, ExternalLink, X } from 'lucide-react';
import { AppButton } from '../components/ui';
import { call, type Download as DownloadItem } from '../ipc';

/** The full downloads list, shown in its own browser tab. */
export function DownloadsPage({
  downloads,
  onClose,
  setMessage,
}: {
  downloads: DownloadItem[];
  onClose: () => void;
  setMessage: (message: string) => void;
}) {
  return (
    <section className="history-page" aria-label="Downloads">
      <header className="settings-heading">
        <div>
          <p className="eyebrow">UNKY</p>
          <h1>Downloads</h1>
        </div>
        <AppButton className="settings-close" onClick={onClose} aria-label="Close downloads tab">
          <X className="ui-icon" size={17} aria-hidden="true" />
        </AppButton>
      </header>
      <div className="history-content">
        <div className="history-list" aria-label="All downloads">
          {downloads.map((item) => (
            <div className="history-entry" key={item.id}>
              <span className="history-entry-icon" aria-hidden="true">
                <Download className="ui-icon" size={16} />
              </span>
              <div className="history-entry-open">
                <strong>{item.filename}</strong>
                <small>{item.path}</small>
                <small className={`download-status-${item.status}`}>
                  {item.status === 'completed'
                    ? 'Complete'
                    : item.status === 'failed'
                      ? 'Failed'
                      : `Downloading · ${item.bytesReceived.toLocaleString()} bytes`}
                </small>
                {item.status === 'downloading' && (
                  <progress className="download-progress" aria-label={`Downloading ${item.filename}`} />
                )}
              </div>
              <AppButton
                className="download-reveal"
                disabled={item.status !== 'completed'}
                aria-label={`Reveal ${item.filename}`}
                title="Show in Finder"
                onClick={() =>
                  void call('reveal_download', { downloadId: item.id }).catch((error) => setMessage(String(error)))
                }
              >
                <ExternalLink className="ui-icon" size={14} aria-hidden="true" />
              </AppButton>
            </div>
          ))}
          {downloads.length === 0 && <p className="history-empty">Downloads will appear here.</p>}
        </div>
      </div>
    </section>
  );
}
