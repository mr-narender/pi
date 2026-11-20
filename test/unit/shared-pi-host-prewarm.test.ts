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
    let stops = 0;
    internals.parked.set('/workspace', {
      handle: {
        marker: 'parked',
        stop: async () => {
          stops++;
        },
      },
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
    assert.equal(internals.parked.size, ['dedicated', 'resume', 'cwd'].includes(mismatch) ? 1 : 0);
    assert.equal(stops, ['dedicated', 'resume', 'cwd'].includes(mismatch) ? 0 : 1);
  });
}

test('second chat in a folder adopts the draft parked with the exact supervisor launch', async () => {
  const env = Object.freeze({ PATH: '/test/bin', PI_OFFLINE: '1' });
  const logs: string[] = [];
  const host = new SharedPiHost(
    'unused',
    env,
    { info: (line) => logs.push(line), warn() {}, error() {} },
    async () => '/sdk',
    1
  );
  const internals = host as any;
  const first = { marker: 'first' };
  const parked = { marker: 'parked' };
  const launch = {
    cwd: '/workspace',
    sdkRoot: '/sdk',
    env,
    args: ['--mode', 'rpc', '--offline', '--no-approve', '--extension', '/ide.mjs'],
  };
  const conn = {
    piRoot: '/sdk',
    fault: undefined,
    warm: true,
    matchesEnvironmentKey: (_key: string, cwd: string) => cwd === launch.cwd,
  };
  internals.conns.push(conn);
  let opens = 0;
  internals.openSessionRaw = async (info: unknown) => {
    assert.deepEqual(info, launch);
    return { handle: ++opens === 1 ? first : parked, conn };
  };
  assert.equal(await host.openSession(launch), first);
  host.warmPool(launch.cwd, launch);
  // Execute the parked-open deterministically rather than waiting for the timer.
  for (const timer of internals.prewarmTimers.values()) clearTimeout(timer);
  internals.prewarmTimers.clear();
  await internals.prewarm(launch.cwd);
  assert.equal(await host.openSession(launch), parked);
  assert.equal(opens, 2, 'adoption must not issue a third open');
  assert.ok(logs.some((line) => line.includes('Adopted prewarmed')));
  internals.conns.length = 0;
  host.dispose();
});

test('neutral sidebar warmup never parks a draft; queued folders retain their launch', async () => {
  const host = new SharedPiHost(
    'unused',
    {},
    { info() {}, warn() {}, error() {} },
    async () => '/sdk',
    1
  );
  const internals = host as any;
  const launches: unknown[] = [];
  let ready!: () => void;
  const ping = new Promise<void>((resolve) => {
    ready = resolve;
  });
  internals.spawnConn = (_root: string, _env: unknown, cwd: string) => {
    const conn = {
      piRoot: '/sdk',
      fault: undefined,
      warm: false,
      matchesEnvironmentKey: (_key: string, value: string) => value === cwd,
      ping: async () => {
        await ping;
        conn.warm = true;
      },
    };
    internals.conns.push(conn);
    return conn;
  };
  internals.schedulePrewarm = (cwd: string) => launches.push(internals.prewarmLaunches.get(cwd));
  host.warmPool(undefined, { cwd: '/neutral', sdkRoot: '/sdk' });
  assert.deepEqual(launches, []);
  const a = { cwd: '/a', sdkRoot: '/sdk', args: ['--mode', 'rpc', '--no-approve'] };
  const b = { cwd: '/b', sdkRoot: '/sdk', args: ['--mode', 'rpc', '--offline'] };
  host.warmPool(a.cwd, a);
  host.warmPool(b.cwd, b);
  ready();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(launches, [a, b]);
  internals.conns.length = 0;
  host.dispose();
});

for (const match of [true, false]) {
  test(`concurrent opens reserve a parked draft before SDK resolution (match=${match})`, async () => {
    let resolveRoot!: (root: string) => void;
    const root = new Promise<string>((resolve) => {
      resolveRoot = resolve;
    });
    const host = new SharedPiHost('unused', {}, { info() {}, warn() {}, error() {} }, () => root);
    const internals = host as any;
    let stops = 0;
    const parked = {
      marker: 'parked',
      stop: async () => {
        stops++;
      },
    };
    const fresh = { marker: 'fresh' };
    internals.parked.set('/workspace', {
      handle: parked,
      info: { cwd: '/workspace' },
      conn: { piRoot: '/sdk', matchesEnvironmentKey: () => true },
    });
    internals.schedulePrewarm = () => {};
    internals.openSessionRaw = async () => ({ handle: fresh });
    const first = host.openSession({ cwd: '/workspace' });
    assert.equal(internals.parked.size, 0, 'reserve before the first await');
    const second = host.openSession({ cwd: '/workspace' });
    resolveRoot(match ? '/sdk' : '/other');
    assert.equal(await first, match ? parked : fresh);
    assert.equal(await second, fresh, 'only one concurrent caller may adopt');
    assert.equal(internals.parked.size, 0, 'confirmed mismatch disposes the stale draft');
    assert.equal(stops, match ? 0 : 1);
    host.dispose();
  });
}

test('changed launch stops stale draft and replenishes a new adoptable draft', async () => {
  const host = new SharedPiHost(
    'unused',
    {},
    { info() {}, warn() {}, error() {} },
    async () => '/sdk',
    1
  );
  const internals = host as any;
  const oldLaunch = { cwd: '/workspace', sdkRoot: '/sdk', args: ['--old'] };
  const newLaunch = { ...oldLaunch, args: ['--new'] };
  let stops = 0;
  const conn = {
    piRoot: '/sdk',
    fault: undefined,
    warm: true,
    sessionCount: 1,
    matchesEnvironmentKey: (_key: string, cwd: string) => cwd === '/workspace',
    terminate() {},
  };
  internals.conns.push(conn);
  internals.parked.set('/workspace', {
    info: oldLaunch,
    conn,
    handle: {
      stop: async () => {
        stops++;
      },
    },
  });
  internals.prewarmLaunches.set('/workspace', oldLaunch);
  const fresh = { marker: 'fresh' };
  const replacement = { marker: 'replacement' };
  let opens = 0;
  internals.openSessionRaw = async () => ({ handle: ++opens === 1 ? fresh : replacement, conn });
  assert.equal(await host.openSession(newLaunch), fresh);
  assert.equal(stops, 1);
  assert.equal(internals.parked.has('/workspace'), false);
  // The supervisor supplies the current launch after the new chat opens.
  host.warmPool('/workspace', newLaunch);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(internals.prewarmTimers.has('/workspace'), true);
  for (const timer of internals.prewarmTimers.values()) clearTimeout(timer);
  internals.prewarmTimers.clear();
  await internals.prewarm('/workspace');
  assert.deepEqual(internals.parked.get('/workspace').info.args, ['--new']);
  assert.equal(await host.openSession(newLaunch), replacement);
  assert.equal(opens, 2);
  host.dispose();
});

test('latest prewarm launch identity invalidates an older parked draft', async () => {
  const host = new SharedPiHost(
    'unused',
    {},
    { info() {}, warn() {}, error() {} },
    async () => '/sdk'
  );
  const internals = host as any;
  const oldLaunch = { cwd: '/workspace', sdkRoot: '/sdk', args: ['--old'] };
  let stops = 0;
  internals.parked.set('/workspace', {
    info: oldLaunch,
    handle: {
      stop: async () => {
        stops++;
      },
    },
    conn: { piRoot: '/sdk', matchesEnvironmentKey: () => true },
  });
  internals.prewarmLaunches.set('/workspace', { ...oldLaunch, args: ['--new'] });
  const fresh = { marker: 'fresh' };
  internals.openSessionRaw = async () => ({ handle: fresh });
  assert.equal(await host.openSession(oldLaunch), fresh);
  assert.equal(stops, 1);
  assert.equal(internals.parked.size, 0);
  host.dispose();
});

test('transient SDK root resolution failure re-parks the valid draft', async () => {
  let attempts = 0;
  const host = new SharedPiHost('unused', {}, { info() {}, warn() {}, error() {} }, async () => {
    if (++attempts === 1) throw new Error('temporary SDK lookup failure');
    return '/sdk';
  });
  const internals = host as any;
  let stops = 0;
  const parked = {
    stop: async () => {
      stops++;
    },
  };
  internals.parked.set('/workspace', {
    info: { cwd: '/workspace' },
    handle: parked,
    conn: { piRoot: '/sdk', matchesEnvironmentKey: () => true },
  });
  internals.openSessionRaw = async () => ({ handle: { marker: 'fresh' } });
  await assert.rejects(host.openSession({ cwd: '/workspace' }), /temporary SDK lookup failure/);
  assert.equal(internals.parked.get('/workspace').handle, parked);
  assert.equal(stops, 0);
  internals.schedulePrewarm = () => {};
  assert.equal(await host.openSession({ cwd: '/workspace' }), parked);
  host.dispose();
});

test('recycling warms the neutral sidebar launch rather than the last folder launch', () => {
  const host = new SharedPiHost(
    'unused',
    {},
    { info() {}, warn() {}, error() {} },
    async () => '/sdk'
  );
  const internals = host as any;
  const neutral = { cwd: '/sidebar', sdkRoot: '/sdk' };
  const folder = { cwd: '/folder', sdkRoot: '/sdk', args: ['--folder'] };
  internals.neutralLaunch = neutral;
  internals.prewarmLaunches.set(folder.cwd, folder);
  internals.conns.push({ fault: undefined, sessionCount: 0, terminate() {} });
  const launches: unknown[] = [];
  internals.warmPool = (_cwd: string | undefined, launch: unknown) => launches.push(launch);
  assert.deepEqual(host.recycleIdleWorkers(), { recycled: 1, stillBusy: 0 });
  assert.deepEqual(launches, [neutral]);
  internals.conns.length = 0;
  host.dispose();
});

test('recycling without a sidebar launch re-warms known folder launches', () => {
  const host = new SharedPiHost(
    'unused',
    {},
    { info() {}, warn() {}, error() {} },
    async () => '/sdk'
  );
  const internals = host as any;
  const folder = { cwd: '/folder', sdkRoot: '/sdk', args: ['--folder'] };
  internals.prewarmLaunches.set(folder.cwd, folder);
  internals.conns.push({ fault: undefined, sessionCount: 0, terminate() {} });
  const launches: unknown[] = [];
  internals.warmPool = (_cwd: string, launch: unknown) => launches.push(launch);
  host.recycleIdleWorkers();
  assert.deepEqual(launches, [folder]);
  internals.conns.length = 0;
  host.dispose();
});
