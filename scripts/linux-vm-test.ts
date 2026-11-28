// Prepares the UTM Linux test VM (see docs/linux.md): restores its clean snapshot, installs a
// Linux test package from a "Build desktop bundles" run, serves the gesture check page inside the
// VM, and opens it in Unky on the VM's desktop. macOS host only. Run: npm run vm:linux-test -- --help
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { isIPv4 } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs, promisify } from 'node:util';

const UTMCTL = '/Applications/UTM.app/Contents/MacOS/utmctl';
const LEASES_FILE = '/var/db/dhcpd_leases';
const WORKFLOW = 'build-bundles.yml';
const REMOTE_DIR = 'unky-test';
const PAGE = path.join(import.meta.dirname, '../tests/manual/gesture-check.html');
const PORT = 8000;

const config = {
  vm: process.env.UNKY_VM ?? 'Ubuntu 24.04 (Unky test)',
  snapshot: process.env.UNKY_VM_SNAPSHOT ?? 'clean install',
  hostname: process.env.UNKY_VM_HOSTNAME ?? 'unky-test',
  user: process.env.UNKY_VM_USER ?? 'unky',
  key: process.env.UNKY_VM_KEY ?? path.join(homedir(), '.ssh/unky-vm_ed25519'),
  knownHosts: process.env.UNKY_VM_KNOWN_HOSTS ?? path.join(homedir(), '.ssh/unky-vm_known_hosts'),
  artifact: process.env.UNKY_VM_ARTIFACT ?? 'linux-test-packages-ARM64',
};

const USAGE = `Usage: npm run vm:linux-test -- [options]

Restores the "${config.snapshot}" snapshot of the UTM VM "${config.vm}", installs Unky,
serves tests/manual/gesture-check.html at http://localhost:${PORT}/ inside the VM, and opens it in Unky.

Options:
  --run <id>      Workflow run to take the package from (default: latest successful ${WORKFLOW} run)
  --deb <path>    Install this local .deb instead of downloading one
  --xorg          Log the desktop into the "Ubuntu on Xorg" session instead of Wayland
  --keep-state    Do not restore the snapshot (reuse the VM as it is)
  --no-launch     Install and serve the page, but do not open Unky
  -h, --help      Show this help

Environment overrides: UNKY_VM, UNKY_VM_SNAPSHOT, UNKY_VM_HOSTNAME, UNKY_VM_USER,
UNKY_VM_KEY, UNKY_VM_KNOWN_HOSTS, UNKY_VM_ARTIFACT.`;

interface Lease {
  name: string;
  ip: string;
  expires: number;
}

/** Parses macOS bootpd's lease file (UTM shared networking) into leases, newest first. */
export function parseLeases(text: string): Lease[] {
  return text
    .split('}')
    .flatMap((block) => {
      const fields = new Map<string, string>();
      for (const line of block.split('\n')) {
        const separator = line.indexOf('=');
        if (separator > 0) fields.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
      }
      const name = fields.get('name');
      const ip = fields.get('ip_address');
      if (!name || !ip) return [];
      return [{ name, ip, expires: Number.parseInt(fields.get('lease') ?? '0', 16) || 0 }];
    })
    .sort((a, b) => b.expires - a.expires);
}

/** Quotes a value for a POSIX shell command run over SSH. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

const execFileAsync = promisify(execFile);

async function run(command: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync(command, args, { maxBuffer: 64 * 1024 * 1024 });
    return stdout.trim();
  } catch (error) {
    const stderr = error instanceof Error && 'stderr' in error ? String(error.stderr).trim() : '';
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${path.basename(command)} ${args.join(' ')} failed:\n${stderr || message}`, {
      cause: error,
    });
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor<T>(what: string, timeoutMs: number, check: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await check().catch(() => undefined);
    if (result !== undefined) return result;
    if (Date.now() > deadline) throw new Error(`Timed out after ${timeoutMs / 1000}s waiting for ${what}`);
    await sleep(2000);
  }
}

function step(message: string) {
  console.log(`\n▸ ${message}`);
}

const utm = (...args: string[]) => run(UTMCTL, args);

const SSH_OPTIONS = [
  ['-i', config.key],
  ['-o', `UserKnownHostsFile=${config.knownHosts}`],
  ['-o', 'StrictHostKeyChecking=accept-new'],
  ['-o', 'BatchMode=yes'],
  ['-o', 'ConnectTimeout=5'],
].flat();

const ssh = (host: string, command: string) => run('ssh', [...SSH_OPTIONS, `${config.user}@${host}`, command]);

const scp = (host: string, files: string[], destination: string) =>
  run('scp', [...SSH_OPTIONS, ...files, `${config.user}@${host}:${destination}`]);

async function vmStatus(): Promise<string> {
  return utm('status', config.vm);
}

async function restoreSnapshot() {
  const status = await vmStatus();
  if (status !== 'stopped') {
    step(`Stopping the VM (it is ${status})`);
    await utm('stop', config.vm);
    await waitFor('the VM to stop', 60_000, async () => ((await vmStatus()) === 'stopped' ? true : undefined));
  }
  step(`Restoring snapshot "${config.snapshot}"`);
  await utm('snapshot', 'restore', config.vm, '--snapshot', config.snapshot);
}

/** Addresses the VM may have: from its guest agent if that answers, else from DHCP leases. */
async function candidateAddresses(): Promise<string[]> {
  const fromAgent = await utm('ip-address', config.vm).then(
    (output) => output.split('\n').map((line) => line.trim()),
    () => [],
  );
  const leases = parseLeases(await readFile(LEASES_FILE, 'utf8').catch(() => ''));
  const fromLeases = leases.filter((lease) => lease.name === config.hostname).map((lease) => lease.ip);
  return [...new Set([...fromAgent, ...fromLeases])].filter((ip) => isIPv4(ip));
}

/** Waits until SSH reaches a machine that reports the VM's hostname, so a stale lease can't fool it. */
async function waitForHost(): Promise<string> {
  return waitFor('SSH to the VM', 240_000, async () => {
    for (const ip of await candidateAddresses()) {
      if ((await ssh(ip, 'hostname').catch(() => '')) === config.hostname) return ip;
    }
    return undefined;
  });
}

interface Package {
  file: string;
  source: string;
}

async function downloadPackage(runId: string | undefined): Promise<Package> {
  const runs: { databaseId: number; headBranch: string; headSha: string }[] = JSON.parse(
    await run('gh', [
      'run',
      'list',
      '--workflow',
      WORKFLOW,
      '--status',
      'success',
      '--limit',
      runId ? '50' : '1',
      '--json',
      'databaseId,headBranch,headSha',
    ]),
  );
  const chosen = runId ? runs.find((entry) => String(entry.databaseId) === runId) : runs[0];
  const id = runId ?? String(chosen?.databaseId ?? '');
  if (!id)
    throw new Error(`No successful ${WORKFLOW} run found. Start one with: gh workflow run ${WORKFLOW} --ref <branch>`);
  const directory = await mkdtemp(path.join(tmpdir(), 'unky-linux-package-'));
  await run('gh', ['run', 'download', id, '--name', config.artifact, '--dir', directory]);
  const files = await readdir(directory, { recursive: true });
  const deb = files.find((file) => file.endsWith('.deb'));
  if (!deb) throw new Error(`Artifact ${config.artifact} from run ${id} has no .deb package`);
  const where = chosen ? ` (${chosen.headBranch} @ ${chosen.headSha.slice(0, 7)})` : '';
  return { file: path.join(directory, deb), source: `run ${id}${where}` };
}

type Session = 'wayland' | 'x11';

async function sessionType(host: string): Promise<string> {
  return ssh(
    host,
    `id=$(loginctl show-user ${config.user} -p Display --value) && loginctl show-session "$id" -p Type --value`,
  );
}

async function useSession(host: string, session: Session) {
  const current = await waitFor('the desktop to log in', 120_000, async () => (await sessionType(host)) || undefined);
  if (current === session) return;
  step(`Switching the desktop to the ${session === 'x11' ? 'Ubuntu on Xorg' : 'Ubuntu (Wayland)'} session`);
  // GDM's automatic login starts the session AccountsService has saved for the user.
  const name = session === 'x11' ? 'ubuntu-xorg' : 'ubuntu';
  const settings = `[User]\nSession=${name}\nXSession=${name}\nSystemAccount=false\n`;
  await ssh(
    host,
    `printf %s ${shellQuote(settings)} | sudo tee /var/lib/AccountsService/users/${config.user} >/dev/null` +
      ' && sudo systemctl restart accounts-daemon gdm',
  );
}

async function waitForSession(host: string, session: Session) {
  const socket = session === 'x11' ? '/tmp/.X11-unix/X0' : '/run/user/$(id -u)/wayland-0';
  await waitFor(`the ${session} desktop session`, 120_000, async () =>
    (await sessionType(host)) === session && (await ssh(host, `test -S ${socket} && echo ok`)) === 'ok'
      ? true
      : undefined,
  );
}

function desktopEnvironment(session: Session): string {
  const common = 'XDG_RUNTIME_DIR=/run/user/$(id -u) DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$(id -u)/bus';
  return session === 'x11'
    ? `${common} DISPLAY=:0 XAUTHORITY=/run/user/$(id -u)/gdm/Xauthority`
    : `${common} WAYLAND_DISPLAY=wayland-0`;
}

async function main() {
  const { values: options } = parseArgs({
    allowNegative: true,
    options: {
      run: { type: 'string' },
      deb: { type: 'string' },
      xorg: { type: 'boolean', default: false },
      'keep-state': { type: 'boolean', default: false },
      launch: { type: 'boolean', default: true },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (options.help) {
    console.log(USAGE);
    return;
  }
  const session: Session = options.xorg ? 'x11' : 'wayland';

  // Download the package while the VM boots.
  const packagePromise: Promise<Package> = options.deb
    ? Promise.resolve({ file: path.resolve(options.deb), source: 'local file' })
    : downloadPackage(options.run);
  packagePromise.catch(() => {}); // Awaited below; this only stops an early failure being reported as unhandled.

  if (!options['keep-state']) await restoreSnapshot();
  if ((await vmStatus()) !== 'started') {
    step(`Starting "${config.vm}"`);
    await utm('start', config.vm);
  }
  step('Waiting for SSH');
  const host = await waitForHost();
  console.log(`  ${config.user}@${host}`);

  step(options.deb ? 'Using the local package' : `Downloading ${config.artifact}`);
  const pkg = await packagePromise;
  const deb = path.basename(pkg.file);
  console.log(`  ${deb} from ${pkg.source}`);

  step('Copying the package and the gesture check page');
  await ssh(host, `mkdir -p ${REMOTE_DIR}`);
  await scp(host, [pkg.file, PAGE], `${REMOTE_DIR}/`);

  step('Installing the package');
  const remoteDeb = `${REMOTE_DIR}/${deb}`;
  const name = await ssh(host, `dpkg-deb -f ${shellQuote(remoteDeb)} Package`);
  const version = await ssh(host, `dpkg-deb -f ${shellQuote(remoteDeb)} Version`);
  // The lock timeout waits out unattended-upgrades, which often runs just after boot.
  await ssh(host, `sudo apt-get -o DPkg::Lock::Timeout=600 install -y --reinstall ./${shellQuote(remoteDeb)}`);
  const binary = await ssh(host, `dpkg -L ${shellQuote(name)} | grep '^/usr/bin/' | head -1`);
  if (!binary) throw new Error(`Package ${name} installed no program in /usr/bin`);
  console.log(`  ${name} ${version} → ${binary}`);

  step(`Serving the page at http://localhost:${PORT}/ inside the VM`);
  // Bound to the VM's loopback only: nothing outside the VM can reach it.
  // Anchored so pkill cannot match the remote shell, whose command line also holds this whole command.
  await ssh(
    host,
    `pkill -f '^python3 -m http.server ${PORT} ' || true; cd ${REMOTE_DIR} && ` +
      `setsid -f python3 -m http.server ${PORT} --bind 127.0.0.1 >http.log 2>&1 </dev/null`,
  );
  const pageUrl = `http://localhost:${PORT}/gesture-check.html`;
  await waitFor('the page server', 20_000, async () =>
    (await ssh(host, `curl -sf -o /dev/null ${pageUrl} && echo ok`)) === 'ok' ? true : undefined,
  );

  await useSession(host, session);
  if (options.launch) {
    step(`Opening Unky on the ${session} desktop`);
    await waitForSession(host, session);
    await ssh(
      host,
      `pkill -x ${shellQuote(path.basename(binary))} || true; cd ${REMOTE_DIR} && ` +
        `setsid -f env ${desktopEnvironment(session)} ${binary} ${pageUrl} >unky.log 2>&1 </dev/null`,
    );
  }

  console.log(`
Ready. ${options.launch ? 'Unky is open on the VM desktop' : 'Open Unky in the VM'} at ${pageUrl}
  Package:  ${name} ${version} from ${pkg.source}
  Session:  ${session}
  SSH:      ssh -i ${config.key} -o UserKnownHostsFile=${config.knownHosts} ${config.user}@${host}
  Logs:     ~/${REMOTE_DIR}/unky.log and ~/${REMOTE_DIR}/http.log in the VM`);
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(`\n✗ ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
