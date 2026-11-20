import { beforeEach, expect, test, vi } from 'vitest';

const listen = vi.fn(async () => () => undefined);
vi.mock('@tauri-apps/api/event', () => ({ listen }));
vi.mock('@tauri-apps/api/webview', () => ({ getCurrentWebview: () => ({ label: 'browser-window-7' }) }));

const { onEvent, shortcutEvent } = await import('../src/ipc.ts');

beforeEach(() => listen.mockClear());

test('events are received only when sent to this window (regression: ⌘P printed in every window)', async () => {
  const handler = () => undefined;
  await onEvent(shortcutEvent, handler);
  expect(listen).toHaveBeenCalledWith(shortcutEvent, handler, {
    target: { kind: 'AnyLabel', label: 'browser-window-7' },
  });
});
