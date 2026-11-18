import { useEffect } from 'react';

/**
 * Read a stored preference for a `useState` initializer. Storage can be missing or blocked,
 * so a failed read is passed to `parse` as `null`.
 *
 * Pair with `usePersistedState` rather than returning state from a custom hook: setters from
 * `useState` itself are known to be stable, so effects that call them need no extra deps.
 */
export function readStored<T>(key: string, parse: (stored: string | null) => T): T {
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(key);
  } catch {
    // Use the parser's default.
  }
  return parse(stored);
}

/**
 * Write `value` to `localStorage[key]` whenever it changes. Failed writes (private windows,
 * blocked storage) keep the in-memory value. Pass a stable `serialize`, such as a module-level
 * function, since it is an effect dependency.
 *
 * ```ts
 * const [width, setWidth] = useState(() => readStored(storageKeys.sidebarWidth, parseSidebarWidth));
 * usePersistedState(storageKeys.sidebarWidth, width, String);
 * ```
 */
export function usePersistedState<T>(key: string, value: T, serialize: (value: T) => string = JSON.stringify): void {
  useEffect(() => {
    try {
      localStorage.setItem(key, serialize(value));
    } catch {
      // Keep the in-memory value.
    }
  }, [key, value, serialize]);
}
