(() => {
  let lastUrl = window.location.href;
  const syncUrl = (kind) => {
    const url = window.location.href;
    if (url === lastUrl) return;
    lastUrl = url;
    window.__TAURI_INTERNALS__
      .invoke('sync_page_url', { url, kind })
      .catch((error) => console.error('Could not sync browser URL', error));
  };
  for (const [method, kind] of [
    ['pushState', 'push'],
    ['replaceState', 'replace'],
  ]) {
    const original = history[method];
    history[method] = function (...args) {
      const result = Reflect.apply(original, this, args);
      syncUrl(kind);
      return result;
    };
  }
  window.addEventListener('popstate', () => syncUrl('traverse'));
  window.addEventListener('hashchange', () => syncUrl('traverse'));
})();
