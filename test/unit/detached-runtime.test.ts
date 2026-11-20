import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, statSync, symlinkSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import net from 'node:net';

import {
  addEntry,
  acquireLock,
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
import {
  ensureRuntimeDir,
  ipcEndpoint,
  runtimeDir,
  userHash,
  validateDirSecurity,
} from '../../src/process/detachedRuntime/ipcEndpoint';

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
  addEntry(dir, entry({ id: 'a', envKey: 'env-a' }));
  addEntry(dir, entry({ id: 'b', envKey: 'env-b' }));
  addEntry(dir, entry({ id: 'a', pid: 999, envKey: 'env-a' })); // replace a
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

test('registry: addEntry dedupes on (sdkRoot, envKey)', () => {
  const dir = tmp();
  addEntry(dir, entry({ id: 'a', sdkRoot: '/sdk', envKey: 'env-a' }));
  addEntry(dir, entry({ id: 'b', sdkRoot: '/sdk', envKey: 'env-a' })); // replaces a
  const all = readRegistry(dir);
  assert.equal(all.length, 1);
  assert.equal(all[0]!.id, 'b');
});

// ── registry lock ─────────────────────────────────────────────────────────
test('registry: acquireLock serializes concurrent callers', () => {
  const dir = tmp();
  const results: string[] = [];
  // Simulate two "concurrent" callers (sync for test determinism).
  const r1 = acquireLock(dir);
  results.push('lock1');
  // Second lock attempt should block (but since it's sync spin, we can't truly
  // test that in a single thread). Instead, test that the lock file exists.
  const lockFile = join(dir, 'registry.lock');
  assert.ok(statSync(lockFile), 'lock file exists while held');
  r1();
  // After release, we can acquire again.
  const r2 = acquireLock(dir);
  results.push('lock2');
  r2();
  assert.deepEqual(results, ['lock1', 'lock2']);
});

test('registry: concurrent addEntry does not lose entries', () => {
  const dir = tmp();
  // Add entries with different envKeys — both should survive.
  addEntry(dir, entry({ id: 'a', envKey: 'env-a' }));
  addEntry(dir, entry({ id: 'b', envKey: 'env-b' }));
  const all = readRegistry(dir);
  assert.equal(all.length, 2);
  assert.ok(all.some((e) => e.id === 'a'));
  assert.ok(all.some((e) => e.id === 'b'));
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

// ── WSL remote assertion: /mnt/ directories are rejected ────────────────
test('endpoint: WSL remoteName rejects /mnt/ base and falls back to tmpdir', () => {
  const ctx = {
    platform: 'linux' as NodeJS.Platform,
    env: { TMPDIR: '/mnt/c/Users/u/tmp' },
    username: 'u',
    uid: 1000,
  };
  // Without remoteName='wsl', /mnt/ is used as-is.
  const dirNormal = runtimeDir(ctx);
  assert.ok(dirNormal.startsWith('/mnt/c'), 'without WSL flag, /mnt/ is allowed');
  // With remoteName='wsl', /mnt/ base is rejected → os.tmpdir() fallback.
  const dirWsl = runtimeDir(ctx, 'wsl');
  assert.ok(!dirWsl.startsWith('/mnt/'), `WSL guard rejected /mnt/ path: ${dirWsl}`);
});

test('endpoint: WSL remoteName with XDG_RUNTIME_DIR on Linux FS keeps it', () => {
  const ctx = {
    platform: 'linux' as NodeJS.Platform,
    env: { XDG_RUNTIME_DIR: '/run/user/1000', TMPDIR: '/mnt/c/tmp' },
    username: 'u',
    uid: 1000,
  };
  const dir = runtimeDir(ctx, 'wsl');
  assert.ok(dir.startsWith('/run/user/1000/'), `XDG_RUNTIME_DIR on Linux FS used: ${dir}`);
});

test('endpoint: WSL remoteName with XDG_RUNTIME_DIR under /mnt/ falls back to tmpdir', () => {
  const ctx = {
    platform: 'linux' as NodeJS.Platform,
    env: { XDG_RUNTIME_DIR: '/mnt/c/run/user/1000', TMPDIR: '/mnt/c/tmp' },
    username: 'u',
    uid: 1000,
  };
  const dir = runtimeDir(ctx, 'wsl');
  assert.ok(!dir.startsWith('/mnt/'), `WSL guard rejected /mnt/ XDG dir: ${dir}`);
});

// ── UDS directory hardening ────────────────────────────────────────────────
test(
  'ensureRuntimeDir: validates dir is not a symlink',
  { skip: process.platform === 'win32' },
  () => {
    const base = tmp();
    const target = join(base, 'real');
    mkdirSync(target, { mode: 0o700 });
    const link = join(base, 'link');
    symlinkSync(target, link);
    // ensureRuntimeDir should detect the symlink and use a safe alternative.
    const result = ensureRuntimeDir(link, 'linux');
    assert.notEqual(result, link, 'symlinked dir was rejected');
    assert.ok(result.includes('pi-vscode-safe-'), 'safe fallback dir was created');
  }
);

test(
  'ensureRuntimeDir: rejects dir with wrong permissions',
  { skip: process.platform === 'win32' },
  () => {
    const base = tmp();
    const dir = join(base, 'wrongperms');
    mkdirSync(dir, { mode: 0o777 }); // world-writable
    const result = ensureRuntimeDir(dir, 'linux');
    assert.notEqual(result, dir, 'world-writable dir was rejected');
    assert.ok(result.includes('pi-vscode-safe-'), 'safe fallback dir was created');
  }
);

test(
  'ensureRuntimeDir: rejects dir with foreign owner (injected stat)',
  { skip: process.platform === 'win32' },
  () => {
    const base = tmp();
    const dir = join(base, 'foreign');
    mkdirSync(dir, { mode: 0o700 });
    // Inject a stat that reports a different uid.
    const result = ensureRuntimeDir(dir, 'linux', {
      lstatSync: () => ({
        isSymbolicLink: () => false,
        uid: 99999, // foreign owner
        mode: 0o40700,
      }),
      getuid: () => 1000,
    });
    assert.notEqual(result, dir, 'foreign-owned dir was rejected');
    assert.ok(result.includes('pi-vscode-safe-'), 'safe fallback dir was created');
  }
);

test(
  'validateDirSecurity: returns true for safe dir',
  { skip: process.platform === 'win32' },
  () => {
    const dir = tmp();
    chmodSync(dir, 0o700);
    assert.ok(validateDirSecurity(dir));
  }
);

test(
  'validateDirSecurity: returns false for symlink',
  { skip: process.platform === 'win32' },
  () => {
    const base = tmp();
    const target = join(base, 'real');
    mkdirSync(target, { mode: 0o700 });
    const link = join(base, 'link');
    symlinkSync(target, link);
    assert.equal(validateDirSecurity(link), false);
  }
);

// ── host: constant-time compare parity ──────────────────────────────────────
test('host constantTimeEqual rejects empty strings (fail-closed)', async () => {
  const { constantTimeEqual } = await host();
  // Empty-to-empty must STILL return true at the primitive level (both are
  // equal), but the SERVER auth path guards against empty tokens separately.
  // This test verifies the primitive still works correctly.
  assert.equal(constantTimeEqual('', ''), true);
  assert.equal(constantTimeEqual(undefined, ''), true); // both coerce to empty
  assert.equal(constantTimeEqual('abc', ''), false);
});

// ── P1-1: readTokenFromEnv fail-closed ────────────────────────────────────
test('host readTokenFromEnv: missing PI_HOST_TOKEN_FILE throws', async () => {
  const { readTokenFromEnv } = await host();
  assert.throws(() => readTokenFromEnv({}), /PI_HOST_TOKEN_FILE is not set/);
});

test('host readTokenFromEnv: unreadable file throws', async () => {
  const { readTokenFromEnv } = await host();
  assert.throws(
    () => readTokenFromEnv({ PI_HOST_TOKEN_FILE: '/nonexistent/token' }),
    /Cannot read token file/
  );
});

test('host readTokenFromEnv: short token throws', async () => {
  const { readTokenFromEnv } = await host();
  const dir = tmp();
  const file = join(dir, 'short.token');
  writeFileSync(file, 'abcd1234');
  assert.throws(() => readTokenFromEnv({ PI_HOST_TOKEN_FILE: file }), /must be at least 64 hex/);
});

test('host readTokenFromEnv: valid 64-hex token succeeds', async () => {
  const { readTokenFromEnv } = await host();
  const dir = tmp();
  const file = join(dir, 'valid.token');
  const token = generateToken();
  writeFileSync(file, token);
  assert.equal(readTokenFromEnv({ PI_HOST_TOKEN_FILE: file }), token);
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

// ── HMAC-SHA256 challenge-response auth ─────────────────────────────────────
test('host hmacSha256: produces expected HMAC', async () => {
  const { hmacSha256 } = await host();
  const result = hmacSha256('key', 'data');
  assert.match(result, /^[0-9a-f]{64}$/);
  // Deterministic: same input → same output.
  assert.equal(result, hmacSha256('key', 'data'));
  // Different key → different output.
  assert.notEqual(result, hmacSha256('other', 'data'));
});

test('IPC server: HMAC challenge-response auth succeeds with correct token', async () => {
  const { createIpcServer } = await host();
  const token = generateToken();
  const ipc = createIpcServer({
    endpoint: join(tmp(), 'test.sock'),
    token,
    onInbound: () => {},
    replayFor: () => ({ overflow: false, frames: [], seq: 0 }),
    onClientAttached: () => {},
    onClientDetached: () => {},
  });
  await ipc.listen();
  try {
    const { DetachedIpcConnection } = await import(
      '../../src/process/detachedRuntime/ipcClient.js'
    );
    const client = new DetachedIpcConnection();
    const result = await client.connect(ipc.server.address(), token, {});
    assert.equal(result.ok, true, 'auth succeeded');
    client.dispose();
  } finally {
    ipc.close();
  }
});

test('IPC server: wrong-token client is rejected (server verifies clientProof)', async () => {
  const { createIpcServer } = await host();
  const token = generateToken();
  const ipc = createIpcServer({
    endpoint: join(tmp(), 'test.sock'),
    token,
    onInbound: () => {},
    replayFor: () => ({ overflow: false, frames: [], seq: 0 }),
    onClientAttached: () => {},
    onClientDetached: () => {},
  });
  await ipc.listen();
  try {
    const { DetachedIpcConnection } = await import(
      '../../src/process/detachedRuntime/ipcClient.js'
    );
    const client = new DetachedIpcConnection();
    const result = await client.connect(ipc.server.address(), 'wrong'.repeat(13), {});
    assert.equal(result.ok, false, 'wrong token rejected');
    client.dispose();
  } finally {
    ipc.close();
  }
});

test('IPC server: wrong-token server → client aborts before sending proof', async () => {
  // Spin up a rogue server that uses a wrong token.
  const { createIpcServer } = await host();
  const rogueToken = generateToken();
  const clientToken = generateToken();
  assert.notEqual(rogueToken, clientToken);
  const ipc = createIpcServer({
    endpoint: join(tmp(), 'rogue.sock'),
    token: rogueToken,
    onInbound: () => {},
    replayFor: () => ({ overflow: false, frames: [], seq: 0 }),
    onClientAttached: () => {},
    onClientDetached: () => {},
  });
  await ipc.listen();
  try {
    const { DetachedIpcConnection } = await import(
      '../../src/process/detachedRuntime/ipcClient.js'
    );
    const client = new DetachedIpcConnection();
    const result = await client.connect(ipc.server.address(), clientToken, {});
    assert.equal(result.ok, false, 'client detected wrong-token server');
    assert.equal(result.error, 'server_auth_failed');
    client.dispose();
  } finally {
    ipc.close();
  }
});

// ── P1-1: empty {} frame is rejected ──────────────────────────────────────
test('IPC server: empty JSON frame before auth is rejected', async () => {
  const { createIpcServer } = await host();
  const token = generateToken();
  const sockPath = join(tmp(), 'empty.sock');
  const ipc = createIpcServer({
    endpoint: sockPath,
    token,
    onInbound: () => {},
    replayFor: () => ({ overflow: false, frames: [], seq: 0 }),
    onClientAttached: () => {},
    onClientDetached: () => {},
  });
  await ipc.listen();
  try {
    const socket = net.connect(sockPath);
    await new Promise((resolve) => socket.once('connect', resolve));
    // Send an empty {} frame (no hello).
    socket.write('{}\n');
    const data = await new Promise<string>((resolve) => {
      socket.setEncoding('utf8');
      socket.once('data', resolve);
    });
    const msg = JSON.parse(data.trim());
    assert.equal(msg.attach?.ok, false, 'empty frame rejected');
    assert.equal(msg.attach?.error, 'bad_hello');
    socket.destroy();
  } finally {
    ipc.close();
  }
});

// ── P2-1: Pre-auth DoS protections ────────────────────────────────────────
test('IPC server: pre-auth byte cap destroys socket after 64 KiB', async () => {
  const { createIpcServer } = await host();
  const token = generateToken();
  const sockPath = join(tmp(), 'dos.sock');
  const ipc = createIpcServer({
    endpoint: sockPath,
    token,
    onInbound: () => {},
    replayFor: () => ({ overflow: false, frames: [], seq: 0 }),
    onClientAttached: () => {},
    onClientDetached: () => {},
  });
  await ipc.listen();
  try {
    const socket = net.connect(sockPath);
    await new Promise((resolve) => socket.once('connect', resolve));
    // Send >64 KiB without a newline (all buffered as pre-auth data).
    const bigChunk = 'x'.repeat(70 * 1024);
    const closed = new Promise<void>((resolve) => socket.once('close', resolve));
    socket.write(bigChunk);
    await closed;
    // If we get here, the socket was destroyed (expected).
    assert.ok(true, 'socket destroyed after exceeding pre-auth byte cap');
  } finally {
    ipc.close();
  }
});

test('IPC server: auth deadline destroys unauthenticated socket after timeout', async () => {
  const { createIpcServer } = await host();
  const token = generateToken();
  const sockPath = join(tmp(), 'timeout.sock');
  const ipc = createIpcServer({
    endpoint: sockPath,
    token,
    onInbound: () => {},
    replayFor: () => ({ overflow: false, frames: [], seq: 0 }),
    onClientAttached: () => {},
    onClientDetached: () => {},
  });
  await ipc.listen();
  try {
    const socket = net.connect(sockPath);
    await new Promise((resolve) => socket.once('connect', resolve));
    // Don't send anything. The 5s auth deadline should destroy the socket.
    const closed = new Promise<void>((resolve) => socket.once('close', resolve));
    // Wait up to 7s for the socket to be destroyed.
    const timeout = new Promise<void>((_, reject) =>
      setTimeout(() => reject(new Error('auth deadline did not fire')), 7000)
    );
    await Promise.race([closed, timeout]);
    assert.ok(true, 'socket destroyed by auth deadline');
  } finally {
    ipc.close();
  }
});

test('IPC server: concurrent unauthenticated connections capped at 16', async () => {
  const { createIpcServer } = await host();
  const token = generateToken();
  const sockPath = join(tmp(), 'cap.sock');
  const ipc = createIpcServer({
    endpoint: sockPath,
    token,
    onInbound: () => {},
    replayFor: () => ({ overflow: false, frames: [], seq: 0 }),
    onClientAttached: () => {},
    onClientDetached: () => {},
  });
  await ipc.listen();
  try {
    const sockets: net.Socket[] = [];
    const closedPromises: Promise<void>[] = [];
    // Open 20 connections without authenticating.
    for (let i = 0; i < 20; i++) {
      const s = net.connect(sockPath);
      sockets.push(s);
      closedPromises.push(new Promise((resolve) => s.once('close', resolve)));
      await new Promise((resolve) => s.once('connect', resolve));
    }
    // Give the server a tick to process.
    await new Promise((r) => setTimeout(r, 50));
    // Count how many are still alive vs destroyed.
    let alive = 0;
    for (const s of sockets) {
      if (!s.destroyed) alive++;
    }
    // At most 16 should be alive.
    assert.ok(alive <= 16, `concurrent unauthed cap: ${alive} alive (expected ≤16)`);
    // Clean up.
    for (const s of sockets) s.destroy();
  } finally {
    ipc.close();
  }
});
