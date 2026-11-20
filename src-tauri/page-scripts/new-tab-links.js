document.addEventListener(
  'click',
  (event) => {
    window.__UNKY_LINK_HOOK__ = true;
    const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
    if (!link) return;
    if (event.button !== 0 || (!event.metaKey && link.target !== '_blank')) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    window.__UNKY_LINK_RESULT__ = 'pending';
    window.__TAURI_INTERNALS__
      // Cmd-click opens behind the current tab; Cmd-Shift-click switches to it (Safari and Chrome).
      .invoke('open_link_in_new_tab', { url: link.href, background: event.metaKey && !event.shiftKey })
      .then(() => {
        window.__UNKY_LINK_RESULT__ = 'opened';
      })
      .catch((error) => {
        window.__UNKY_LINK_RESULT__ = String(error);
        console.error(error);
      });
  },
  true,
);
