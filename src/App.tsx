import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

type Tab = {
  id: string;
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  active: boolean;
};

type BrowserSnapshot = { tabs: Tab[]; activeTabId: string };
const tabEvent = 'browser://tabs-changed';
const sidebarDefaultWidth = 224;
const sidebarMinWidth = 176;
const sidebarMaxWidth = 360;

function initialSidebarWidth() {
  const saved = Number(localStorage.getItem('browser.sidebarWidth'));
  return Number.isFinite(saved) && saved >= sidebarMinWidth && saved <= sidebarMaxWidth
    ? saved
    : sidebarDefaultWidth;
}

export default function App() {
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeTabId, setActiveTabId] = useState('');
  const [address, setAddress] = useState('');
  const [message, setMessage] = useState('');
  const [isTauri, setIsTauri] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(initialSidebarWidth);
  const [resizingSidebar, setResizingSidebar] = useState(false);
  const addressRef = useRef<HTMLInputElement>(null);
  const viewRef = useRef<HTMLDivElement>(null);
  const activeTab = tabs.find(tab => tab.id === activeTabId);

  useEffect(() => {
    localStorage.setItem('browser.sidebarWidth', String(sidebarWidth));
  }, [sidebarWidth]);

  useEffect(() => {
    if (!resizingSidebar) return;
    const resize = (event: PointerEvent) => {
      const width = Math.max(sidebarMinWidth, Math.min(sidebarMaxWidth, event.clientX));
      setSidebarWidth(width);
      localStorage.setItem('browser.sidebarWidth', String(width));
    };
    const stop = () => setResizingSidebar(false);
    window.addEventListener('pointermove', resize);
    window.addEventListener('pointerup', stop, { once: true });
    return () => {
      window.removeEventListener('pointermove', resize);
      window.removeEventListener('pointerup', stop);
    };
  }, [resizingSidebar]);

  const applySnapshot = useCallback((snapshot: BrowserSnapshot) => {
    setTabs(snapshot.tabs);
    setActiveTabId(snapshot.activeTabId);
    const active = snapshot.tabs.find(tab => tab.id === snapshot.activeTabId);
    setAddress(active?.url ?? '');
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void (async () => {
      const available = Boolean((window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
      setIsTauri(available);
      if (!available) return;
      unlisten = await listen<BrowserSnapshot>(tabEvent, event => applySnapshot(event.payload));
      try { applySnapshot(await invoke<BrowserSnapshot>('get_browser_state')); }
      catch (error) { setMessage(String(error)); }
      if (cancelled) unlisten();
    })();
    return () => { cancelled = true; unlisten?.(); };
  }, [applySnapshot]);

  useEffect(() => {
    if (!isTauri || !viewRef.current) return;
    const view = viewRef.current;
    const updateBounds = () => {
      const rect = view.getBoundingClientRect();
      void invoke('set_view_bounds', { x: rect.left, y: rect.top, width: rect.width, height: rect.height })
        .catch(error => setMessage(String(error)));
    };
    const observer = new ResizeObserver(updateBounds);
    observer.observe(view);
    updateBounds();
    window.addEventListener('resize', updateBounds);
    return () => { observer.disconnect(); window.removeEventListener('resize', updateBounds); };
  }, [isTauri]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'ArrowLeft' && event.target instanceof HTMLElement && event.target.dataset.sidebarSizer) {
        event.preventDefault();
        setSidebarWidth(width => Math.max(sidebarMinWidth, width - 12));
      }
      if (event.key === 'ArrowRight' && event.target instanceof HTMLElement && event.target.dataset.sidebarSizer) {
        event.preventDefault();
        setSidebarWidth(width => Math.min(sidebarMaxWidth, width + 12));
      }
      if (!(event.metaKey || event.ctrlKey)) return;
      const key = event.key.toLowerCase();
      if (key === 'l') { event.preventDefault(); addressRef.current?.focus(); addressRef.current?.select(); }
      if (key === 't') { event.preventDefault(); void createTab(); }
      if (key === 'w' && activeTabId) { event.preventDefault(); void closeTab(activeTabId); }
      if (key === 'r' && activeTabId) { event.preventDefault(); void runNavigationCommand('reload'); }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  async function createTab() {
    try { applySnapshot(await invoke<BrowserSnapshot>('create_tab')); addressRef.current?.focus(); }
    catch (error) { setMessage(String(error)); }
  }

  async function selectTab(id: string) {
    try { applySnapshot(await invoke<BrowserSnapshot>('select_tab', { tabId: id })); }
    catch (error) { setMessage(String(error)); }
  }

  async function closeTab(id: string) {
    try { applySnapshot(await invoke<BrowserSnapshot>('close_tab', { tabId: id })); }
    catch (error) { setMessage(String(error)); }
  }

  async function navigate(event: React.FormEvent) {
    event.preventDefault();
    if (!activeTabId) return;
    try {
      setMessage('');
      await invoke('navigate', { tabId: activeTabId, url: address });
      addressRef.current?.blur();
    } catch (error) { setMessage(String(error)); }
  }

  async function navigateTo(url: string) {
    setAddress(url);
    if (!activeTabId) return;
    try { setMessage(''); await invoke('navigate', { tabId: activeTabId, url }); }
    catch (error) { setMessage(String(error)); }
  }

  async function runNavigationCommand(command: 'go_back' | 'go_forward' | 'reload' | 'stop_loading') {
    if (!activeTabId) return;
    try { await invoke(command, { tabId: activeTabId }); }
    catch (error) { setMessage(String(error)); }
  }

  return (
    <main className="browser-shell">
      <aside className="sidebar" style={{ width: sidebarWidth, flexBasis: sidebarWidth }}>
        <div className="brand-row"><div className="brand-mark">◉</div><span className="brand-name">My Browser</span><span className="sidebar-menu" aria-hidden="true">···</span></div>
        <div className="workspace-label">TABS</div>
        <div className="tab-list" role="tablist" aria-label="Open tabs">
          {tabs.map(tab => (
            <div className={`tab-row ${tab.id === activeTabId ? 'selected' : ''}`} key={tab.id}>
              <button className="tab-select" role="tab" aria-selected={tab.id === activeTabId} onClick={() => void selectTab(tab.id)} title={tab.url || 'New tab'}>
                <span className={`tab-favicon ${tab.loading ? 'is-loading' : ''}`}>{tab.loading ? '◌' : tab.url ? '◉' : '✳'}</span>
                <span className="tab-title">{tab.title || 'New Tab'}</span>
              </button>
              <button className="tab-close" aria-label={`Close ${tab.title || 'New Tab'}`} onClick={() => void closeTab(tab.id)}>×</button>
            </div>
          ))}
        </div>
        <button className="new-tab" onClick={() => void createTab()}><span>＋</span> New tab <kbd>⌘ T</kbd></button>
        <div className="sidebar-bottom">
          <button className="profile-button"><span className="avatar">J</span><span className="profile-copy"><strong>Personal</strong><small>Local profile</small></span><span className="profile-menu">···</span></button>
        </div>
        <div className={`sidebar-sizer ${resizingSidebar ? 'dragging' : ''}`} role="separator" aria-label="Resize tab sidebar" aria-orientation="vertical" aria-valuemin={sidebarMinWidth} aria-valuemax={sidebarMaxWidth} aria-valuenow={Math.round(sidebarWidth)} tabIndex={0} data-sidebar-sizer onPointerDown={event => { event.preventDefault(); setResizingSidebar(true); }} onDoubleClick={() => { setSidebarWidth(sidebarDefaultWidth); localStorage.removeItem('browser.sidebarWidth'); }} />
      </aside>

      <section className="browser-main">
        <header className="toolbar">
          <div className="nav-controls" aria-label="Page navigation">
            <button className="icon-button" title="Go back" aria-label="Go back" disabled={!activeTab?.canGoBack} onClick={() => void runNavigationCommand('go_back')}>‹</button>
            <button className="icon-button" title="Go forward" aria-label="Go forward" disabled={!activeTab?.canGoForward} onClick={() => void runNavigationCommand('go_forward')}>›</button>
            <button className="icon-button reload-button" title={activeTab?.loading ? 'Stop loading' : 'Reload'} aria-label={activeTab?.loading ? 'Stop loading' : 'Reload'} onClick={() => void runNavigationCommand(activeTab?.loading ? 'stop_loading' : 'reload')}>{activeTab?.loading ? '×' : '↻'}</button>
          </div>
          <form className="address-form" onSubmit={navigate}>
            <span className="security-icon" aria-hidden="true">{activeTab?.url.startsWith('https:') ? '▣' : '◌'}</span>
            <input ref={addressRef} aria-label="Search or enter address" autoComplete="off" spellCheck={false} placeholder="Search or enter address" value={address} onChange={event => setAddress(event.target.value)} onFocus={event => event.currentTarget.select()} />
            {activeTab?.url && <button type="button" className="clear-address" title="Clear address" onClick={() => { setAddress(''); addressRef.current?.focus(); }}>×</button>}
          </form>
          <button className="toolbar-action" title="Privacy filtering is not enabled yet" aria-label="Privacy filtering is not enabled yet" disabled><span>◈</span></button>
          <button className="toolbar-action profile-small" title="Profile" aria-label="Profile">J</button>
        </header>

        <div className="webview-slot" ref={viewRef}>
          {(!activeTab?.url || !isTauri) && <div className="start-page">
            <div className="start-orb">✳</div>
            <p className="eyebrow">A CLEARER PLACE TO BROWSE</p>
            <h1>Where to?</h1>
            <form className="start-search" onSubmit={navigate}><span>⌕</span><input aria-label="Search the web" placeholder="Search or enter a website" value={address} onChange={event => setAddress(event.target.value)} /><kbd>↵</kbd></form>
            {!isTauri && <p className="dev-note">Run the desktop app to open websites in the native browser view.</p>}
            {message && <p className="message" role="status">{message}</p>}
            <div className="quick-links"><button onClick={() => void navigateTo('https://www.google.com')}>Google</button><button onClick={() => void navigateTo('https://wikipedia.org')}>Wikipedia</button><button onClick={() => void navigateTo('https://github.com')}>GitHub</button></div>
          </div>}
          {message && activeTab?.url && <div className="toast" role="status">{message}</div>}
        </div>
        <footer className="statusbar"><span>{activeTab?.loading ? 'Loading page…' : activeTab?.url ? 'Ready' : 'Ready when you are'}</span><span className="protection-status"><i /> Filtering not enabled</span></footer>
      </section>
    </main>
  );
}
