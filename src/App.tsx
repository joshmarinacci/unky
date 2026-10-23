import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

export default function App() {
  const [address, setAddress] = useState('http://127.0.0.1:4179/');
  const [status, setStatus] = useState('Ready');
  async function navigate(event: React.FormEvent) {
    event.preventDefault();
    try { await invoke('navigate', { url: address }); setStatus('Navigation requested'); }
    catch (error) { setStatus(String(error)); }
  }
  return <main className="shell">
    <aside className="sidebar"><div className="brand">◉ <span>Browser</span></div><button className="tab active">＋ <span>New tab</span></button><div className="sidebar-foot">Prototype · Milestone 0</div></aside>
    <section className="content"><header><nav aria-label="Navigation"><button title="Back" disabled>←</button><button title="Forward" disabled>→</button><button title="Reload" disabled>↻</button></nav><form onSubmit={navigate}><input aria-label="Address" value={address} onChange={e => setAddress(e.target.value)} /><button type="submit">Go</button></form></header><div className="page"><div className="empty-icon">◇</div><h1>Browser foundation</h1><p>The trusted browser interface is running.</p><p className="status">{status}</p><p className="hint">Start the fixture server with <code>python3 tests/fixtures/server.py</code>, then use the address bar.</p></div></section>
  </main>;
}
