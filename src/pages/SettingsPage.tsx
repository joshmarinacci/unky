import type { Dispatch, SetStateAction } from 'react';
import buildMetadata from '../build-metadata.json';
import { Button as AriaButton, ListBox, ListBoxItem, Popover, Select, SelectValue } from 'react-aria-components';
import { X } from 'lucide-react';
import { AppButton } from '../components/ui';
import { type SidebarSide, type Theme } from '../storedPreferences';
import { type FilterSettingsView, type FilterUpdateProgress } from '../ipc';
import { type TabPosition } from '../tabLayout';

const tabPositions: { id: TabPosition; symbol: string }[] = [
  { id: 'left', symbol: '←' },
  { id: 'right', symbol: '→' },
  { id: 'top', symbol: '↑' },
  { id: 'bottom', symbol: '↓' },
];

type SettingsPageProps = {
  /** Hostname of the active tab, for the per-site filter exception. */
  activeSiteDomain: string;
  message: string;
  closeSettings: () => void;
  createTab: (privateMode?: boolean) => Promise<void>;
  clearBrowsingData: () => Promise<void>;
  // Appearance and layout
  theme: Theme;
  setTheme: Dispatch<SetStateAction<Theme>>;
  tabPosition: TabPosition;
  setTabPosition: Dispatch<SetStateAction<TabPosition>>;
  sidebarSide: SidebarSide;
  setSidebarSide: Dispatch<SetStateAction<SidebarSide>>;
  setSidebarView: Dispatch<SetStateAction<'tabs' | 'bookmarks'>>;
  sidebarWidth: number;
  customPageContextMenuEnabled: boolean;
  setCustomPageContextMenuEnabled: Dispatch<SetStateAction<boolean>>;
  // Content filtering
  filterSettings: FilterSettingsView | null;
  filterBusy: boolean;
  filterProgress: FilterUpdateProgress | null;
  changeFilteringEnabled: (enabled: boolean) => Promise<void>;
  changeSiteFilterException: (enabled: boolean) => Promise<void>;
  updateFilterList: () => Promise<void>;
};

/** Browser settings, shown in their own tab. */
export function SettingsPage({
  activeSiteDomain,
  changeFilteringEnabled,
  changeSiteFilterException,
  clearBrowsingData,
  closeSettings,
  createTab,
  customPageContextMenuEnabled,
  setCustomPageContextMenuEnabled,
  filterBusy,
  filterProgress,
  filterSettings,
  message,
  sidebarSide,
  setSidebarSide,
  setSidebarView,
  tabPosition,
  setTabPosition,
  theme,
  setTheme,
  sidebarWidth,
  updateFilterList,
}: SettingsPageProps) {
  return (
    <section className="settings-page" aria-label="Settings">
      <header className="settings-heading">
        <div>
          <p className="eyebrow">UNKY</p>
          <h1>Settings</h1>
        </div>
        <AppButton className="settings-close" onClick={closeSettings} aria-label="Close settings">
          <X className="ui-icon" size={17} aria-hidden="true" />
        </AppButton>
      </header>
      <div className="settings-content">
        <h2>General</h2>
        <div className="settings-card">
          <div>
            <strong>Bookmarks</strong>
            <small>Saved locally in this browser profile.</small>
          </div>
          <AppButton
            onClick={() => {
              closeSettings();
              setSidebarView('bookmarks');
            }}
          >
            Manage bookmarks
          </AppButton>
        </div>
        <div className="settings-card">
          <div>
            <strong>Webpage context menu</strong>
            <small>Replace the page’s default right-click menu with browser actions.</small>
          </div>
          <label className="settings-toggle">
            <input
              type="checkbox"
              checked={customPageContextMenuEnabled}
              onChange={(event) => setCustomPageContextMenuEnabled(event.target.checked)}
            />
            <span>{customPageContextMenuEnabled ? 'On' : 'Off'}</span>
          </label>
        </div>
        <h2>Appearance</h2>
        <div className="settings-card">
          <div>
            <strong>Color scheme</strong>
            <small>Choose the browser interface appearance.</small>
          </div>
          <Select
            aria-label="Color scheme"
            selectedKey={theme}
            onSelectionChange={(key) => setTheme(key as Theme)}
            className="theme-select"
          >
            <AriaButton className="button-base theme-select-trigger" data-variant="secondary">
              <SelectValue />
            </AriaButton>
            <Popover className="theme-select-popover">
              <ListBox>
                <ListBoxItem id="system">System</ListBoxItem>
                <ListBoxItem id="light">Light</ListBoxItem>
                <ListBoxItem id="dark">Dark</ListBoxItem>
              </ListBox>
            </Popover>
          </Select>
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
        <h2>Privacy</h2>
        <div className="settings-card">
          <div>
            <strong>Private tab</strong>
            <small>
              Open a tab with ephemeral website storage. Private tabs are excluded from history and session recovery.
            </small>
          </div>
          <AppButton onClick={() => void createTab(true)}>New private tab</AppButton>
        </div>
        <div className="settings-card">
          <div>
            <strong>Clear browsing data</strong>
            <small>Clear website storage for this browser profile and remove browsing history.</small>
          </div>
          <AppButton onClick={() => void clearBrowsingData()}>Clear data</AppButton>
        </div>
        <div className="settings-card">
          <div>
            <strong>Content filtering</strong>
            <small>
              {filterSettings?.enabled
                ? filterSettings.updatedAt
                  ? 'EasyList based blocking is active for new and reloaded pages.'
                  : 'The built-in starter rules are active until EasyList is updated.'
                : 'Ad and tracker blocking is disabled.'}{' '}
              Changes reload open website tabs.
            </small>
          </div>
          <AppButton
            disabled={filterBusy || !filterSettings}
            onClick={() => void changeFilteringEnabled(!filterSettings?.enabled)}
          >
            {filterSettings?.enabled ? 'Turn off' : 'Turn on'}
          </AppButton>
        </div>
        <div className="settings-card">
          <div>
            <strong>Filter list</strong>
            <small>
              {filterSettings
                ? `${filterSettings.acceptedRules.toLocaleString()} supported rules · ${filterSettings.updatedAt ? `Updated ${new Date(filterSettings.updatedAt * 1000).toLocaleString()}` : 'Using the built-in starter set'}`
                : 'Loading filter status…'}{' '}
              The compiler skips unsupported EasyList syntax.
            </small>
            {filterBusy && (
              <div className="filter-update-progress" role="status" aria-live="polite">
                <span>
                  {filterProgress?.phase === 'compiling'
                    ? 'Compiling rules…'
                    : filterProgress?.totalBytes
                      ? `Downloading EasyList… ${Math.min(100, Math.floor((filterProgress.receivedBytes * 100) / filterProgress.totalBytes))}%`
                      : 'Connecting to EasyList…'}
                </span>
                {filterProgress?.phase === 'downloading' && filterProgress.totalBytes && (
                  <progress
                    aria-label="EasyList download progress"
                    max={100}
                    value={Math.min(100, Math.floor((filterProgress.receivedBytes * 100) / filterProgress.totalBytes))}
                  />
                )}
                {filterProgress?.phase === 'downloading' && !filterProgress.totalBytes && (
                  <progress aria-label="EasyList download progress" />
                )}
              </div>
            )}
          </div>
          <AppButton disabled={filterBusy} onClick={() => void updateFilterList()}>
            {filterBusy ? 'Updating…' : 'Update EasyList'}
          </AppButton>
        </div>
        <div className="settings-card">
          <div>
            <strong>Current site</strong>
            <small>
              {activeSiteDomain
                ? `Allow requests on ${activeSiteDomain} by disabling filtering for this site.`
                : 'Open a website to manage its filter exception.'}
            </small>
          </div>
          <AppButton
            disabled={filterBusy || !activeSiteDomain}
            onClick={() => void changeSiteFilterException(!filterSettings?.exceptions.includes(activeSiteDomain))}
          >
            {filterSettings?.exceptions.includes(activeSiteDomain) ? 'Enable for site' : 'Disable for site'}
          </AppButton>
        </div>
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
