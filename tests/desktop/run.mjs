import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const results = resolve(root, 'test-results');
const profile = resolve(results, 'disposable-profile');
mkdirSync(results, { recursive: true });
rmSync(profile, { recursive: true, force: true });
rmSync(resolve(results, 'wdio-logs'), { recursive: true, force: true });
mkdirSync(profile, { recursive: true });
for (const file of ['network-events.jsonl', 'browser-state.json', 'frontend-errors.json', 'rust-logs.log', 'native-window-inventory.json', 'real-site-tracker-results.json']) {
  rmSync(resolve(results, file), { force: true });
}
writeFileSync(resolve(profile, 'session.json'), JSON.stringify({
  version: 1,
  activeTabId: 'tab-1',
  tabs: [{
    id: 'tab-1',
    url: process.env.DESKTOP_TEST_SHOWCASE === '1' ? 'http://127.0.0.1:4179/showcase' : 'http://127.0.0.1:4179/',
    title: process.env.DESKTOP_TEST_SHOWCASE === '1' ? 'Wander · Field Notes' : 'Desktop fixture · One',
    zoom: 1,
  }],
  recentlyClosed: [],
}, null, 2));

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status}`);
}

if (process.platform !== 'darwin') throw new Error('Desktop tests require macOS (embedded WKWebView WebDriver).');
run('npm', ['run', 'tauri', '--', 'build', '--debug', '--no-bundle', '--features', 'desktop-test', '--config', 'src-tauri/tauri.desktop-test.conf.json']);

const networkLog = resolve(results, 'network-events.jsonl');
const fixtureToken = `desktop-test-${process.pid}-${Date.now()}`;
const server = spawn(process.execPath, [resolve(root, 'tests/desktop/serve-fixtures.mjs')], {
  cwd: root,
  env: { ...process.env, DESKTOP_TEST_NETWORK_LOG: networkLog, DESKTOP_TEST_SERVER_TOKEN: fixtureToken },
  stdio: ['ignore', 'inherit', 'inherit'],
});
await new Promise((resolveReady, reject) => {
  const deadline = Date.now() + 5000;
  const poll = async () => {
    try {
      const response = await fetch('http://127.0.0.1:4179/health');
      if (response.ok && (await response.json()).token === fixtureToken) return resolveReady();
    } catch {}
    if (server.exitCode !== null) return reject(new Error(`Fixture server exited with ${server.exitCode}`));
    if (Date.now() > deadline) return reject(new Error('Fixture server did not start'));
    setTimeout(poll, 100);
  };
  poll();
});

let code = 1;
try {
  const child = spawn('npx', ['wdio', 'run', 'tests/desktop/wdio.conf.ts', ...process.argv.slice(2)], {
    cwd: root,
    env: {
      ...process.env,
      MY_BROWSER_PROFILE_DIR: profile,
      UNKY_DATABASE_PATH: resolve(profile, 'browser.sqlite'),
      RUST_LOG: 'info',
      DESKTOP_TEST_RESULTS: results,
    },
    stdio: 'inherit',
  });
  code = await new Promise((resolveExit, reject) => {
    child.once('error', reject);
    child.once('exit', (status) => resolveExit(status ?? 1));
  });
} finally {
  server.kill('SIGTERM');
  const inventory = resolve(profile, 'wdio-window-inventory.json');
  try {
    const { copyFileSync } = await import('node:fs');
    copyFileSync(inventory, resolve(results, 'native-window-inventory.json'));
  } catch {}
}
process.exitCode = code;
