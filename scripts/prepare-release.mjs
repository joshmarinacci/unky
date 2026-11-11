import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
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
const releaseSections = changelog.split(/^##\s+/m).slice(1).map((section) => {
  const [heading = '', ...body] = section.split(/\r?\n/);
  return { version: heading.trim(), notes: body.join('\n').trim() };
}).filter(({ version: sectionVersion, notes: sectionNotes }) =>
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(sectionVersion) && sectionNotes,
);
const currentRelease = releaseSections.find((release) => release.version === version);
if (!currentRelease) throw new Error(`CHANGELOG.md has no release notes under ## ${version}`);
const notes = currentRelease.notes;

const releaseDatesFile = process.env.RELEASE_DATES_FILE;
const publishedDates = new Map();
if (releaseDatesFile && existsSync(releaseDatesFile)) {
  const publishedReleases = JSON.parse(readFileSync(releaseDatesFile, 'utf8'));
  for (const release of publishedReleases) {
    const releaseVersion = release.tag_name?.replace(/^v/, '');
    const publishedAt = release.published_at && new Date(release.published_at);
    if (releaseVersion && publishedAt && !Number.isNaN(publishedAt.getTime())) {
      publishedDates.set(releaseVersion, publishedAt.toISOString().slice(0, 10));
    }
  }
}

const recentReleases = releaseSections.slice(0, 5);
const htmlEscape = (s) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
const releaseHistory = `<section class="notice release-history" aria-label="Recent release notes"><h2>Recent release notes</h2>${recentReleases.map((release) => {
  const date = publishedDates.get(release.version);
  const dateLabel = date ? `<time datetime="${date}">${date}</time>` : `<span class="release-date">${release.version === version ? 'Pending publication' : 'Release date unavailable'}</span>`;
  const list = release.notes.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    .map((line) => `<li>${htmlEscape(line.replace(/^[-*]\s+/, ''))}</li>`).join('');
  return `<article class="release-entry"><h3>Version ${htmlEscape(release.version)} ${dateLabel}</h3><ul>${list}</ul></article>`;
}).join('')}</section>`;
const buildNumber = process.env.BUILD_NUMBER || process.env.GITHUB_RUN_NUMBER || 'local';
const builtAt = process.env.BUILD_TIMESTAMP || new Date().toISOString();
const commit = process.env.GITHUB_SHA || 'local';
const metadata = { version, buildNumber, builtAt, commit, notes };
const out = resolve(root, 'release-output');
mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'release.json'), `${JSON.stringify(metadata, null, 2)}\n`);
writeFileSync(join(out, 'RELEASE_NOTES.md'), `${notes}\n`);

const site = read('site/index.html');
const screenshotFile = `Unky_${version}_screenshot.png`;
if (process.env.RELEASE_VERSION && !readdirSync(resolve(root, process.env.ARTIFACT_DIR || 'release-artifacts')).includes(screenshotFile)) {
  throw new Error(`Release screenshot is missing: ${screenshotFile}`);
}
const generated = site.replace(/Unky_0\.1\.0_aarch64\.dmg/g, `Unky_${version}_aarch64.dmg`)
  .replace('Unky_0.1.0_screenshot.png', screenshotFile)
  .replace(/Version 0\.1\.0 · Apple Silicon/g, `Version ${version} · Apple Silicon`)
  .replace(/<section\b(?=[^>]*\bid="release-notes")[^>]*>[\s\S]*?<\/section>/, releaseHistory.replace('<section class="notice release-history"', '<section id="release-notes" class="page release-history"'));
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
if (mac) links.push(`<a class="button" href="./${htmlEscape(mac.file)}" download>Download for macOS <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M12 3v12m0 0 4-4m-4 4-4-4M5 17v3h14v-3"/></svg></a>`);
if (winX64) links.push(`<a class="button platform-download" href="./${htmlEscape(winX64.file)}" download>Download for Windows · x64</a>`);
if (winArm) links.push(`<a class="button platform-download" href="./${htmlEscape(winArm.file)}" download>Download for Windows · ARM64</a>`);
const downloadLinks = `<div class="download-links">${links.join('')}</div>`;
const page = generated.replace(/<div id="download-links">[\s\S]*?<\/div>/, downloadLinks);
writeFileSync(join(out, 'index.html'), page);
writeFileSync(join(out, 'SHA256SUMS.txt'), files.map(({ file, sha256 }) => `${sha256}  ${file}`).join('\n') + '\n');
console.log(`Prepared release candidate ${version} (build ${buildNumber})`);
