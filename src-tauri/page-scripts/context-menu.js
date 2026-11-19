// Custom webpage context menu, injected into every website tab by lib.rs.
// Before injection, Rust substitutes the all-caps menu-label flag used below with
// true in desktop-test builds and false otherwise.
(() => {
  const host = document.createElement('div');
  host.setAttribute('aria-hidden', 'true');
  if (EXPOSE_MENU_ITEMS) host.dataset.menuItems = '[]';
  const shadow = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = `
                :host { all: initial; position: fixed; inset: 0; z-index: 2147483647; pointer-events: none; color-scheme: light dark; }
                .menu { position: fixed; min-width: 190px; max-width: 300px; padding: 5px; border: 1px solid color-mix(in srgb, CanvasText 16%, transparent); border-radius: 9px; color: CanvasText; background: Canvas; box-shadow: 0 8px 28px #0005; font: 13px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; pointer-events: auto; }
                .submenu { position: fixed; min-width: 190px; max-width: 300px; padding: 5px; border: 1px solid color-mix(in srgb, CanvasText 16%, transparent); border-radius: 9px; color: CanvasText; background: Canvas; box-shadow: 0 8px 28px #0005; font: 13px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; pointer-events: auto; }
                .submenu[hidden] { display: none; }
                button { display: block; width: 100%; padding: 7px 10px; border: 0; border-radius: 5px; color: inherit; background: transparent; font: inherit; text-align: left; cursor: default; }
                button:hover, button:focus-visible { outline: none; background: color-mix(in srgb, Highlight 18%, transparent); }
                .submenu-trigger { display: flex; align-items: center; justify-content: space-between; }
                .submenu-arrow { margin-left: 18px; color: color-mix(in srgb, CanvasText 58%, transparent); }
                .separator { height: 1px; margin: 4px 5px; background: color-mix(in srgb, CanvasText 14%, transparent); }
              `;
  shadow.append(style);
  let menu;
  const close = () => {
    menu?.remove();
    menu = undefined;
    host.setAttribute('aria-hidden', 'true');
  };
  const copyText = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const field = document.createElement('textarea');
      field.value = text;
      field.style.position = 'fixed';
      field.style.opacity = '0';
      document.documentElement.append(field);
      field.select();
      document.execCommand('copy');
      field.remove();
    }
  };
  window.addEventListener(
    'contextmenu',
    (event) => {
      if (!window.__UNKY_CUSTOM_CONTEXT_MENU_ENABLED__) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      close();
      const target = event.target instanceof Element ? event.target : null;
      const link = target?.closest('a[href]');
      const image = target?.closest('img');
      const selectedText = String(window.getSelection()?.toString() || '').trim();
      const items = [];
      const foldersPromise = link
        ? Promise.resolve(window.__TAURI_INTERNALS__?.invoke('get_tab_folders'))
            .then((folders) => folders || [])
            .catch(() => [])
        : Promise.resolve([]);
      const browsersPromise = link
        ? Promise.resolve(window.__TAURI_INTERNALS__?.invoke('get_external_browsers'))
            .then((browsers) => browsers || [])
            .catch(() => [])
        : Promise.resolve([]);
      const add = (label, action) => items.push({ label, action });
      const separate = () => {
        if (items.length && !items[items.length - 1].separator) items.push({ separator: true });
      };
      if (link) {
        add('Open Link in Other Split', async () => {
          await window.__TAURI_INTERNALS__?.invoke('open_link_in_new_tab', { url: link.href, otherSplit: true });
        });
        add('Open Link in New Tab', () =>
          window.__TAURI_INTERNALS__?.invoke('open_link_in_new_tab', { url: link.href }),
        );
        add('Open Link in New Window', () =>
          window.__TAURI_INTERNALS__?.invoke('open_link_in_new_window', { url: link.href }),
        );
        add('Copy Link Address', () => copyText(link.href));
      }
      if (image) {
        if (link) separate();
        add('Open Image in New Tab', () =>
          window.__TAURI_INTERNALS__?.invoke('open_link_in_new_tab', { url: image.currentSrc || image.src }),
        );
        add('Copy Image Address', () => copyText(image.currentSrc || image.src));
      }
      if (selectedText) {
        separate();
        add('Copy', () => document.execCommand('copy'));
      }
      if (items.length) separate();
      add('Back', () => history.back());
      add('Forward', () => history.forward());
      add('Reload', () => location.reload());
      separate();
      add('Select All', () => document.execCommand('selectAll'));
      menu = document.createElement('div');
      menu.className = 'menu';
      menu.setAttribute('role', 'menu');
      for (const item of items) {
        if (item.separator) {
          const divider = document.createElement('div');
          divider.className = 'separator';
          divider.setAttribute('role', 'separator');
          menu.append(divider);
          continue;
        }
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = item.label;
        button.setAttribute('role', 'menuitem');
        button.addEventListener('click', () => {
          const result = item.action();
          if (result?.then)
            result.then(close).catch((error) => {
              button.textContent = `Failed: ${String(error)}`;
              button.style.whiteSpace = 'normal';
            });
          else close();
        });
        menu.append(button);
      }
      const updateMenuItems = () => {
        if (EXPOSE_MENU_ITEMS)
          host.dataset.menuItems = JSON.stringify(
            Array.from(menu.querySelectorAll('button')).map((button) => button.dataset.label || button.textContent),
          );
      };
      updateMenuItems();
      shadow.append(menu);
      host.setAttribute('aria-hidden', 'false');
      const bounds = menu.getBoundingClientRect();
      menu.style.left = Math.max(4, Math.min(event.clientX, innerWidth - bounds.width - 4)) + 'px';
      menu.style.top = Math.max(4, Math.min(event.clientY, innerHeight - bounds.height - 4)) + 'px';
      menu.querySelector('button')?.focus({ preventScroll: true });
      const currentMenu = menu;
      foldersPromise.then((folders) => {
        if (!folders.length || menu !== currentMenu) return;
        const firstItem = currentMenu.querySelector('button');
        if (!firstItem) return;
        const separator = document.createElement('div');
        separator.className = 'separator';
        separator.setAttribute('role', 'separator');
        const trigger = document.createElement('button');
        trigger.type = 'button';
        trigger.className = 'submenu-trigger';
        trigger.setAttribute('role', 'menuitem');
        trigger.setAttribute('aria-haspopup', 'menu');
        trigger.setAttribute('aria-expanded', 'false');
        trigger.textContent = 'Open Link in Tab Folder';
        trigger.dataset.label = trigger.textContent;
        const arrow = document.createElement('span');
        arrow.className = 'submenu-arrow';
        arrow.setAttribute('aria-hidden', 'true');
        arrow.textContent = '›';
        trigger.append(arrow);
        const submenu = document.createElement('div');
        submenu.className = 'submenu';
        submenu.setAttribute('role', 'menu');
        submenu.setAttribute('aria-label', 'Open link in tab folder');
        submenu.hidden = true;
        const positionSubmenu = () => {
          submenu.hidden = false;
          const triggerBounds = trigger.getBoundingClientRect();
          const submenuBounds = submenu.getBoundingClientRect();
          const left =
            triggerBounds.right + submenuBounds.width + 8 <= innerWidth
              ? triggerBounds.right + 4
              : triggerBounds.left - submenuBounds.width - 4;
          submenu.style.left = Math.max(4, left) + 'px';
          submenu.style.top = Math.max(4, Math.min(triggerBounds.top, innerHeight - submenuBounds.height - 4)) + 'px';
        };
        trigger.addEventListener('click', () => {
          if (submenu.hidden) positionSubmenu();
          else submenu.hidden = true;
          trigger.setAttribute('aria-expanded', String(!submenu.hidden));
        });
        trigger.addEventListener('keydown', (event) => {
          if (event.key === 'ArrowRight') {
            event.preventDefault();
            positionSubmenu();
            trigger.setAttribute('aria-expanded', 'true');
            submenu.querySelector('button')?.focus();
          }
          if (event.key === 'Escape' && !submenu.hidden) {
            event.preventDefault();
            submenu.hidden = true;
            trigger.setAttribute('aria-expanded', 'false');
            trigger.focus();
          }
        });
        for (const folder of folders) {
          const button = document.createElement('button');
          button.type = 'button';
          button.textContent = 'Open Link in New Tab in “' + folder.title + '”';
          button.setAttribute('role', 'menuitem');
          button.addEventListener('click', () => {
            const result = window.__TAURI_INTERNALS__?.invoke('open_link_in_tab_folder', {
              url: link.href,
              folderId: folder.id,
            });
            if (result?.catch) result.catch(() => {});
            close();
          });
          submenu.append(button);
        }
        firstItem.after(separator, trigger);
        currentMenu.append(submenu);
        updateMenuItems();
        const updatedBounds = currentMenu.getBoundingClientRect();
        currentMenu.style.left = Math.max(4, Math.min(event.clientX, innerWidth - updatedBounds.width - 4)) + 'px';
        currentMenu.style.top = Math.max(4, Math.min(event.clientY, innerHeight - updatedBounds.height - 4)) + 'px';
      });
      browsersPromise.then((browsers) => {
        if (!browsers.length || menu !== currentMenu) return;
        const trigger = document.createElement('button');
        trigger.type = 'button';
        trigger.className = 'submenu-trigger';
        trigger.setAttribute('role', 'menuitem');
        trigger.setAttribute('aria-haspopup', 'menu');
        trigger.setAttribute('aria-expanded', 'false');
        trigger.textContent = 'Open Link in Another Browser';
        trigger.dataset.label = trigger.textContent;
        const arrow = document.createElement('span');
        arrow.className = 'submenu-arrow';
        arrow.setAttribute('aria-hidden', 'true');
        arrow.textContent = '›';
        trigger.append(arrow);
        const submenu = document.createElement('div');
        submenu.className = 'submenu';
        submenu.setAttribute('role', 'menu');
        submenu.setAttribute('aria-label', 'Open link in another browser');
        submenu.hidden = true;
        for (const browser of browsers) {
          const button = document.createElement('button');
          button.type = 'button';
          button.textContent = browser.name;
          button.setAttribute('role', 'menuitem');
          button.addEventListener('click', async () => {
            try {
              await window.__TAURI_INTERNALS__?.invoke('open_in_external_browser', {
                browserId: browser.id,
                url: link.href,
              });
              close();
            } catch (error) {
              button.textContent = `Failed: ${String(error)}`;
              button.style.whiteSpace = 'normal';
            }
          });
          submenu.append(button);
        }
        trigger.addEventListener('click', () => {
          submenu.hidden = !submenu.hidden;
          trigger.setAttribute('aria-expanded', String(!submenu.hidden));
        });
        currentMenu.append(trigger, submenu);
        updateMenuItems();
      });
    },
    true,
  );
  document.addEventListener(
    'pointerdown',
    (event) => {
      if (menu && !host.contains(event.target)) close();
    },
    true,
  );
  document.addEventListener(
    'keydown',
    (event) => {
      if (event.key === 'Escape' && menu) {
        close();
        event.stopPropagation();
      }
    },
    true,
  );
  document.documentElement.append(host);
})();
