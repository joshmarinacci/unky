import { X } from 'lucide-react';
import { AppButton } from '../components/ui';
import { commandKey, isApplePlatform } from '../platform';

/** Keyboard shortcut reference, shown in its own browser tab. */
export function ShortcutsPage({ onClose }: { onClose: () => void }) {
  return (
    <section className="history-page shortcuts-page" aria-label="Keyboard shortcuts">
      <header className="settings-heading">
        <div>
          <p className="eyebrow">UNKY HELP</p>
          <h1>Keyboard Shortcuts</h1>
        </div>
        <AppButton className="settings-close" onClick={onClose} aria-label="Close shortcuts">
          <X className="ui-icon" size={17} aria-hidden="true" />
        </AppButton>
      </header>
      <div className="history-content">
        <p className="shortcuts-intro">Use these shortcuts while browsing. Some shortcuts vary by platform.</p>
        <div className="shortcuts-list">
          {[
            ['New tab', `${commandKey}+T`],
            ['New private tab', `${commandKey}+Shift+N`],
            ['Close tab', `${commandKey}+W`],
            ['Reopen closed tab', `${commandKey}+Shift+T`],
            ['Next tab', isApplePlatform ? 'Ctrl+Tab · ⌘+Option+→ · ⇧+⌘+]' : 'Ctrl+Tab · Ctrl+PageDown'],
            ['Previous tab', isApplePlatform ? 'Ctrl+Shift+Tab · ⌘+Option+← · ⇧+⌘+[' : 'Ctrl+Shift+Tab · Ctrl+PageUp'],
            ['Focus address bar', `${commandKey}+L`],
            ['Find in page', `${commandKey}+F`],
            ['Reload page', `${commandKey}+R`],
            ['Back', isApplePlatform ? `${commandKey}+[` : 'Alt+←'],
            ['Forward', isApplePlatform ? `${commandKey}+]` : 'Alt+→'],
            ['Zoom in', `${commandKey}+Shift+=`],
            ['Zoom out', `${commandKey}+-`],
            ['Reset zoom', `${commandKey}+0`],
            ['Settings', `${commandKey}+,`],
          ].map(([label, keys]) => (
            <div className="shortcut-entry" key={label}>
              <span>{label}</span>
              <kbd>{keys}</kbd>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
