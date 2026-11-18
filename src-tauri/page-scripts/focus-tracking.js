(() => {
  let pending = false;
  const focusBrowserTab = (pointerDown = false) => {
    if (pending && !pointerDown) return;
    pending = true;
    window.__TAURI_INTERNALS__
      ?.invoke('focus_browser_tab', { pointerDown })
      .catch(() => {})
      .finally(() => {
        pending = false;
      });
  };
  window.addEventListener('focus', focusBrowserTab);
  document.addEventListener('pointerdown', () => focusBrowserTab(true), true);
})();
