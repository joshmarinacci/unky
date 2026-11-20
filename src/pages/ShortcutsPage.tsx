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
            ['New window', `${commandKey}+N`],
            ['New private tab', `${commandKey}+Shift+N`],
            ['Close tab', `${commandKey}+W`],
            ['Close window', `${commandKey}+Shift+W`],
            ['Reopen closed tab', `${commandKey}+Shift+T`],
            ['Next tab', isApplePlatform ? 'Ctrl+Tab · ⌘+Option+→ · ⇧+⌘+]' : 'Ctrl+Tab · Ctrl+PageDown'],
            ['Previous tab', isApplePlatform ? 'Ctrl+Shift+Tab · ⌘+Option+← · ⇧+⌘+[' : 'Ctrl+Shift+Tab · Ctrl+PageUp'],
            ['Select tab 1–8', `${commandKey}+1 … ${commandKey}+8`],
            ['Select last tab', `${commandKey}+9`],
            ['Focus address bar', `${commandKey}+L`],
            ['Find in page', `${commandKey}+F`],
            ['Find next / previous', `${commandKey}+G · ${commandKey}+Shift+G`],
            ['Reload page', `${commandKey}+R`],
            ['Reload ignoring cache', isApplePlatform ? '⇧+⌘+R · ⌘+Option+R' : 'Ctrl+Shift+R · Ctrl+F5'],
            ['Bookmark this page', `${commandKey}+D`],
            ['Show/hide sidebar', `${commandKey}+Shift+L`],
            ['Print', `${commandKey}+P`],
            ['Web Inspector', isApplePlatform ? '⌘+Option+I' : 'Ctrl+Shift+I'],
            ...(isApplePlatform ? [['Stop loading', '⌘+.']] : []),
            ['Back', isApplePlatform ? `${commandKey}+[` : 'Alt+←'],
            ['Forward', isApplePlatform ? `${commandKey}+]` : 'Alt+→'],
            ['Zoom in', `${commandKey}+=`],
            ['Zoom out', `${commandKey}+-`],
            ['Reset zoom', `${commandKey}+0`],
            ['Settings', `${commandKey}+,`],
            ...(isApplePlatform
              ? [
                  ['Show all history', '⌘+Y'],
                  ['Show downloads', '⌘+Option+L'],
                  ['Show all bookmarks', '⌘+Option+B'],
                  ['Enter full screen', 'Ctrl+⌘+F'],
                  ['Minimize window', '⌘+M'],
                ]
              : []),
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
