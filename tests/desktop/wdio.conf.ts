import { mkdirSync, readdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { withExecuteOptions } from '@wdio/tauri-service';

const root = process.cwd();
const results = resolve(process.env.DESKTOP_TEST_RESULTS ?? 'test-results');
const logs = join(results, 'wdio-logs');
const binary = resolve(root, 'target/debug/unky');

function captureNativeWindow(filename: string) {
  const result = resolve(results, filename);
  const windowId = execFileSync('swift', [resolve(root, 'tests/desktop/capture-window.swift')], {
    encoding: 'utf8',
  }).trim();
  execFileSync('screencapture', ['-x', '-l', windowId, result]);
  return result;
}

async function inspect(tabId?: string) {
  return browser.tauri.execute(
    ({ core }, id) => core.invoke('desktop_test_inspect_page', { tabId: id }),
    withExecuteOptions({ windowLabel: 'wdio-host' }),
    tabId,
  );
}

async function invoke(command: string, args: Record<string, unknown> = {}) {
  return browser.tauri.execute(
    ({ core }, name, payload) => core.invoke(name, payload),
    withExecuteOptions({ windowLabel: 'wdio-host' }),
    command,
    args,
  );
}

async function browserWindowLabels() {
  const labels = (await invoke('desktop_test_browser_ui', { action: 'inspect-windows' })) as string[];
  return labels.filter((label) => label.startsWith('browser-window-'));
}

/**
 * Close every extra native browser window not listed in `keep`.
 *
 * All spec files share one app process (the embedded provider launches it once in
 * `onPrepare`), so a leftover `browser-window-*` keeps OS focus and changes where
 * focus-routed menu actions land in later tests and specs.
 */
async function closeBrowserWindows(keep: readonly string[] = []) {
  const stray = (await browserWindowLabels()).filter((label) => !keep.includes(label));
  for (const label of stray) {
    await invoke('desktop_test_browser_ui', { action: 'close-window', windowLabel: label }).catch(() => undefined);
  }
  await browser.waitUntil(async () => !(await browserWindowLabels()).some((label) => !keep.includes(label)), {
    timeout: 5000,
    timeoutMsg: `Extra browser windows did not close: ${stray.join(', ')}`,
  });
}

/** Clear any split and close main-window tabs not listed in `keep`. */
async function closeTabs(keep: readonly string[]) {
  await invoke('clear_tab_split').catch(() => undefined);
  const state = (await invoke('get_browser_state')) as { tabs: Array<{ id: string }> };
  for (const tab of state.tabs.filter((item) => !keep.includes(item.id))) {
    await invoke('close_tab', { tabId: tab.id }).catch(() => undefined);
  }
  if (keep.includes('tab-1')) await invoke('select_tab', { tabId: 'tab-1' }).catch(() => undefined);
}

export const config: WebdriverIO.Config = {
  runner: 'local',
  specs: ['./specs/**/*.spec.ts'],
  maxInstances: 1,
  logLevel: 'info',
  framework: 'mocha',
  reporters: ['spec'],
  outputDir: logs,
  services: [
    [
      '@wdio/tauri-service',
      {
        appBinaryPath: binary,
        driverProvider: 'embedded',
        embeddedPort: 4445,
        windowLabel: 'wdio-host',
        startTimeout: 12000,
        commandTimeout: 30000,
        captureBackendLogs: true,
        captureFrontendLogs: true,
        backendLogLevel: 'debug',
        frontendLogLevel: 'error',
        logLevel: 'info',
        logDir: logs,
        env: {
          UNKY_PROFILE_DIR: resolve(results, 'disposable-profile'),
          UNKY_DATABASE_PATH: resolve(results, 'disposable-profile', 'browser.sqlite'),
          UNKY_TEST_EXTERNAL_OPEN: '1',
          RUST_LOG: 'info',
        },
      },
    ],
  ],
  capabilities: [{ browserName: 'tauri' }],
  mochaOpts: { ui: 'bdd', timeout: 90000 },
  waitforTimeout: 10000,
  onPrepare() {
    mkdirSync(logs, { recursive: true });
  },
  afterTest: async (_test, _context, result) => {
    if (result.error) {
      try {
        captureNativeWindow('failure-window.png');
      } catch (error) {
        appendFileSync(join(results, 'rust-logs.log'), `Screenshot failure: ${String(error)}\n`);
      }
      try {
        const page = await inspect();
        writeFileSync(join(results, 'browser-state.json'), JSON.stringify(page, null, 2));
        writeFileSync(join(results, 'frontend-errors.json'), JSON.stringify(page.errors ?? [], null, 2));
      } catch {
        // Failure diagnostics are best effort.
      }
    }
  },
  onComplete() {
    const destination = join(results, 'rust-logs.log');
    for (const file of readdirSync(logs)) {
      if (!/\.(log|txt|jsonl?)$/i.test(file)) continue;
      appendFileSync(destination, `\n===== ${file} =====\n${readFileSync(join(logs, file), 'utf8')}\n`);
    }
  },
};

export { browserWindowLabels, captureNativeWindow, closeBrowserWindows, closeTabs, inspect, invoke, results };
