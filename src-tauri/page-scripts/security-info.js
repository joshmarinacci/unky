(() => {
  const cacheKey = '__unkySecurityPermissionState';
  const state = window[cacheKey] || (window[cacheKey] = {});
  for (const [name, key] of [
    ['geolocation', 'location'],
    ['camera', 'camera'],
    ['microphone', 'microphone'],
  ]) {
    if (state[key] === undefined && !state[`${key}Pending`]) {
      state[`${key}Pending`] = true;
      try {
        navigator.permissions
          .query({ name })
          .then((permission) => {
            state[key] = permission.state;
            permission.onchange = () => {
              state[key] = permission.state;
            };
          })
          .catch(() => {
            state[key] = 'unsupported';
          })
          .finally(() => {
            state[`${key}Pending`] = false;
          });
      } catch {
        state[key] = 'unsupported';
        state[`${key}Pending`] = false;
      }
    }
  }
  const mediaPlaying = [...document.querySelectorAll('audio,video')].some(
    (media) => !media.paused && !media.ended && !media.muted && media.volume > 0,
  );
  return JSON.stringify({
    origin: location.origin,
    secureHttps: location.protocol === 'https:' && window.isSecureContext,
    location: state.location || 'unknown',
    camera: state.camera || 'unknown',
    microphone: state.microphone || 'unknown',
    playingAudio: mediaPlaying,
  });
})();
