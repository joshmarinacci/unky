/** Platform details for shortcut labels. */
export const isApplePlatform = /Mac|iPhone|iPad/.test(navigator.platform);
/** The primary shortcut modifier as shown in labels: ⌘ on Apple platforms, Ctrl elsewhere. */
export const commandKey = isApplePlatform ? '⌘' : 'Ctrl';
