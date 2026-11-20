import buildMetadata from '../build-metadata.json';
import { Radio, RadioGroup } from 'react-aria-components';
import { X } from 'lucide-react';
import { AppButton } from '../components/ui';
import { accentColors, type AccentColor, type SidebarSide, type Theme } from '../storedPreferences';
import { type FilterSettingsView, type FilterUpdateProgress } from '../ipc';
import { type TabPosition } from '../tabLayout';

const tabPositions: { id: TabPosition; symbol: string }[] = [
  { id: 'left', symbol: '←' },
  { id: 'right', symbol: '→' },
  { id: 'top', symbol: '↑' },
  { id: 'bottom', symbol: '↓' },
];

/**
 * Browser settings, shown in their own tab. The page is a shell; App composes the sections
 * (`GeneralSettings`, `AppearanceSettings`, `PrivacySettings`) inside it. The status message
 * and the About section always come last.
 */
export function SettingsPage({
  message,
  onClose,
  children,
}: {
  message: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <section className="settings-page" aria-label="Settings">
      <header className="settings-heading">
        <div>
          <p className="eyebrow">UNKY</p>
          <h1>Settings</h1>
        </div>
        <AppButton className="settings-close" onClick={onClose} aria-label="Close settings">
          <X className="ui-icon" size={17} aria-hidden="true" />
        </AppButton>
      </header>
      <div className="settings-content">
        {children}
        {message && (
          <p className="message" role="status">
            {message}
          </p>
        )}
        <h2>About</h2>
        <div className="settings-card">
          <div>
            <strong>Unky</strong>
            <small>
              Version {buildMetadata.version} · Build {buildMetadata.buildNumber} · Built{' '}
              {new Date(buildMetadata.builtAt).toLocaleString()}
            </small>
          </div>
          <span>{buildMetadata.version}</span>
        </div>
      </div>
    </section>
  );
}

export function GeneralSettings({
  onManageBookmarks,
  pageContextMenu,
  onPageContextMenuChange,
}: {
  onManageBookmarks: () => void;
  /** Whether the browser replaces the webpage right-click menu. */
  pageContextMenu: boolean;
  onPageContextMenuChange: (enabled: boolean) => void;
}) {
  return (
    <>
      <h2>General</h2>
      <div className="settings-card">
        <div>
          <strong>Bookmarks</strong>
          <small>Saved locally in this browser profile.</small>
        </div>
        <AppButton onClick={onManageBookmarks}>Manage bookmarks</AppButton>
      </div>
      <div className="settings-card">
        <div>
          <strong>Webpage context menu</strong>
          <small>Replace the page’s default right-click menu with browser actions.</small>
        </div>
        <label className="settings-toggle">
          <input
            type="checkbox"
            checked={pageContextMenu}
            onChange={(event) => onPageContextMenuChange(event.target.checked)}
          />
          <span>{pageContextMenu ? 'On' : 'Off'}</span>
        </label>
      </div>
    </>
  );
}

const themeChoices: { id: Theme; label: string }[] = [
  { id: 'system', label: 'System' },
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
];

const accentLabels: Record<AccentColor, string> = {
  system: 'System',
  blue: 'Blue',
  purple: 'Purple',
  pink: 'Pink',
  red: 'Red',
  orange: 'Orange',
  yellow: 'Yellow',
  green: 'Green',
  graphite: 'Graphite',
};

export function AppearanceSettings({
  theme,
  setTheme,
  accentColor,
  setAccentColor,
  tabPosition,
  setTabPosition,
  sidebarSide,
  setSidebarSide,
  sidebarWidth,
}: {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  accentColor: AccentColor;
  setAccentColor: (color: AccentColor) => void;
  tabPosition: TabPosition;
  setTabPosition: (position: TabPosition) => void;
  sidebarSide: SidebarSide;
  setSidebarSide: (side: SidebarSide) => void;
  sidebarWidth: number;
}) {
  return (
    <>
      <h2>Appearance</h2>
      <div className="settings-card">
        <div>
          <strong>Color scheme</strong>
          <small>Choose the browser interface appearance.</small>
        </div>
        <div className="tab-position-picker theme-picker" role="group" aria-label="Color scheme">
          {themeChoices.map((choice) => (
            <button
              key={choice.id}
              type="button"
              aria-pressed={theme === choice.id}
              onClick={() => setTheme(choice.id)}
            >
              {choice.label}
            </button>
          ))}
        </div>
      </div>
      <div className="settings-card">
        <div>
          <strong>Accent color</strong>
          <small>Color for selected tabs, buttons and highlights. System follows your macOS accent color.</small>
        </div>
        <RadioGroup
          className="accent-picker"
          aria-label="Accent color"
          orientation="horizontal"
          value={accentColor}
          onChange={(value) => setAccentColor(accentColors.find((color) => color === value) ?? accentColor)}
        >
          {accentColors.map((color) => (
            <Radio key={color} value={color} className="accent-swatch" data-accent-swatch={color}>
              <span className="accent-swatch-color" aria-hidden="true" />
              <span className="accent-swatch-label">{accentLabels[color]}</span>
            </Radio>
          ))}
        </RadioGroup>
      </div>
      <div className="settings-card">
        <div>
          <strong>Tab position</strong>
          <small>Place tabs in the sidebar or dock them across the top or bottom edge.</small>
        </div>
        <div className="tab-position-picker" role="group" aria-label="Tab position">
          {tabPositions.map((position) => (
            <button
              key={position.id}
              type="button"
              title={`Tabs on ${position.id}`}
              aria-label={`Tabs on ${position.id}`}
              aria-pressed={tabPosition === position.id}
              onClick={() => {
                setTabPosition(position.id);
                if (position.id === 'left' || position.id === 'right') setSidebarSide(position.id);
              }}
            >
              <span aria-hidden="true">{position.symbol}</span>
              {position.id[0].toUpperCase() + position.id.slice(1)}
            </button>
          ))}
        </div>
      </div>
      <div className="settings-card">
        <div>
          <strong>Bookmarks sidebar</strong>
          <small>Keep bookmarks on the left or right side of the window.</small>
        </div>
        <div className="tab-position-picker sidebar-side-picker" role="group" aria-label="Bookmarks sidebar position">
          {(['left', 'right'] as const).map((side) => (
            <button
              key={side}
              type="button"
              aria-label={`Bookmarks sidebar on ${side}`}
              aria-pressed={sidebarSide === side}
              onClick={() => {
                setSidebarSide(side);
                if (tabPosition === 'left' || tabPosition === 'right') setTabPosition(side);
              }}
            >
              {side[0].toUpperCase() + side.slice(1)}
            </button>
          ))}
        </div>
      </div>
      <div className="settings-card">
        <div>
          <strong>Sidebar width</strong>
          <small>Resize the sidebar by dragging its inner edge.</small>
        </div>
        <span>{Math.round(sidebarWidth)} px</span>
      </div>
    </>
  );
}

/** Content-filter state and actions for the Privacy section. */
export type FilterControls = {
  settings: FilterSettingsView | null;
  busy: boolean;
  progress: FilterUpdateProgress | null;
  /** The site the per-site exception applies to, or '' when there is none. */
  siteDomain: string;
  setEnabled: (enabled: boolean) => Promise<void>;
  setSiteException: (enabled: boolean) => Promise<void>;
  updateList: () => Promise<void>;
};

export function PrivacySettings({
  onNewPrivateTab,
  onClearData,
  filtering,
}: {
  onNewPrivateTab: () => void;
  onClearData: () => void;
  filtering: FilterControls;
}) {
  return (
    <>
      <h2>Privacy</h2>
      <div className="settings-card">
        <div>
          <strong>Private tab</strong>
          <small>
            Open a tab with ephemeral website storage. Private tabs are excluded from history and session recovery.
          </small>
        </div>
        <AppButton onClick={onNewPrivateTab}>New private tab</AppButton>
      </div>
      <div className="settings-card">
        <div>
          <strong>Clear browsing data</strong>
          <small>Clear website storage for this browser profile and remove browsing history.</small>
        </div>
        <AppButton onClick={onClearData}>Clear data</AppButton>
      </div>
      <div className="settings-card">
        <div>
          <strong>Content filtering</strong>
          <small>
            {filtering.settings?.enabled
              ? filtering.settings.updatedAt
                ? 'EasyList based blocking is active for new and reloaded pages.'
                : 'The built-in starter rules are active until EasyList is updated.'
              : 'Ad and tracker blocking is disabled.'}{' '}
            Changes reload open website tabs.
          </small>
        </div>
        <AppButton
          disabled={filtering.busy || !filtering.settings}
          onClick={() => void filtering.setEnabled(!filtering.settings?.enabled)}
        >
          {filtering.settings?.enabled ? 'Turn off' : 'Turn on'}
        </AppButton>
      </div>
      <div className="settings-card">
        <div>
          <strong>Filter list</strong>
          <small>
            {filtering.settings
              ? `${filtering.settings.acceptedRules.toLocaleString()} supported rules · ${filtering.settings.updatedAt ? `Updated ${new Date(filtering.settings.updatedAt * 1000).toLocaleString()}` : 'Using the built-in starter set'}`
              : 'Loading filter status…'}{' '}
            The compiler skips unsupported EasyList syntax.
          </small>
          {filtering.busy && (
            <div className="filter-update-progress" role="status" aria-live="polite">
              <span>
                {filtering.progress?.phase === 'compiling'
                  ? 'Compiling rules…'
                  : filtering.progress?.totalBytes
                    ? `Downloading EasyList… ${Math.min(100, Math.floor((filtering.progress.receivedBytes * 100) / filtering.progress.totalBytes))}%`
                    : 'Connecting to EasyList…'}
              </span>
              {filtering.progress?.phase === 'downloading' && filtering.progress.totalBytes && (
                <progress
                  aria-label="EasyList download progress"
                  max={100}
                  value={Math.min(
                    100,
                    Math.floor((filtering.progress.receivedBytes * 100) / filtering.progress.totalBytes),
                  )}
                />
              )}
              {filtering.progress?.phase === 'downloading' && !filtering.progress.totalBytes && (
                <progress aria-label="EasyList download progress" />
              )}
            </div>
          )}
        </div>
        <AppButton disabled={filtering.busy} onClick={() => void filtering.updateList()}>
          {filtering.busy ? 'Updating…' : 'Update EasyList'}
        </AppButton>
      </div>
      <div className="settings-card">
        <div>
          <strong>Current site</strong>
          <small>
            {filtering.siteDomain
              ? `Allow requests on ${filtering.siteDomain} by disabling filtering for this site.`
              : 'Open a website to manage its filter exception.'}
          </small>
        </div>
        <AppButton
          disabled={filtering.busy || !filtering.siteDomain}
          onClick={() =>
            void filtering.setSiteException(!filtering.settings?.exceptions.includes(filtering.siteDomain))
          }
        >
          {filtering.settings?.exceptions.includes(filtering.siteDomain) ? 'Enable for site' : 'Disable for site'}
        </AppButton>
      </div>
    </>
  );
}
