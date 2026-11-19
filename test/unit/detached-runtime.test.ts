import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  addEntry,
  cleanupStale,
  findByEnv,
  readRegistry,
  removeEntry,
  type RuntimeEntry,
} from '../../src/process/detachedRuntime/registry';
import {
  constantTimeEqual as tsConstantTimeEqual,
  generateToken,
  readTokenFile,
  tokenFilePath,
  writeTokenFile,
} from '../../src/process/detachedRuntime/token';
import { ipcEndpoint, runtimeDir, userHash } from '../../src/process/detachedRuntime/ipcEndpoint';

const host = async () => import(pathToFileURL(resolve('host/detached-ipc.mjs')).href);

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'pi-detached-'));
}

function entry(over: Partial<RuntimeEntry> = {}): RuntimeEntry {
  return {
    id: over.id ?? 'rt1',
    pid: over.pid ?? 12345,
    endpoint: over.endpoint ?? '/tmp/x.sock',
    transport: over.transport ?? 'unix',
    sdkRoot: over.sdkRoot ?? '/sdk',
    envKey: over.envKey ?? 'env-a',
    tokenFile: over.tokenFile ?? '/tmp/x.token',
    startedAt: over.startedAt ?? Date.now(),
    owner: over.owner ?? {},
  };
}

// ── registry ──────────────────────────────────────────────────────────────
test('registry: add, read, remove round-trips and dedupes by id', () => {
  const dir = tmp();
  addEntry(dir, entry({ id: 'a' }));
  addEntry(dir, entry({ id: 'b' }));
  addEntry(dir, entry({ id: 'a', pid: 999 })); // replace a
  const all = readRegistry(dir);
  assert.equal(all.length, 2);
  assert.equal(all.find((e) => e.id === 'a')!.pid, 999);
  removeEntry(dir, 'a');
  assert.deepEqual(
    readRegistry(dir).map((e) => e.id),
    ['b']
  );
});

test('registry: file is written 0600', { skip: process.platform === 'win32' }, () => {
  const dir = tmp();
  addEntry(dir, entry());
  const mode = statSync(join(dir, 'registry.json')).mode & 0o777;
  assert.equal(mode, 0o600);
});

test('registry: cleanupStale drops dead pids and findByEnv returns only live', () => {
  const dir = tmp();
  addEntry(dir, entry({ id: 'live', pid: 1, envKey: 'env-a' }));
  addEntry(dir, entry({ id: 'dead', pid: 2, envKey: 'env-b' }));
  const isAlive = (pid: number) => pid === 1;
  const live = cleanupStale(dir, isAlive);
  assert.deepEqual(
    live.map((e) => e.id),
    ['live']
  );
  assert.deepEqual(
    readRegistry(dir).map((e) => e.id),
    ['live']
  );
  assert.equal(findByEnv(dir, '/sdk', 'env-a', isAlive)?.id, 'live');
  assert.equal(findByEnv(dir, '/sdk', 'env-b', isAlive), undefined);
});

// ── token ─────────────────────────────────────────────────────────────────
test('token: generate is 256-bit hex and file round-trips at 0600', () => {
  const dir = tmp();
  const token = generateToken();
  assert.match(token, /^[0-9a-f]{64}$/);
  const file = tokenFilePath(dir, 'rt1');
  writeTokenFile(file, token);
  assert.equal(readTokenFile(file), token);
  if (process.platform !== 'win32') {
    assert.equal(statSync(file).mode & 0o777, 0o600);
  }
});

test('token: constant-time compare accepts match, rejects wrong token and length mismatch', () => {
  const token = generateToken();
  assert.equal(tsConstantTimeEqual(token, token), true);
  assert.equal(tsConstantTimeEqual(token, generateToken()), false);
  assert.equal(tsConstantTimeEqual(token, token + 'ab'), false);
  assert.equal(tsConstantTimeEqual(token, ''), false);
});

// ── endpoint path builders ──────────────────────────────────────────────────
test('endpoint: Windows pipe shape embeds per-user hash', () => {
  const ctx = {
    platform: 'win32' as NodeJS.Platform,
    env: { LOCALAPPDATA: 'C:/Users/x/AppData/Local' },
    username: 'gandalf',
    uid: undefined,
  };
  const pipe = ipcEndpoint('runtime-xyz', ctx);
  assert.match(pipe, /^\\\\\.\\pipe\\pi-vscode-[0-9a-f]{12}-[0-9a-f]{10}$/);
  assert.ok(pipe.includes(userHash(ctx)));
});

test('endpoint: WSL/Linux socket lives on the Linux FS, never /mnt/c', () => {
  const ctx = {
    platform: 'linux' as NodeJS.Platform,
    env: { XDG_RUNTIME_DIR: '/run/user/1000' },
    username: 'gandalf',
    uid: 1000,
  };
  const sock = ipcEndpoint('runtime-xyz', ctx);
  assert.ok(sock.startsWith('/run/user/1000/pi-vscode-'));
  assert.ok(!sock.includes('/mnt/c'));
  assert.ok(sock.endsWith('.sock'));
  assert.equal(runtimeDir(ctx), '/run/user/1000/pi-vscode-' + userHash(ctx));
});

test('endpoint: Linux falls back to TMPDIR then /tmp (not /mnt/c)', () => {
  const sock = ipcEndpoint('r', {
    platform: 'linux',
    env: { TMPDIR: '/home/u/tmp' },
    username: 'u',
    uid: 1,
  });
  assert.ok(sock.startsWith('/home/u/tmp/pi-vscode-'));
});

// ── host: constant-time compare parity ──────────────────────────────────────
test('host constantTimeEqual matches the TS impl', async () => {
  const { constantTimeEqual } = await host();
  const token = generateToken();
  assert.equal(constantTimeEqual(token, token), true);
  assert.equal(constantTimeEqual(token, generateToken()), false);
  assert.equal(constantTimeEqual('abc', 'abcd'), false);
  assert.equal(constantTimeEqual(undefined, ''), true); // both empty
});

// ── host: ring buffer replay + overflow → resync ────────────────────────────
test('ring buffer: replays missed frames after ack', async () => {
  const { createRingBuffer } = await host();
  const rb = createRingBuffer({ maxBytes: 1 << 20, maxCount: 100 });
  assert.equal(rb.push('k', 'f1'), 1);
  assert.equal(rb.push('k', 'f2'), 2);
  assert.equal(rb.push('k', 'f3'), 3);
  const r = rb.since('k', 1);
  assert.equal(r.overflow, false);
  assert.deepEqual(
    r.frames.map((f: { seq: number }) => f.seq),
    [2, 3]
  );
  assert.equal(r.seq, 3);
  assert.deepEqual(rb.since('k', 3).frames, []);
});

test('ring buffer: overflow when ack precedes trimmed head → resync', async () => {
  const { createRingBuffer } = await host();
  const rb = createRingBuffer({ maxBytes: 1 << 20, maxCount: 2 });
  rb.push('k', 'f1'); // seq 1
  rb.push('k', 'f2'); // seq 2
  rb.push('k', 'f3'); // seq 3 → f1 trimmed (trimmedUpTo=1)
  const stillHave = rb.since('k', 2);
  assert.equal(stillHave.overflow, false);
  assert.deepEqual(
    stillHave.frames.map((f: { seq: number }) => f.seq),
    [3]
  );
  const overflowed = rb.since('k', 0); // wants f1, which is gone
  assert.equal(overflowed.overflow, true);
  assert.deepEqual(overflowed.frames, []);
});

test('ring buffer: byte cap also trims', async () => {
  const { createRingBuffer } = await host();
  const rb = createRingBuffer({ maxBytes: 10, maxCount: 1000 });
  rb.push('k', 'aaaaa'); // 5 bytes seq1
  rb.push('k', 'bbbbb'); // 10 bytes seq2
  rb.push('k', 'ccccc'); // over cap → trim seq1
  const r = rb.since('k', 0);
  assert.equal(r.overflow, true); // seq1 gone, ack 0 < trimmedUpTo 1
});

// ── host: turn tracker ──────────────────────────────────────────────────────
test('turn tracker: agent_start/agent_settled gate active state', async () => {
  const { createTurnTracker } = await host();
  const t = createTurnTracker();
  assert.equal(t.hasActive(), false);
  t.observe('k', { type: 'agent_start' });
  assert.equal(t.hasActive(), true);
  assert.equal(t.isActive('k'), true);
  t.observe('k', { type: 'message_update' });
  assert.equal(t.hasActive(), true);
  t.observe('k', { type: 'agent_settled' });
  assert.equal(t.hasActive(), false);
});

// ── host: idle manager rules ────────────────────────────────────────────────
test('idle manager: fires only with no client and no active turn', async () => {
  const { createIdleManager } = await host();
  const timers: Array<{ fn: () => void; ms: number }> = [];
  let active = false;
  let idle = 0;
  const mgr = createIdleManager({
    idleMs: 1000,
    hasActiveTurn: () => active,
    onIdle: () => (idle += 1),
    setTimer: (fn: () => void, ms: number) => {
      const t = { fn, ms };
      timers.push(t);
      return t;
    },
    clearTimer: (t: { fn: () => void }) => {
      const i = timers.indexOf(t as { fn: () => void; ms: number });
      if (i >= 0) timers.splice(i, 1);
    },
  });
  // Attached → no idle timer armed.
  mgr.clientAttached();
  assert.equal(timers.length, 0);
  // Detach while a turn is active → still no idle timer.
  active = true;
  mgr.clientDetached();
  assert.equal(timers.length, 0);
  // Turn settles → idle timer arms.
  active = false;
  mgr.turnSettled();
  assert.equal(timers.length, 1);
  // Fire it → idle.
  timers[0]!.fn();
  assert.equal(idle, 1);
});

test('idle manager: a turn starting during the wait cancels idle exit', async () => {
  const { createIdleManager } = await host();
  const timers: Array<{ fn: () => void }> = [];
  let active = false;
  let idle = 0;
  const mgr = createIdleManager({
    idleMs: 1000,
    hasActiveTurn: () => active,
    onIdle: () => (idle += 1),
    setTimer: (fn: () => void) => {
      const t = { fn };
      timers.push(t);
      return t;
    },
    clearTimer: () => {},
  });
  mgr.start(); // no client, no turn → arms
  assert.equal(timers.length, 1);
  active = true; // a turn started
  timers[0]!.fn(); // timer fires but re-checks
  assert.equal(idle, 0);
});
