import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';

const root = process.cwd();
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const buildNumber = process.env.BUILD_NUMBER || process.env.GITHUB_RUN_NUMBER || 'local';
const builtAt = process.env.BUILD_TIMESTAMP || new Date().toISOString();
const commit = process.env.GITHUB_SHA || (() => {
  try { return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(); }
  catch { return 'unknown'; }
})();
const metadata = { version: pkg.version, buildNumber, builtAt, commit };
const output = resolve(root, 'src/build-metadata.json');
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, `${JSON.stringify(metadata, null, 2)}\n`);
const envLine = (key, value) => `${key}=${String(value).replaceAll('%', '%25').replaceAll('\n', '%0A').replaceAll('\r', '%0D')}\n`;
if (process.env.GITHUB_ENV) appendFileSync(process.env.GITHUB_ENV, ['BUILD_TIMESTAMP', 'BUILD_COMMIT', 'BUILD_VERSION', 'BUILD_NUMBER'].map((key, i) => envLine(key, [builtAt, commit, pkg.version, buildNumber][i])).join(''));
writeFileSync(resolve(root, 'src-tauri/build-metadata.env'), `BUILD_NUMBER=${buildNumber}\nBUILD_TIMESTAMP=${builtAt}\nBUILD_COMMIT=${commit}\n`);
console.log(`Build ${buildNumber} at ${builtAt} (${commit})`);
