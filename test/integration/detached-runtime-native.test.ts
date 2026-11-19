import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createNativeFixture, nativeSdkHostPlan } from '../helpers/nativeFixture';
import { spawnDetachedRuntime } from '../../src/process/detachedRuntime/detachedHost';
import { DetachedIpcConnection } from '../../src/process/detachedRuntime/ipcClient';
import { readRegistry } from '../../src/process/detachedRuntime/registry';
import { selectActiveBranchMessages } from '../../src/sessions/activeBranch';

// The detached runtime serves the {k,d} protocol over a Unix domain socket and
// outlives its client. These tests spawn a REAL SDK host (both fixtures via
// PI_TEST_SDK=13|15) in IPC mode, drive it over the socket, drop the client
// mid/post-stream WITHOUT stopping the runtime, re-attach, and assert the turn
// completed with full content and NO interrupted marker. Named-pipe transport
// is unit-tested via the path builders; the live Windows run is separate.

const SKIP = process.platform === 'win32';

function shortTmp(): string {
  // Keep the UDS path well under the ~104-char sun_path limit.
  return mkdtempSync('/tmp/pi-dr-');
}

async function spawnHost(
  fixture: Awaited<ReturnType<typeof createNativeFixture>>,
  opts: { idleMs?: number; replayMaxCount?: number } = {}
) {
  const plan = await nativeSdkHostPlan(fixture, 'shared');
  const planEnv = plan.env as NodeJS.ProcessEnv;
  // The host runs under Node's --permission sandbox granting fs only under the
  // fixture root; its socket + token file must live there. TMPDIR = root/tmp.
  const dir = planEnv.TMPDIR ?? shortTmp();
  const runtime = await spawnDetachedRuntime({
    hostScript: '', // unused: command/args provided
    command: plan.command,
    args: [...plan.args],
    cwd: plan.cwd,
    env: planEnv,
    sdkRoot: planEnv.PI_HOST_PI_ROOT as string,
    envKey: 'test-env',
    runtimeBaseDir: dir,
    idleMs: opts.idleMs ?? 600_000,
    replayMaxCount: opts.replayMaxCount,
    // Short UDS path well under the ~104-char sun_path limit, inside the sandbox.
    endpointOverride: join(dir, `d${Math.floor(Math.random() * 1e6)}.sock`),
  });
  return { runtime, dir, open: plan.open };
}

// Drive one session over an IPC-client handle with the same request/send shape
// the stdio host tests use.
function driver(handle: { stdin: NodeJS.WritableStream; stdout: NodeJS.ReadableStream }) {
  const records: any[] = [];
  let buffer = '';
  handle.stdout.on('data', (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (line.trim()) records.push(JSON.parse(line));
    }
  });
  const send = (d: object) => handle.stdin.write(JSON.stringify(d) + '\n');
  const until = async (predicate: () => boolean, label: string) => {
    const deadline = Date.now() + 15000;
    while (!predicate()) {
      assert.ok(Date.now() < deadline, `timed out: ${label}`);
      await new Promise((r) => setTimeout(r, 10));
    }
  };
  let nextId = 0;
  const request = async (type: string, extra = {}) => {
    const id = String(++nextId);
    send({ type, id, ...extra });
    await until(() => records.some((d) => d.id === id && d.type === 'response'), type);
    const response = records.find((d) => d.id === id && d.type === 'response');
    assert.equal(response.success, true, `${type}: ${response.error}`);
    return response.data;
  };
  return { records, send, request, until };
}

test(
  'detached-runtime: wrong token is rejected and the socket closed',
  { skip: SKIP },
  async () => {
    const fixture = await createNativeFixture('compact');
    let child;
    try {
      const { runtime } = await spawnHost(fixture);
      child = runtime.child;
      const client = new DetachedIpcConnection();
      const result = await client.connect(runtime.endpoint, 'deadbeef'.repeat(8), {});
      assert.equal(result.ok, false);
      assert.equal(result.error, 'unauthorized');
      client.dispose();
      runtime.child.kill('SIGKILL');
    } finally {
      if (child && child.exitCode === null) {
        const stopped = once(child, 'exit');
        child.kill('SIGKILL');
        await stopped;
      }
      await fixture.dispose();
    }
  }
);

test(
  'detached-runtime: turn completes after client death and re-attach replays full content, no marker',
  { skip: SKIP, timeout: 60000 },
  async () => {
    const fixture = await createNativeFixture('compact');
    const children: any[] = [];
    try {
      const { runtime, dir, open } = await spawnHost(fixture);
      children.push(runtime.child);
      const file = join(fixture.cwd, 'detached-session.jsonl');
      writeFileSync(
        file,
        JSON.stringify({
          type: 'session',
          version: 3,
          id: 'detached',
          timestamp: '2024-01-01T00:00:00.000Z',
          cwd: fixture.cwd,
        }) + '\n'
      );

      // Client 1: open, switch to the session file, start a streaming turn.
      const client1 = new DetachedIpcConnection();
      const attach1 = await client1.connect(runtime.endpoint, runtime.token, {});
      assert.equal(attach1.ok, true);
      const handle1 = await client1.openSession('k1', { cwd: open.cwd, args: [...open.args] });
      const d1 = driver(handle1);
      await d1.request('switch_session', { sessionPath: file });
      fixture.setSummaryOutcome('success');
      d1.send({ type: 'prompt', id: 'p', message: 'Long fixture stream' });
      // Wait until the turn has STARTED on the runtime, then kill the client
      // mid-turn (socket drop, no close/abort) — the runtime keeps running it.
      await d1.until(() => d1.records.some((d) => d.type === 'agent_start'), 'agent_start');
      const acks = client1.lastSeqs();
      client1.dispose();

      // The runtime completes the turn to JSONL on its own, with NO marker.
      const settled = () => {
        try {
          return readFileSync(file, 'utf8')
            .trim()
            .split('\n')
            .map((l) => JSON.parse(l))
            .some(
              (e) =>
                e.type === 'message' && e.message?.role === 'assistant' && e.message?.stopReason
            );
        } catch {
          return false;
        }
      };
      const deadline = Date.now() + 15000;
      while (!settled()) {
        assert.ok(Date.now() < deadline, 'runtime completes the turn after client death');
        await new Promise((r) => setTimeout(r, 20));
      }
      assert.equal(
        readFileSync(file, 'utf8').includes('vscode-pi.turn-interrupted'),
        false,
        'no marker on client death'
      );
      assert.ok(
        readRegistry(dir).some((e) => e.id === runtime.id),
        'registry entry kept'
      );

      // Re-attach a fresh client and reconcile the completed transcript.
      const client2 = new DetachedIpcConnection();
      const attach2 = await client2.connect(runtime.endpoint, runtime.token, acks);
      assert.equal(attach2.ok, true);
      assert.ok(['attached', 'resync'].includes(attach2.sessions.k1?.state ?? ''));
      const handle2 = client2.attachSession('k1');
      const d2 = driver(handle2);

      const state = await d2.request('get_state');
      const saved = readFileSync(file, 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l));
      assert.equal(
        saved.some((e) => e.customType === 'vscode-pi.turn-interrupted'),
        false,
        'no interrupted marker in transcript'
      );
      const messages = selectActiveBranchMessages<any>(saved, Infinity, state.leafId);
      const assistant = messages.filter((m: any) => m.role === 'assistant').at(-1);
      assert.ok(assistant, 'assistant reply persisted');
      assert.ok(
        assistant.content.some((b: any) => typeof b.text === 'string' && b.text.length > 0),
        'assistant has full content'
      );

      const ctx = await d2.request('get_messages');
      assert.equal(
        ctx.messages.some((m: any) => m.customType === 'vscode-pi.turn-interrupted'),
        false
      );
      client2.dispose();
      runtime.child.kill('SIGKILL');
    } finally {
      for (const child of children) {
        if (child.exitCode === null) {
          const stopped = once(child, 'exit');
          child.kill('SIGKILL');
          await stopped;
        }
      }
      const denied = readFileSync(fixture.networkLog, 'utf8');
      await fixture.dispose();
      assert.equal(denied.trim(), '', 'no forbidden network requests');
    }
  }
);

test(
  'detached-runtime: ring-buffer overflow tells a re-attaching client to resync',
  { skip: SKIP, timeout: 60000 },
  async () => {
    const fixture = await createNativeFixture('compact');
    const children: any[] = [];
    try {
      const { runtime, open } = await spawnHost(fixture, { replayMaxCount: 1 });
      children.push(runtime.child);
      const file = join(fixture.cwd, 'overflow-session.jsonl');
      writeFileSync(
        file,
        JSON.stringify({
          type: 'session',
          version: 3,
          id: 'ovf',
          timestamp: '2024-01-01T00:00:00.000Z',
          cwd: fixture.cwd,
        }) + '\n'
      );
      const client1 = new DetachedIpcConnection();
      await client1.connect(runtime.endpoint, runtime.token, {});
      const handle1 = await client1.openSession('k1', { cwd: open.cwd, args: [...open.args] });
      const d1 = driver(handle1);
      await d1.request('switch_session', { sessionPath: file });
      fixture.setSummaryOutcome('success');
      await d1.request('prompt', { message: 'complete me' });
      await d1.until(() => d1.records.some((d) => d.type === 'agent_settled'), 'settled');
      client1.dispose();

      // Ask for everything from seq 1 — the tiny buffer has long since trimmed it.
      const client2 = new DetachedIpcConnection();
      const attach2 = await client2.connect(runtime.endpoint, runtime.token, { k1: 1 });
      assert.equal(attach2.ok, true);
      assert.equal(attach2.sessions.k1?.state, 'resync');

      // Resync path: reconcile from get_state + JSONL yields the full transcript.
      const handle2 = client2.attachSession('k1');
      const d2 = driver(handle2);
      const state = await d2.request('get_state');
      const saved = readFileSync(file, 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l));
      const messages = selectActiveBranchMessages<any>(saved, Infinity, state.leafId);
      assert.ok(messages.filter((m: any) => m.role === 'assistant').length >= 1);
      client2.dispose();
      runtime.child.kill('SIGKILL');
    } finally {
      for (const child of children) {
        if (child.exitCode === null) {
          const stopped = once(child, 'exit');
          child.kill('SIGKILL');
          await stopped;
        }
      }
      await fixture.dispose();
    }
  }
);

test(
  'detached-runtime: idle-exits on its own when no client is attached and no turn is active',
  { skip: SKIP, timeout: 30000 },
  async () => {
    const fixture = await createNativeFixture('compact');
    let child;
    try {
      const { runtime, dir, open } = await spawnHost(fixture, { idleMs: 400 });
      child = runtime.child;
      const client = new DetachedIpcConnection();
      await client.connect(runtime.endpoint, runtime.token, {});
      await client.openSession('k1', { cwd: open.cwd, args: [...open.args] });
      // No turn: drop the client and let the idle timer fire.
      const exited = once(runtime.child, 'exit');
      client.dispose();
      await exited;
      assert.equal(runtime.child.exitCode, 0, 'idle exit is clean');
      void dir;
    } finally {
      if (child && child.exitCode === null) {
        const stopped = once(child, 'exit');
        child.kill('SIGKILL');
        await stopped;
      }
      await fixture.dispose();
    }
  }
);
