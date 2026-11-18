document.addEventListener(
  'click',
  (event) => {
    window.__MY_BROWSER_LINK_HOOK__ = true;
    const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
    if (!link) return;
    if (event.button !== 0 || (!event.metaKey && link.target !== '_blank')) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    window.__MY_BROWSER_LINK_RESULT__ = 'pending';
    window.__TAURI_INTERNALS__
      .invoke('open_link_in_new_tab', { url: link.href, background: event.metaKey })
      .then(() => {
        window.__MY_BROWSER_LINK_RESULT__ = 'opened';
      })
      .catch((error) => {
        window.__MY_BROWSER_LINK_RESULT__ = String(error);
        console.error(error);
      });
  },
  true,
);
