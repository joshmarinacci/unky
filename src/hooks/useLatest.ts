import { useLayoutEffect, useRef } from 'react';

/**
 * A ref that always holds the latest `value`. Use it when a long-lived subscription (a Tauri
 * event listener set up once) must call the current version of handlers that change every
 * render, without resubscribing each time. The ref updates after render, before effects run.
 */
export function useLatest<T>(value: T) {
  const ref = useRef(value);
  useLayoutEffect(() => {
    ref.current = value;
  });
  return ref;
}
