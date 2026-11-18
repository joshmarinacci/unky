(() => {
  const icon = document.querySelector('link[rel~="icon" i], link[rel~="shortcut" i]');
  if (icon && icon.href) return icon.href;
  return /^https?:$/.test(location.protocol) ? new URL('/favicon.ico', location.href).href : '';
})();
