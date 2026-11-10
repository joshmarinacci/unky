import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';

const args = process.argv.slice(2);
let dryRun = false;
let notesArgument;
let fromGit = false;
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === '--dry-run') {
    dryRun = true;
  } else if (args[index] === '--from-git') {
    fromGit = true;
  } else if (args[index] === '--notes' && notesArgument === undefined && args[index + 1] && !args[index + 1].startsWith('--')) {
    notesArgument = args[index + 1];
    index += 1;
  } else {
    console.error('Usage: npm run release:patch [-- --dry-run] [--from-git | --notes "Release note"]');
    process.exit(1);
  }
}

if (fromGit && notesArgument !== undefined) {
  throw new Error('Choose either --from-git or --notes, not both');
}

const read = (path) => readFileSync(path, 'utf8');
const packageJson = JSON.parse(read('package.json'));
const packageLock = JSON.parse(read('package-lock.json'));
const tauriConfig = JSON.parse(read('src-tauri/tauri.conf.json'));
const cargoToml = read('src-tauri/Cargo.toml');
const cargoLock = read('Cargo.lock');
const changelog = read('CHANGELOG.md');

const currentVersion = packageJson.version;
const versionMatch = currentVersion.match(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
if (!versionMatch || !versionMatch.slice(1).every((part) => Number.isSafeInteger(Number(part)))) {
  throw new Error(`Expected a stable x.y.z version in package.json, got ${currentVersion}`);
}
const [, major, minor, patch] = versionMatch;
const nextVersion = `${major}.${minor}.${Number(patch) + 1}`;

const cargoPackageStart = cargoToml.indexOf('[package]');
const cargoPackageEnd = cargoToml.slice(cargoPackageStart + '[package]'.length).search(/^\[/m);
if (cargoPackageStart < 0) throw new Error('src-tauri/Cargo.toml has no [package] section');
const cargoPackage = cargoPackageEnd < 0
  ? cargoToml.slice(cargoPackageStart)
  : cargoToml.slice(cargoPackageStart, cargoPackageStart + '[package]'.length + cargoPackageEnd);
const cargoVersionMatch = cargoPackage.match(/^version\s*=\s*"([^"]+)"/m);
if (!cargoVersionMatch) throw new Error('Could not find the package version in src-tauri/Cargo.toml');

const cargoLockVersionMatches = [...cargoLock.matchAll(/^\[\[package\]\]\nname = "my-browser"\nversion = "([^"]+)"/gm)];
if (cargoLockVersionMatches.length !== 1) throw new Error(`Expected one my-browser package in Cargo.lock, found ${cargoLockVersionMatches.length}`);

const versions = [
  ['package.json', packageJson.version],
  ['package-lock.json', packageLock.version],
  ['package-lock.json packages[""]', packageLock.packages?.['']?.version],
  ['src-tauri/tauri.conf.json', tauriConfig.version],
  ['src-tauri/Cargo.toml', cargoVersionMatch[1]],
  ['Cargo.lock my-browser package', cargoLockVersionMatches[0][1]],
];
const mismatches = versions.filter(([, value]) => value !== currentVersion);
if (mismatches.length) {
  throw new Error(`Version values do not match package.json (${currentVersion}): ${mismatches.map(([path, value]) => `${path}=${value ?? 'missing'}`).join(', ')}`);
}

if (changelog.includes(`## ${nextVersion}\n`)) {
  throw new Error(`CHANGELOG.md already has a section for ${nextVersion}`);
}
const firstReleaseHeading = changelog.search(/^##\s+/m);
if (firstReleaseHeading < 0) throw new Error('CHANGELOG.md has no release section to insert before');

function suggestedGitNotes() {
  const tag = `v${currentVersion}`;
  const existingTag = execFileSync('git', ['tag', '--list', tag], { encoding: 'utf8' }).trim();
  if (!existingTag) return [];
  return execFileSync('git', ['log', '--format=%s', '--no-merges', `${tag}..HEAD`], { encoding: 'utf8' })
    .split(/\r?\n/)
    .map((subject) => subject.trim())
    .filter((subject) => subject && !/^prepare \d+\.\d+\.\d+ release$/i.test(subject));
}

async function enterNotes(rl) {
  const lines = [];
  console.log('Enter user-facing release notes, one per line. Submit an empty line to finish.');
  while (true) {
    const line = await rl.question('> ');
    if (!line.trim()) break;
    lines.push(line);
  }
  return lines.join('\n');
}

function editorCommandParts(command) {
  return (command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [])
    .map((part) => part.replace(/^(['"])(.*)\1$/, '$2'));
}

function editNotesInPreferredEditor(initialNotes) {
  const editor = process.env.VISUAL || process.env.EDITOR || (process.platform === 'win32' ? 'notepad' : 'vi');
  const [command, ...editorArgs] = editorCommandParts(editor);
  if (!command) throw new Error('No editor command was configured');

  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'unky-release-notes-'));
  const notesPath = join(temporaryDirectory, 'release-notes.md');
  writeFileSync(notesPath, `${initialNotes.trim()}\n`);
  console.log(`Opening draft release notes in ${editor}. Save and close the editor to continue.`);
  try {
    const result = spawnSync(command, [...editorArgs, notesPath], { stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Editor exited with status ${result.status ?? 'unknown'}`);
    return readFileSync(notesPath, 'utf8');
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

async function readReleaseNotes() {
  if (notesArgument !== undefined) return notesArgument;
  const gitNotes = suggestedGitNotes();
  if (fromGit) {
    if (!gitNotes.length) throw new Error(`No commits found after v${currentVersion}; enter notes manually instead`);
    return gitNotes.join('\n');
  }
  if (!process.stdin.isTTY) return readFileSync(0, 'utf8');

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    if (gitNotes.length) {
      console.log(`Draft notes from commits since v${currentVersion}:`);
      for (const note of gitNotes) console.log(`- ${note}`);
      rl.close();
      return editNotesInPreferredEditor(gitNotes.join('\n'));
    }
    return await enterNotes(rl);
  } finally {
    if (rl) rl.close();
  }
}

const rawNotes = await readReleaseNotes();
const notes = rawNotes.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) =>
  /^[-*]\s+/.test(line) ? `- ${line.replace(/^[-*]\s+/, '')}` : `- ${line}`,
).join('\n');
if (!notes) throw new Error('At least one user-facing release note is required; no files were changed');

const releaseSection = `## ${nextVersion}\n\n${notes}\n\n`;
packageJson.version = nextVersion;
packageLock.version = nextVersion;
packageLock.packages[''].version = nextVersion;
tauriConfig.version = nextVersion;
const updatedCargoToml = cargoToml.replace(/^version\s*=\s*"[^"]+"/m, `version = "${nextVersion}"`);
const updatedCargoLock = cargoLock.replace(
  /^(\[\[package\]\]\nname = "my-browser"\nversion = ")[^"]+"/m,
  (_match, prefix) => `${prefix}${nextVersion}"`,
);
const updatedChangelog = `${changelog.slice(0, firstReleaseHeading)}${releaseSection}${changelog.slice(firstReleaseHeading)}`;

if (dryRun) {
  console.log(`Dry run: no files were changed.\n\nVersion: ${currentVersion} → ${nextVersion}\n\nPlanned updates:`);
  console.log(`- package.json: version ${currentVersion} → ${nextVersion}`);
  console.log(`- package-lock.json: root version ${currentVersion} → ${nextVersion}`);
  console.log(`- package-lock.json packages[""]: version ${currentVersion} → ${nextVersion}`);
  console.log(`- src-tauri/tauri.conf.json: version ${currentVersion} → ${nextVersion}`);
  console.log(`- src-tauri/Cargo.toml: [package] version ${currentVersion} → ${nextVersion}`);
  console.log(`- Cargo.lock: my-browser version ${currentVersion} → ${nextVersion}`);
  console.log(`- CHANGELOG.md: prepend this release section:\n\n${releaseSection.trimEnd()}`);
} else {
  writeFileSync('package.json', `${JSON.stringify(packageJson, null, 2)}\n`);
  writeFileSync('package-lock.json', `${JSON.stringify(packageLock, null, 2)}\n`);
  writeFileSync('src-tauri/tauri.conf.json', `${JSON.stringify(tauriConfig, null, 2)}\n`);
  writeFileSync('src-tauri/Cargo.toml', updatedCargoToml);
  writeFileSync('Cargo.lock', updatedCargoLock);
  writeFileSync('CHANGELOG.md', updatedChangelog);
  console.log(`Updated version ${currentVersion} → ${nextVersion} and added release notes.`);
}
