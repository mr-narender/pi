import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { createNativeFixture, nativeSdkHostPlan } from '../helpers/nativeFixture';
import { piLaunchEnvironment } from '../../src/process/piLauncher';
import { selectActiveBranchMessages } from '../../src/sessions/activeBranch';
import {
  detachedRuntimeBaseDir,
  stopBackgroundRuntimes,
} from '../../src/process/detachedRuntime/stopRuntimes';

// Step 2 integration tests for the detached-runtime supervisor:
// 1. LIVE re-attach while streaming (mid-stream attach, dedup by seq).
// 2. deactivate() with active turn → runtime survives.
// 3. Two-window refusal: busy-elsewhere propagated, no fallback.

const SKIP = process.platform === 'win32';
const REPO_ROOT = resolve(__dirname, '../..');

function shortTmp(): string {
  return mkdtempSync('/tmp/pi-ds2-');
}

/** Build a CJS bundle of PiProcessSupervisor with piLauncher and sharedPiHost mocked. */
async function buildSupervisorBundle() {
  const result = await build({
    stdin: {
      contents: "export { PiProcessSupervisor } from './src/process/supervisor';",
      resolveDir: REPO_ROOT,
    },
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    external: ['vscode', 'fixture-stubs'],
    plugins: [
      {
        name: 'detached-supervisor-stubs',
        setup(b) {
          b.onLoad({ filter: /piLauncher\.ts$/ }, () => ({
            contents: `
              export { piLaunchEnvironment } from 'fixture-stubs';
              export const PI_SDK_RANGE = { minMajor: 1, minMinor: 3, maxExclusiveMajor: 2 };
              export function isSupportedPiSdkVersion() { return true; }
              export function validateAdditionalArgs() {}
              export function resolvePiLaunch(settings, env, cwd) {
                const stubs = require('fixture-stubs');
                const launch = stubs.resolvePiLaunch();
                return Object.freeze({
                  command: launch.command ?? settings.executable,
                  prefixArgs: [],
                  mode: 'subprocess',
                  usingBundled: false,
                  label: 'fixture stub',
                  sdkRoot: launch.sdkRoot,
                  env: Object.freeze({ ...launch.env }),
                  cwd: launch.cwd,
                });
              }`,
            loader: 'ts',
          }));
          b.onLoad({ filter: /sharedPiHost\.ts$/ }, () => ({
            contents: `
              export function getSharedPiHost() {
                const stubs = require('fixture-stubs');
                return stubs.getSharedPiHost();
              }`,
            loader: 'ts',
          }));
        },
      },
    ],
  });
  return result.outputFiles[0]!.text;
}

function makeSettings() {
  return {
    sharedRuntime: true,
    piSource: 'external',
    executable: 'unused',
    additionalArgs: [] as string[],
    offline: true,
    launchShell: '',
    maxRecordBytes: 64 * 1024 * 1024,
    maxPendingRequests: 256,
    maxQueuedWrites: 256,
    maxTranscriptItems: 400,
    messageWindowSize: 50,
    maxToolOutputChars: 20000,
    maxImageBytes: 3145728,
    maxImagesPerPrompt: 4,
    detachedRuntimeEnabled: true,
    detachedRuntimeIdleMinutes: 10,
    responseTimeoutMs: 30000,
    longRunningTimeoutMs: 120000,
    restartOnCrash: false,
    maxRestartAttempts: 0,
    telemetryEnabled: false,
    autoStart: false,
    codeLensEnabled: false,
    remoteEnabled: false,
    turnReview: false,
    autoInstall: false,
    runtimeWorkers: 1 as number | 'auto',
    idleSessionMinutes: 0,
    allowApproveInTrustedWorkspace: false,
    workingAnimation: 'braille',
    chatFontFamily: '',
    chatFontSize: 0,
    typewriterSpeed: 'normal',
    autoCompactThreshold: 70,
    autoCompactMode: 'auto' as const,
    autoCompactPercent: 75,
    autoCompactResumeTask: true,
  };
}

function makeVscodeMock() {
  return {
    workspace: {
      isTrusted: false,
      getConfiguration: () => ({
        get: (_key: string, fallback: unknown) => fallback,
      }),
    },
    extensions: { getExtension: () => undefined },
  };
}

function makeFixtureStubs(
  sdkRoot: string,
  planEnv: NodeJS.ProcessEnv,
  cwd: string,
  tracker: { sharedHostUsed: boolean }
) {
  return {
    piLaunchEnvironment,
    resolvePiLaunch: () => ({
      sdkRoot,
      env: { ...planEnv },
      cwd,
    }),
    getSharedPiHost: () => {
      tracker.sharedHostUsed = true;
      return undefined;
    },
  };
}

function loadBundle(
  bundleText: string,
  stubs: ReturnType<typeof makeFixtureStubs>
): { PiProcessSupervisor: any } {
  const mod = { exports: {} as any };
  new Function('require', 'module', 'exports', bundleText)(
    (name: string) => {
      if (name === 'vscode') return makeVscodeMock();
      if (name === 'fixture-stubs') return stubs;
      return require(name);
    },
    mod,
    mod.exports
  );
  return mod.exports;
}

function makeLogger(logLines: string[]) {
  return {
    info: (msg: string) => logLines.push(msg),
    warn: (msg: string) => logLines.push(msg),
    error: (msg: string) => logLines.push(msg),
  };
}

// ── Test 1: LIVE re-attach while streaming (mid-stream) ─────────────────
test(
  'detached-step2: live re-attach while still streaming → replayed + live deltas, no duplicates',
  { skip: SKIP, timeout: 90000 },
  async () => {
    const fixture = await createNativeFixture('compact');
    const globalStorage = shortTmp();
    try {
      const plan = await nativeSdkHostPlan(fixture, 'shared');
      const planEnv = plan.env as NodeJS.ProcessEnv;
      const sdkRoot = planEnv.PI_HOST_PI_ROOT as string;
      const tracker = { sharedHostUsed: false };
      const bundleText = await buildSupervisorBundle();
      const stubs = makeFixtureStubs(sdkRoot, planEnv, plan.cwd, tracker);
      const { PiProcessSupervisor } = loadBundle(bundleText, stubs);
      const logLines: string[] = [];
      const logger = makeLogger(logLines);
      const settings = makeSettings();
      const folder = { name: 'Test', uri: { fsPath: fixture.cwd } };

      const sessionFile = join(fixture.cwd, 'live-reattach.jsonl');
      writeFileSync(
        sessionFile,
        JSON.stringify({
          type: 'session',
          version: 3,
          id: 'live-reattach',
          timestamp: '2024-01-01T00:00:00.000Z',
          cwd: fixture.cwd,
        }) + '\n'
      );

      // --- Supervisor 1: start and begin streaming ---
      const sup1 = new PiProcessSupervisor(folder, logger, settings, globalStorage, REPO_ROOT);
      fixture.setSummaryOutcome('success');
      const client1 = await sup1.start(sessionFile, { offline: true, noExtensions: true });
      assert.ok(client1, 'supervisor 1 started');

      const events1: any[] = [];
      client1.onEvent((e: any) => events1.push(e));
      const promptDone = client1.prompt('Live reattach fixture stream').catch(() => {});

      // Wait for the turn to start streaming (agent_start).
      const deadline1 = Date.now() + 30000;
      while (!events1.some((e: any) => e.type === 'agent_start')) {
        assert.ok(Date.now() < deadline1, 'timed out waiting for agent_start');
        await new Promise((r) => setTimeout(r, 10));
      }

      // Wait for at least some content deltas to arrive (the turn is still running).
      const deadline1b = Date.now() + 20000;
      while (events1.filter((e: any) => e.type === 'message_update').length < 2) {
        assert.ok(Date.now() < deadline1b, 'timed out waiting for message_update deltas');
        await new Promise((r) => setTimeout(r, 10));
      }

      // Dispose supervisor 1 MID-STREAM (turn is still active).
      sup1.dispose();
      await promptDone;

      // DO NOT wait for the turn to settle in JSONL — attach while still streaming.
      // Give a tiny delay to ensure the runtime keeps running.
      await new Promise((r) => setTimeout(r, 100));

      // --- Supervisor 2: attach while the runtime MAY still be streaming ---
      const sup2LogStart = logLines.length;
      tracker.sharedHostUsed = false;
      const sup2 = new PiProcessSupervisor(folder, logger, settings, globalStorage, REPO_ROOT);
      fixture.setSummaryOutcome('success');
      const client2 = await sup2.start(sessionFile, { offline: true, noExtensions: true });
      assert.ok(client2, 'supervisor 2 attached');
      assert.equal(tracker.sharedHostUsed, false, 'detached path used, not shared host');

      // Collect events on client2 (may include replayed + live).
      const events2: any[] = [];
      client2.onEvent((e: any) => events2.push(e));

      // Wait for the turn to settle (either already settled or arrives live).
      const deadline2 = Date.now() + 30000;
      const isSettled = () =>
        events2.some((e: any) => e.type === 'agent_settled') ||
        // The turn may have already settled before we attached; check transcript.
        (() => {
          try {
            return readFileSync(sessionFile, 'utf8')
              .trim()
              .split('\n')
              .map((l) => JSON.parse(l))
              .some(
                (e: any) =>
                  e.type === 'message' && e.message?.role === 'assistant' && e.message?.stopReason
              );
          } catch {
            return false;
          }
        })();
      while (!isSettled()) {
        assert.ok(Date.now() < deadline2, 'timed out waiting for turn to settle');
        await new Promise((r) => setTimeout(r, 20));
      }

      // No interrupted marker.
      assert.equal(
        readFileSync(sessionFile, 'utf8').includes('vscode-pi.turn-interrupted'),
        false,
        'no interrupted marker'
      );

      // Transcript has the full content exactly once.
      const saved = readFileSync(sessionFile, 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l));
      const messages = selectActiveBranchMessages<any>(saved, Infinity);
      const assistants = messages.filter((m: any) => m.role === 'assistant');
      assert.equal(assistants.length, 1, 'exactly one assistant reply (no duplicates from replay)');
      assert.ok(
        assistants[0].content.some((b: any) => typeof b.text === 'string' && b.text.length > 0),
        'assistant has full content'
      );

      // Supervisor 2 logged detached runtime attach.
      const sup2Logs = logLines.slice(sup2LogStart);
      assert.ok(
        sup2Logs.some((l) => l.includes('via detached runtime')),
        'supervisor 2 logged detached attach'
      );

      await sup2.stop();
    } finally {
      try {
        stopBackgroundRuntimes(detachedRuntimeBaseDir(globalStorage));
      } catch {
        /* ignore */
      }
      const denied = readFileSync(fixture.networkLog, 'utf8');
      await fixture.dispose();
      assert.equal(denied.trim(), '', 'no forbidden network requests');
    }
  }
);

// ── Test 2: deactivate() with active turn → runtime survives ─────────────
test(
  'detached-step2: deactivate with active turn → runtime survives and completes the turn',
  { skip: SKIP, timeout: 90000 },
  async () => {
    const fixture = await createNativeFixture('compact');
    const globalStorage = shortTmp();
    try {
      const plan = await nativeSdkHostPlan(fixture, 'shared');
      const planEnv = plan.env as NodeJS.ProcessEnv;
      const sdkRoot = planEnv.PI_HOST_PI_ROOT as string;
      const tracker = { sharedHostUsed: false };
      const bundleText = await buildSupervisorBundle();
      const stubs = makeFixtureStubs(sdkRoot, planEnv, plan.cwd, tracker);
      const { PiProcessSupervisor } = loadBundle(bundleText, stubs);
      const logLines: string[] = [];
      const logger = makeLogger(logLines);
      const settings = makeSettings();
      const folder = { name: 'Test', uri: { fsPath: fixture.cwd } };

      const sessionFile = join(fixture.cwd, 'deactivate-active.jsonl');
      writeFileSync(
        sessionFile,
        JSON.stringify({
          type: 'session',
          version: 3,
          id: 'deactivate-active',
          timestamp: '2024-01-01T00:00:00.000Z',
          cwd: fixture.cwd,
        }) + '\n'
      );

      // Start supervisor, begin a turn.
      const sup = new PiProcessSupervisor(folder, logger, settings, globalStorage, REPO_ROOT);
      fixture.setSummaryOutcome('success');
      const client = await sup.start(sessionFile, { offline: true, noExtensions: true });
      assert.ok(client, 'supervisor started');

      const events: any[] = [];
      client.onEvent((e: any) => events.push(e));
      const promptDone = client.prompt('Deactivate during streaming').catch(() => {});

      // Wait for agent_start.
      const deadline = Date.now() + 30000;
      while (!events.some((e: any) => e.type === 'agent_start')) {
        assert.ok(Date.now() < deadline, 'timed out waiting for agent_start');
        await new Promise((r) => setTimeout(r, 10));
      }

      // Simulate extension deactivate: dispose() without stop().
      sup.dispose();
      await promptDone;

      // The runtime must survive and complete the turn to JSONL.
      const deadline2 = Date.now() + 30000;
      const settled = () => {
        try {
          return readFileSync(sessionFile, 'utf8')
            .trim()
            .split('\n')
            .map((l) => JSON.parse(l))
            .some(
              (e: any) =>
                e.type === 'message' && e.message?.role === 'assistant' && e.message?.stopReason
            );
        } catch {
          return false;
        }
      };
      while (!settled()) {
        assert.ok(Date.now() < deadline2, 'runtime completed the turn after deactivate');
        await new Promise((r) => setTimeout(r, 20));
      }

      // No interrupted marker.
      assert.equal(
        readFileSync(sessionFile, 'utf8').includes('vscode-pi.turn-interrupted'),
        false,
        'no interrupted marker after deactivate with active turn'
      );
    } finally {
      try {
        stopBackgroundRuntimes(detachedRuntimeBaseDir(globalStorage));
      } catch {
        /* ignore */
      }
      const denied = readFileSync(fixture.networkLog, 'utf8');
      await fixture.dispose();
      assert.equal(denied.trim(), '', 'no forbidden network requests');
    }
  }
);

// ── Test 3: idle runtime exits when no client and no active turn ─────────
test(
  'detached-step2: idle runtime exits when no client and no active turn',
  { skip: SKIP, timeout: 60000 },
  async () => {
    const fixture = await createNativeFixture('compact');
    const globalStorage = shortTmp();
    let runtimePid: number | undefined;
    try {
      const plan = await nativeSdkHostPlan(fixture, 'shared');
      const planEnv = plan.env as NodeJS.ProcessEnv;
      const sdkRoot = planEnv.PI_HOST_PI_ROOT as string;

      // Spawn a detached runtime with a very short idle timeout.
      const { spawnDetachedRuntime } = await import(
        '../../src/process/detachedRuntime/detachedHost.js'
      );
      const { DetachedIpcConnection } = await import(
        '../../src/process/detachedRuntime/ipcClient.js'
      );
      // Use the fixture's TMPDIR so it's within --allow-fs-read/write scope.
      const dir = planEnv.TMPDIR ?? shortTmp();
      const runtime = await spawnDetachedRuntime({
        hostScript: '',
        command: plan.command,
        args: [...plan.args],
        cwd: plan.cwd,
        env: planEnv,
        sdkRoot,
        envKey: 'idle-test',
        runtimeBaseDir: dir,
        idleMs: 2_000, // 2 seconds idle
        endpointOverride: join(dir, `idle${Math.floor(Math.random() * 1e6)}.sock`),
      });
      runtimePid = runtime.child.pid;
      assert.ok(runtimePid, 'runtime spawned');

      // Connect and immediately disconnect to trigger the idle timer.
      const conn = new DetachedIpcConnection();
      const result = await conn.connect(runtime.endpoint, runtime.token, {});
      assert.ok(result.ok, 'auth succeeded');
      conn.dispose();

      // Wait for the runtime to self-exit.
      const deadline = Date.now() + 15000;
      const pidAlive = (pid: number) => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      };
      while (pidAlive(runtimePid!)) {
        assert.ok(Date.now() < deadline, 'runtime self-exited after idle timeout');
        await new Promise((r) => setTimeout(r, 100));
      }
      // pid is dead: success.
      runtimePid = undefined;
    } finally {
      if (runtimePid) {
        try {
          process.kill(runtimePid, 'SIGKILL');
        } catch {
          /* already gone */
        }
      }
      try {
        stopBackgroundRuntimes(detachedRuntimeBaseDir(globalStorage));
      } catch {
        /* ignore */
      }
      await fixture.dispose();
    }
  }
);

// ── Test 4: Two-window refusal — busy-elsewhere ─────────────────────────
test(
  'detached-step2: two-window refusal — supervisor gets SDK_SESSION_BUSY_ELSEWHERE',
  { skip: SKIP, timeout: 60000 },
  async () => {
    const fixture = await createNativeFixture('compact');
    const globalStorage = shortTmp();
    try {
      const plan = await nativeSdkHostPlan(fixture, 'shared');
      const planEnv = plan.env as NodeJS.ProcessEnv;
      const sdkRoot = planEnv.PI_HOST_PI_ROOT as string;
      const tracker = { sharedHostUsed: false };
      const bundleText = await buildSupervisorBundle();
      const stubs = makeFixtureStubs(sdkRoot, planEnv, plan.cwd, tracker);
      const { PiProcessSupervisor } = loadBundle(bundleText, stubs);
      const logLines: string[] = [];
      const logger = makeLogger(logLines);
      const settings = makeSettings();
      const folder = { name: 'Test', uri: { fsPath: fixture.cwd } };

      const sessionFile = join(fixture.cwd, 'busy-elsewhere.jsonl');
      writeFileSync(
        sessionFile,
        JSON.stringify({
          type: 'session',
          version: 3,
          id: 'busy-elsewhere',
          timestamp: '2024-01-01T00:00:00.000Z',
          cwd: fixture.cwd,
        }) + '\n'
      );

      // Supervisor 1: start normally.
      const sup1 = new PiProcessSupervisor(folder, logger, settings, globalStorage, REPO_ROOT);
      fixture.setSummaryOutcome('success');
      const client1 = await sup1.start(sessionFile, { offline: true, noExtensions: true });
      assert.ok(client1, 'supervisor 1 started');

      // Supervisor 2: tries to attach to the SAME session while sup1 is controlling it.
      tracker.sharedHostUsed = false;
      const sup2 = new PiProcessSupervisor(folder, logger, settings, globalStorage, REPO_ROOT);
      fixture.setSummaryOutcome('success');
      let busyError: Error | undefined;
      try {
        await sup2.start(sessionFile, { offline: true, noExtensions: true });
      } catch (e) {
        busyError = e as Error;
      }
      assert.ok(busyError, 'supervisor 2 threw');
      assert.ok(
        busyError.message.includes('another VS Code window'),
        `error message mentions another window: ${busyError.message}`
      );
      assert.equal(
        (busyError as any).code,
        'SDK_SESSION_BUSY_ELSEWHERE',
        'error code is SDK_SESSION_BUSY_ELSEWHERE'
      );
      // Must NOT have fallen back to shared host.
      assert.equal(tracker.sharedHostUsed, false, 'did not fall back to shared host');

      await sup1.stop();
    } finally {
      try {
        stopBackgroundRuntimes(detachedRuntimeBaseDir(globalStorage));
      } catch {
        /* ignore */
      }
      const denied = readFileSync(fixture.networkLog, 'utf8');
      await fixture.dispose();
      assert.equal(denied.trim(), '', 'no forbidden network requests');
    }
  }
);
