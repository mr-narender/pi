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

async function fixture() {
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
    },
  };
  let backpressure = Promise.resolve();
  const createRunner = vm.runInNewContext(`${runnerSource}; createSessionRunner`, {
    process: { env: {} },
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
      closeSession: async () => {
        closes++;
        await disposed.promise;
      },
      flushRawStdout: async () => {},
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
