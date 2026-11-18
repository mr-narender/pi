import assert from 'node:assert/strict';
import test from 'node:test';
import { SharedPiHost } from '../../src/process/sharedPiHost';

for (const args of [undefined, ['--mode', 'rpc', '--no-approve']]) {
  test(`sharedPiHost adopts matching parked draft with ${args ? 'explicit' : 'implicit'} default args`, async () => {
    const env = { PATH: '/test/bin', PI_OFFLINE: '1' };
    const host = new SharedPiHost(
      'unused',
      env,
      { info() {}, warn() {}, error() {} },
      async () => '/sdk'
    );
    const internals = host as any;
    const handle = { marker: 'parked' };
    const conn = {
      piRoot: '/sdk',
      fault: undefined,
      matchesEnvironmentKey: (key: string, cwd: string) => {
        assert.match(key, /^[a-f0-9]{64}$/);
        return cwd === '/workspace';
      },
    };
    internals.parked.set('/workspace', {
      handle,
      conn,
      info: { cwd: '/workspace', env },
    });
    internals.schedulePrewarm = () => {};
    internals.openSessionRaw = () => {
      throw new Error('matching draft must not open another session');
    };
    let opening: unknown;
    const adopted = await host.openSession(
      { cwd: '/workspace', sdkRoot: args ? '/sdk' : undefined, env: { ...env }, args },
      100,
      (value) => {
        opening = value;
      }
    );
    assert.equal(adopted, handle);
    assert.equal(opening, handle);
    assert.equal(internals.parked.size, 0);
  });
}

for (const mismatch of ['sdk', 'environment', 'args', 'dedicated', 'resume', 'cwd']) {
  test(`sharedPiHost does not adopt a parked draft with different ${mismatch}`, async () => {
    const host = new SharedPiHost(
      'unused',
      {},
      { info() {}, warn() {}, error() {} },
      async () => '/sdk'
    );
    const internals = host as any;
    const fresh = { marker: 'new' };
    internals.parked.set('/workspace', {
      handle: { marker: 'parked' },
      conn: { piRoot: '/sdk', matchesEnvironmentKey: () => mismatch !== 'environment' },
      info: { cwd: '/workspace', sdkRoot: '/sdk' },
    });
    internals.openSessionRaw = async () => ({ handle: fresh });
    const result = await host.openSession({
      cwd: mismatch === 'cwd' ? '/other' : '/workspace',
      sdkRoot: mismatch === 'sdk' ? '/other-sdk' : '/sdk',
      ...(mismatch === 'args' ? { args: ['--offline'] } : {}),
      ...(mismatch === 'dedicated' ? { dedicated: true } : {}),
      ...(mismatch === 'resume' ? { sessionFile: '/session.jsonl' } : {}),
    });
    assert.equal(result, fresh);
    assert.equal(internals.parked.size, 1);
  });
}
