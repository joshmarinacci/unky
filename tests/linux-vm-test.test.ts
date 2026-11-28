import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { parseLeases, shellQuote } from '../scripts/linux-vm-test.ts';

describe('parseLeases', () => {
  const leases = `{
	name=unky-test
	ip_address=192.168.64.6
	hw_address=1,6e:4a:2:15:2a:93
	identifier=1,6e:4a:2:15:2a:93
	lease=0x6929a1b0
}
{
	name=DESKTOP-WIN
	ip_address=192.168.64.3
	hw_address=1,8e:1:22:33:44:55
	lease=0x6929c000
}
{
	name=unky-test
	ip_address=192.168.64.7
	hw_address=1,1a:2b:3c:4d:5e:6f
	lease=0x6929b2c0
}
`;

  it('reads every lease, newest first', () => {
    expect(parseLeases(leases).map((lease) => lease.ip)).toEqual(['192.168.64.3', '192.168.64.7', '192.168.64.6']);
  });

  it('lets callers pick the VM by hostname rather than whichever lease is newest', () => {
    const vm = parseLeases(leases).filter((lease) => lease.name === 'unky-test');
    expect(vm.map((lease) => lease.ip)).toEqual(['192.168.64.7', '192.168.64.6']);
  });

  it('skips blocks without a name or address', () => {
    expect(parseLeases('{\n\tname=x\n}\n{\n\tip_address=1.2.3.4\n}\n')).toEqual([]);
    expect(parseLeases('')).toEqual([]);
  });
});

describe('shellQuote', () => {
  it.each(['Unky_0.1.0_arm64.deb', "it's here", 'a b; rm -rf ~', '$(whoami) `id`'])(
    'passes %j through a POSIX shell unchanged',
    (value) => {
      expect(execFileSync('sh', ['-c', `printf %s ${shellQuote(value)}`], { encoding: 'utf8' })).toBe(value);
    },
  );
});
