import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = process.cwd();
const read = (path) => readFileSync(resolve(root, path), 'utf8');
const version = process.env.RELEASE_VERSION || JSON.parse(read('package.json')).version;
const packageVersion = JSON.parse(read('package.json')).version;
const tauriVersion = JSON.parse(read('src-tauri/tauri.conf.json')).version;
const cargoVersion = read('src-tauri/Cargo.toml').match(/^version\s*=\s*"([^"]+)"/m)?.[1];
if ([packageVersion, tauriVersion, cargoVersion].some((item) => item !== version)) {
  throw new Error(`Release version mismatch: expected ${version}; package=${packageVersion}, tauri=${tauriVersion}, cargo=${cargoVersion}`);
}

const changelog = read('CHANGELOG.md');
const section = changelog.match(new RegExp(`^## ${version.replaceAll('.', '\\.')}\\s*\\n([\\s\\S]*?)(?=^## |\\s*$)`, 'm'));
if (!section || !section[1].trim()) throw new Error(`CHANGELOG.md has no release notes under ## ${version}`);
const notes = section[1].trim();
const buildNumber = process.env.BUILD_NUMBER || process.env.GITHUB_RUN_NUMBER || 'local';
const builtAt = process.env.BUILD_TIMESTAMP || new Date().toISOString();
const commit = process.env.GITHUB_SHA || 'local';
const metadata = { version, buildNumber, builtAt, commit, notes };
const out = resolve(root, 'release-output');
mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'release.json'), `${JSON.stringify(metadata, null, 2)}\n`);
writeFileSync(join(out, 'RELEASE_NOTES.md'), `${notes}\n`);

const site = read('site/index.html');
const htmlEscape = (s) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const screenshotFile = `Unky_${version}_screenshot.png`;
if (process.env.RELEASE_VERSION && !readdirSync(resolve(root, process.env.ARTIFACT_DIR || 'release-artifacts')).includes(screenshotFile)) {
  throw new Error(`Release screenshot is missing: ${screenshotFile}`);
}
const generated = site.replace(/Unky_0\.1\.0_aarch64\.dmg/g, `Unky_${version}_aarch64.dmg`)
  .replace('Unky_0.1.0_screenshot.png', screenshotFile)
  .replace(/Version 0\.1\.0 · Apple Silicon/g, `Version ${version} · Apple Silicon`)
  .replace(/<section class="notice"/, `<section class="notice" aria-label="Release notes"><h2>Release ${htmlEscape(version)}</h2><p>${htmlEscape(notes).replaceAll('\n', '<br>')}</p></section><section class="notice"`);
writeFileSync(join(out, 'index.html'), generated);

const artifactDir = resolve(root, process.env.ARTIFACT_DIR || 'release-artifacts');
const files = readdirSync(artifactDir, { withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => {
  const path = join(artifactDir, entry.name);
  return { file: entry.name, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') };
});
if (!files.length) throw new Error(`No release installers found in ${artifactDir}`);
const mac = files.find(({ file }) => file.endsWith('_aarch64.dmg'));
const winX64 = files.find(({ file }) => /(?:^|[_-])(?:x64|x86_64)(?:[_-]|\.|$)/i.test(file) && file.endsWith('.exe'));
const winArm = files.find(({ file }) => /(?:^|[_-])(?:arm64|aarch64)(?:[_-]|\.|$)/i.test(file) && file.endsWith('.exe'));
const links = [];
if (mac) links.push(`<li><a href="./${htmlEscape(mac.file)}">Download macOS (Apple Silicon)</a></li>`);
if (winX64) links.push(`<li><a href="./${htmlEscape(winX64.file)}">Download Windows (x64)</a></li>`);
if (winArm) links.push(`<li><a href="./${htmlEscape(winArm.file)}">Download Windows (ARM64)</a></li>`);
const listing = `<ul>${links.join('')}</ul>`;
const page = generated.replace(/<a class="download" href="[^"]+" download>[\s\S]*?<\/a>/, `<a class="download" href="./${htmlEscape(mac?.file || '')}" download>Download for macOS</a>${listing}`);
writeFileSync(join(out, 'index.html'), page);
writeFileSync(join(out, 'SHA256SUMS.txt'), files.map(({ file, sha256 }) => `${sha256}  ${file}`).join('\n') + '\n');
console.log(`Prepared release candidate ${version} (build ${buildNumber})`);
