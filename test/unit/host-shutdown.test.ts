import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync('host/pi-multi-host.mjs', 'utf8');
const runnerSource = source.slice(
  source.indexOf('function createSessionRunner('),
  source.indexOf('// Multiplexing host:')
);
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

async function fixture(
  options: {
    setTimeout?: typeof setTimeout;
    clearTimeout?: typeof clearTimeout;
    dispose?: () => Promise<void>;
  } = {}
) {
  const output: any[] = [];
  let binding: any;
  let subscriber: (event: any) => void = () => {};
  let disposals = 0;
  let preflight: (value: string) => void = () => {};
  const prompt = deferred();
  const session = {
    isIdle: true,
    bindExtensions: async (value: any) => {
      binding = value;
    },
    subscribe: (value: any) => {
      subscriber = value;
      return () => {};
    },
    agent: { subscribe: () => () => {} },
    abort: async () => {},
    sessionManager: { appendCustomEntry: (_type: string, _data: unknown) => {} },
    prompt: (_message: string, options: any) => {
      preflight = options.preflightResult;
      return prompt.promise;
    },
  };
  const runtimeHost = {
    session,
    setRebindSession() {},
    dispose: async () => {
      disposals++;
      await options.dispose?.();
    },
  };
  let backpressure = Promise.resolve();
  const createRunner = vm.runInNewContext(`${runnerSource}; createSessionRunner`, {
    process: { env: {} },
    console,
    setTimeout: options.setTimeout ?? setTimeout,
    clearTimeout: options.clearTimeout ?? clearTimeout,
    setImmediate,
    createScopeOperations: () => ({}),
    resolveModelScopeFromModels() {},
    createPreferenceOperations: () => ({}),
    thinking: {},
    createAuthCommands: () => ({ dispose() {} }),
    createImportCommands: () => ({ discard: async () => {} }),
    scopeCommandDispatcher: (handler: unknown) => handler,
    toJsonEvent: (event: unknown) => event,
    waitForRawStdoutBackpressure: () => backpressure,
  });
  const runner = createRunner('owned', runtimeHost, (_key: string, message: any) =>
    output.push(message)
  );
  await runner.initialize();
  return {
    runner,
    session,
    output,
    prompt,
    shutdown: () => binding.shutdownHandler(),
    settled: () => subscriber({ type: 'agent_settled' }),
    started: () => subscriber({ type: 'agent_start' }),
    preflight: () => preflight('handled'),
    disposals: () => disposals,
    backpressure: (value: Promise<void>) => {
      backpressure = value;
    },
  };
}

test('host idle ctx.shutdown closes exactly once without a subsequent command or event', async () => {
  const f = await fixture();
  f.shutdown();
  f.shutdown();
  await tick();
  assert.equal(f.disposals(), 1);
  assert.equal(f.output.filter((value) => value.type === 'session_closed').length, 1);
});

test('host ctx.shutdown waits for prompt preflight, promise completion and idle settlement', async () => {
  const f = await fixture();
  f.session.isIdle = false;
  await f.runner.handleParsed({ type: 'prompt', id: 'prompt', message: 'owned' });
  f.shutdown();
  await tick();
  assert.equal(f.disposals(), 0);
  f.preflight();
  // Even an early settled event must not race the still-pending prompt promise.
  f.session.isIdle = true;
  f.settled();
  await tick();
  assert.equal(f.disposals(), 0);
  f.session.isIdle = false;
  f.prompt.resolve();
  await tick();
  assert.equal(f.disposals(), 0, 'non-idle session must not dispose after prompt finally');
  f.session.isIdle = true;
  f.settled();
  await tick();
  assert.equal(f.disposals(), 1);
  assert.equal(f.output.at(-1).type, 'session_closed');
});

test('host requested shutdown waits until the command response finishes', async () => {
  const f = await fixture();
  const flushed = deferred();
  f.backpressure(flushed.promise);
  const command = f.runner.handleParsed({ type: 'unknown', id: 'command' });
  await tick();
  f.shutdown();
  await tick();
  assert.equal(f.disposals(), 0);
  flushed.resolve();
  await command;
  assert.equal(f.disposals(), 1);
  assert.equal(f.output[0].type, 'response');
  assert.equal(f.output.at(-1).type, 'session_closed');
});

for (const stdinFirst of [false, true]) {
  test(`host signals are re-entrance guarded and repeated signals force exit (stdinFirst=${stdinFirst})`, async () => {
    const callbacks = new Map<string, () => void>();
    const exits: number[] = [];
    const disposed = deferred();
    let closes = 0;
    const signalSource = source.slice(source.indexOf('let hostShuttingDown = false;'));
    vm.runInNewContext(signalSource, {
      process: {
        platform: 'darwin',
        stdin: { on: (event: string, handler: () => void) => callbacks.set(event, handler) },
        on: (event: string, handler: () => void) => callbacks.set(event, handler),
        exit: (code: number) => exits.push(code),
      },
      sessions: new Map([['owned', {}]]),
      openingSessions: new Map(),
      closingSessions: new Map(),
      closeSession: async () => {
        closes++;
        await disposed.promise;
      },
      flushRawStdout: async () => {},
      setTimeout,
      clearTimeout,
    });
    if (stdinFirst) callbacks.get('end')!();
    callbacks.get('SIGTERM')!();
    assert.equal(closes, 1);
    assert.deepEqual(exits, []);
    callbacks.get('SIGINT')!();
    assert.equal(closes, 1);
    assert.deepEqual(exits, [130]);
    disposed.resolve();
    await tick();
    assert.deepEqual(exits, [130, stdinFirst ? 0 : 143]);
  });
}

function clock() {
  let now = 0;
  let nextId = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  return {
    now: () => now,
    setTimeout: ((callback: () => void, delay: number) => {
      const id = ++nextId;
      timers.set(id, { at: now + delay, callback });
      return id;
    }) as unknown as typeof setTimeout,
    clearTimeout: ((id: number) => timers.delete(id)) as unknown as typeof clearTimeout,
    advance: async (amount: number) => {
      const target = now + amount;
      while (true) {
        const due = [...timers]
          .filter(([, timer]) => timer.at <= target)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        now = due[1].at;
        timers.delete(due[0]);
        due[1].callback();
        await tick();
      }
      now = target;
    },
  };
}

test('hanging abort times out, persists marker and proceeds through hanging runtime disposal', async () => {
  const time = clock();
  const f = await fixture({
    setTimeout: time.setTimeout,
    clearTimeout: time.clearTimeout,
    dispose: () => new Promise<void>(() => {}),
  });
  const markers: string[] = [];
  f.session.abort = () => new Promise<void>(() => {});
  f.session.sessionManager.appendCustomEntry = (type: string) => markers.push(type);
  f.started();
  const closing = f.runner.dispose('stdin-closed');
  await time.advance(1999);
  assert.deepEqual(markers, []);
  await time.advance(1);
  assert.deepEqual(markers, ['vscode-pi.turn-interrupted']);
  assert.equal(f.disposals(), 1);
  void closing;
});

test('EOF shutdown writes all unsettled session markers before deadline despite hanging abort', async () => {
  const time = clock();
  const callbacks = new Map<string, () => void>();
  const exits: { code: number; at: number }[] = [];
  const markers: { key: string; type: string; at: number }[] = [];
  const keys = ['slow', 'second', 'third'];
  const fixtures = await Promise.all(
    keys.map(async (key) => {
      const f = await fixture({
        setTimeout: time.setTimeout,
        clearTimeout: time.clearTimeout,
        dispose: key === 'slow' ? () => new Promise<void>(() => {}) : undefined,
      });
      f.session.abort = key === 'slow' ? () => new Promise<void>(() => {}) : async () => {};
      f.session.sessionManager.appendCustomEntry = (type: string) =>
        markers.push({ key, type, at: time.now() });
      f.started();
      return f;
    })
  );
  const sessions = new Map(keys.map((key, index) => [key, fixtures[index]!.runner]));
  const closingSessions = new Map<string, Promise<void>>();
  const closeSession = (key: string, reason: string) => {
    if (closingSessions.has(key)) return closingSessions.get(key)!;
    const runner = sessions.get(key);
    if (!runner) return Promise.resolve();
    sessions.delete(key);
    const closing = runner.dispose(reason);
    closingSessions.set(key, closing);
    return closing;
  };
  vm.runInNewContext(source.slice(source.indexOf('let hostShuttingDown = false;')), {
    Date: { now: time.now },
    setTimeout: time.setTimeout,
    clearTimeout: time.clearTimeout,
    process: {
      platform: 'darwin',
      stdin: { on: (event: string, handler: () => void) => callbacks.set(event, handler) },
      on: (event: string, handler: () => void) => callbacks.set(event, handler),
      exit: (code: number) => exits.push({ code, at: time.now() }),
    },
    sessions,
    openingSessions: new Map(),
    closingSessions,
    closeSession,
    flushRawStdout: async () => {},
  });
  callbacks.get('end')!();
  await tick();
  await time.advance(1999);
  assert.deepEqual(markers, [
    { key: 'second', type: 'vscode-pi.turn-interrupted', at: 0 },
    { key: 'third', type: 'vscode-pi.turn-interrupted', at: 0 },
  ]);
  await time.advance(1);
  assert.deepEqual(markers, [
    { key: 'second', type: 'vscode-pi.turn-interrupted', at: 0 },
    { key: 'third', type: 'vscode-pi.turn-interrupted', at: 0 },
    { key: 'slow', type: 'vscode-pi.turn-interrupted', at: 2000 },
  ]);
  assert.deepEqual(exits, []);
  await time.advance(7999);
  assert.deepEqual(exits, []);
  await time.advance(1);
  assert.deepEqual(exits, [{ code: 0, at: 10000 }]);
});

test('EOF shutdown followed by SIGTERM accelerates deadline without losing EOF exit code', async () => {
  const time = clock();
  const callbacks = new Map<string, () => void>();
  const exits: { code: number; at: number }[] = [];
  const f = await fixture({
    setTimeout: time.setTimeout,
    clearTimeout: time.clearTimeout,
    dispose: () => new Promise<void>(() => {}),
  });
  const markers: string[] = [];
  f.session.abort = () => new Promise<void>(() => {});
  f.session.sessionManager.appendCustomEntry = (type: string) => markers.push(type);
  f.started();
  vm.runInNewContext(source.slice(source.indexOf('let hostShuttingDown = false;')), {
    Date: { now: time.now },
    setTimeout: time.setTimeout,
    clearTimeout: time.clearTimeout,
    process: {
      platform: 'darwin',
      stdin: { on: (event: string, handler: () => void) => callbacks.set(event, handler) },
      on: (event: string, handler: () => void) => callbacks.set(event, handler),
      exit: (code: number) => exits.push({ code, at: time.now() }),
    },
    sessions: new Map([['owned', {}]]),
    openingSessions: new Map(),
    closingSessions: new Map(),
    closeSession: () => f.runner.dispose('stdin-closed'),
    flushRawStdout: async () => {},
  });
  callbacks.get('end')!();
  await time.advance(100);
  callbacks.get('SIGTERM')!();
  await time.advance(1900);
  assert.deepEqual(markers, ['vscode-pi.turn-interrupted']);
  assert.deepEqual(exits, []);
  await time.advance(1099);
  assert.deepEqual(exits, []);
  await time.advance(1);
  assert.deepEqual(exits, [{ code: 0, at: 3100 }]);
});

test('shutdown interruption branch memo follows leaf changes and session manager replacement', () => {
  const snippet = source.slice(
    source.indexOf('  let interruptionCacheManager;'),
    source.indexOf('  const readState = () => ({')
  );
  const marker = { type: 'custom', customType: 'vscode-pi.turn-interrupted', id: 'marker' };
  const user = { type: 'message', id: 'user', message: { role: 'user', timestamp: 1 } };
  const assistant = {
    type: 'message',
    id: 'assistant',
    message: { role: 'assistant', timestamp: 2, stopReason: 'aborted' },
  };
  let leaf = 'marker';
  let walks = 0;
  const manager = {
    getLeafId: () => leaf,
    getBranch: () => {
      walks++;
      return leaf === 'marker'
        ? [user, assistant, marker]
        : leaf === 'new-prompt'
          ? [user, assistant, marker, { ...user, id: 'new-prompt' }]
          : [user];
    },
  };
  const session: { sessionManager: typeof manager } = { sessionManager: manager };
  const entries = vm.runInNewContext(`${snippet}; shutdownInterruptionEntries`, {
    session,
  }) as () => any[];
  assert.equal(entries().at(-1).id, 'marker');
  entries();
  assert.equal(walks, 1);
  leaf = 'fork';
  assert.equal(entries().length, 0);
  leaf = 'new-prompt';
  assert.equal(entries().length, 0);
  leaf = 'marker';
  assert.equal(entries().at(-1).id, 'marker');
  session.sessionManager = {
    ...manager,
    getBranch: () => {
      walks++;
      return [user];
    },
  };
  assert.equal(entries().length, 0);
  assert.equal(walks, 5);
});

test('EOF shutdown exits at overall deadline even when runtime disposal never settles', async () => {
  const time = clock();
  const callbacks = new Map<string, () => void>();
  const exits: { code: number; at: number }[] = [];
  vm.runInNewContext(source.slice(source.indexOf('let hostShuttingDown = false;')), {
    Date: { now: time.now },
    setTimeout: time.setTimeout,
    clearTimeout: time.clearTimeout,
    process: {
      platform: 'darwin',
      stdin: { on: (event: string, handler: () => void) => callbacks.set(event, handler) },
      on: (event: string, handler: () => void) => callbacks.set(event, handler),
      exit: (code: number) => exits.push({ code, at: time.now() }),
    },
    sessions: new Map([['owned', {}]]),
    openingSessions: new Map(),
    closingSessions: new Map(),
    closeSession: () => new Promise<void>(() => {}),
    flushRawStdout: async () => {},
  });
  callbacks.get('end')!();
  await time.advance(9999);
  assert.deepEqual(exits, []);
  await time.advance(1);
  assert.deepEqual(exits, [{ code: 0, at: 10000 }]);
});

test('EOF shutdown lets slow credential-settle disposal finish before overall deadline', async () => {
  const time = clock();
  const callbacks = new Map<string, () => void>();
  const exits: { code: number; at: number }[] = [];
  const f = await fixture({
    setTimeout: time.setTimeout,
    clearTimeout: time.clearTimeout,
    dispose: () => new Promise<void>((resolve) => time.setTimeout(resolve, 4000)),
  });
  vm.runInNewContext(source.slice(source.indexOf('let hostShuttingDown = false;')), {
    Date: { now: time.now },
    setTimeout: time.setTimeout,
    clearTimeout: time.clearTimeout,
    process: {
      platform: 'darwin',
      stdin: { on: (event: string, handler: () => void) => callbacks.set(event, handler) },
      on: (event: string, handler: () => void) => callbacks.set(event, handler),
      exit: (code: number) => exits.push({ code, at: time.now() }),
    },
    sessions: new Map([['owned', {}]]),
    openingSessions: new Map(),
    closingSessions: new Map(),
    closeSession: () => f.runner.dispose('stdin-closed'),
    flushRawStdout: async () => {},
  });
  callbacks.get('end')!();
  await tick();
  await time.advance(3999);
  assert.deepEqual(exits, []);
  await time.advance(1);
  assert.equal(f.disposals(), 1);
  assert.deepEqual(exits, [{ code: 0, at: 4000 }]);
  await time.advance(6000);
  assert.deepEqual(exits, [{ code: 0, at: 4000 }], 'overall deadline was cleared');
});
