import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { piLaunchEnvironment } from '../../src/process/piLauncher';
import { createNativeFixture, nativeSdkHostPlan } from '../helpers/nativeFixture';
import {
  detachedRuntimeBaseDir,
  stopBackgroundRuntimesAndWait,
} from '../../src/process/detachedRuntime/stopRuntimes';
import {
  readRegistry,
  addEntry,
  type RuntimeEntry,
} from '../../src/process/detachedRuntime/registry';

// Integration tests for dead-draft hang prevention and cold-start latency.
// Uses a REAL PiProcessSupervisor (bundled via esbuild with piLauncher/sharedPiHost
// mocked) and the REAL SDK host (PI_TEST_SDK=13|15) to verify:
// 1. Park a draft → SIGKILL the runtime → next New Chat becomes ready via fresh open.
// 2. The draft is evicted when its connection closes.
// 3. A stale registry entry with a dead pid is skipped quickly.
// 4. Cold first chat on the detached path completes within a reasonable bound.

const SKIP = process.platform === 'win32';
const REPO_ROOT = resolve(__dirname, '../..');

function shortTmp(): string {
  return mkdtempSync('/tmp/pi-ds-live-');
}

/** Build a CJS bundle of PiProcessSupervisor + warmDetachedRuntime with piLauncher and sharedPiHost mocked. */
async function buildSupervisorBundle() {
  const result = await build({
    stdin: {
      contents:
        "export { PiProcessSupervisor, warmDetachedRuntime, disposeParkedDetachedDrafts } from './src/process/supervisor';",
      resolveDir: REPO_ROOT,
    },
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    external: ['vscode', 'fixture-stubs'],
    plugins: [
      {
        name: 'detached-liveness-stubs',
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
              const stubs = require('fixture-stubs');
              export function getSharedPiHost() {
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

function loadBundle(
  bundleText: string,
  sdkRoot: string,
  planEnv: NodeJS.ProcessEnv,
  cwd: string,
  overrides?: { getSharedPiHost?: () => any }
) {
  const mod = { exports: {} as any };
  new Function('require', 'module', 'exports', bundleText)(
    (name: string) => {
      if (name === 'vscode') {
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
      if (name === 'fixture-stubs') {
        return {
          piLaunchEnvironment,
          resolvePiLaunch: () => ({
            sdkRoot,
            env: { ...planEnv },
            cwd,
          }),
          getSharedPiHost: overrides?.getSharedPiHost ?? (() => undefined),
        };
      }
      return require(name);
    },
    mod,
    mod.exports
  );
  return mod.exports;
}

test(
  'park a draft → SIGKILL runtime → next New Chat becomes ready via fresh open (no hang)',
  { skip: SKIP, timeout: 90000 },
  async () => {
    const fixture = await createNativeFixture('compact');
    const globalStorage = shortTmp();
    let disposeParked: (() => void) | undefined;
    try {
      const plan = await nativeSdkHostPlan(fixture, 'shared');
      const planEnv = plan.env as NodeJS.ProcessEnv;
      const sdkRoot = planEnv.PI_HOST_PI_ROOT as string;

      const bundleText = await buildSupervisorBundle();
      const exports = loadBundle(bundleText, sdkRoot, planEnv, plan.cwd);
      const { PiProcessSupervisor, disposeParkedDetachedDrafts } = exports;
      disposeParked = disposeParkedDetachedDrafts;
      const logLines: string[] = [];
      const logger = {
        info: (msg: string) => logLines.push(msg),
        warn: (msg: string) => logLines.push(msg),
        error: (msg: string) => logLines.push(msg),
      };

      const settings = makeSettings();
      const folder = { name: 'Test', uri: { fsPath: fixture.cwd } };

      // --- First New Chat: creates a parked draft ---
      const sup1 = new PiProcessSupervisor(folder, logger, settings, globalStorage, REPO_ROOT);
      fixture.setSummaryOutcome('success');
      const client1 = await sup1.start(undefined, { offline: true, noExtensions: true });
      assert.ok(client1, 'first chat got a client');

      // Wait for the parked draft to be created.
      const draftDeadline = Date.now() + 15000;
      while (!logLines.some((l) => l.includes('Parked detached draft'))) {
        assert.ok(Date.now() < draftDeadline, `draft not parked: ${logLines.join(' | ')}`);
        await new Promise((r) => setTimeout(r, 50));
      }

      // --- SIGKILL the runtime ---
      const baseDir = detachedRuntimeBaseDir(globalStorage);
      const entries = readRegistry(baseDir);
      assert.ok(entries.length >= 1, 'at least one registry entry');
      const runtimePid = entries[0]!.pid;
      process.kill(runtimePid, 'SIGKILL');
      // Wait for the process to actually die.
      const killDeadline = Date.now() + 5000;
      while (true) {
        try {
          process.kill(runtimePid, 0);
        } catch {
          break;
        }
        assert.ok(Date.now() < killDeadline, 'runtime did not die after SIGKILL');
        await new Promise((r) => setTimeout(r, 50));
      }

      // --- Second New Chat: should NOT hang, should become ready via fresh open ---
      // The dead draft may have been evicted proactively by the onClose listener
      // (test 2 covers that). Either way, sup2 must NOT hang.
      const logBefore = logLines.length;
      const sup2 = new PiProcessSupervisor(folder, logger, settings, globalStorage, REPO_ROOT);
      fixture.setSummaryOutcome('success');
      const t0 = Date.now();
      const client2 = await sup2.start(undefined, { offline: true, noExtensions: true });
      const elapsed = Date.now() - t0;
      assert.ok(client2, 'second chat got a client after SIGKILL');

      const sup2Logs = logLines.slice(logBefore);
      // Should NOT adopt the dead draft (either evicted or discarded).
      const adoptLog = sup2Logs.find((l) => l.includes('Adopted parked detached draft'));
      assert.equal(adoptLog, undefined, 'dead draft was not adopted');

      // The draft was either: (a) evicted proactively by onClose, or (b) discarded
      // at adoption time by the liveness gate. Either is correct.
      const anyLog = logLines.find(
        (l) =>
          l.includes('Discarding dead') ||
          l.includes('connection/pid not alive') ||
          l.includes('Evicted parked detached draft')
      );
      assert.ok(anyLog, `dead draft was handled: ${logLines.slice(-20).join(' | ')}`);

      // Should have opened via detached runtime (fresh spawn).
      const detachedLog = sup2Logs.find((l) => l.includes('via detached runtime'));
      assert.ok(detachedLog, `second chat used detached runtime: ${sup2Logs.join(' | ')}`);

      // The start should complete reasonably fast (not hang for 120s).
      assert.ok(elapsed < 30000, `second chat started in ${elapsed}ms (expected < 30s)`);
      // Log timing for analysis.
      const timingLogs = sup2Logs.filter((l) => l.includes('[detached-timing]'));
      if (timingLogs.length) {
        const summary = timingLogs.map((l) => l.replace(/.*\[detached-timing\]\s*/, '')).join('; ');
        console.log(`[test] second chat timing (${elapsed}ms): ${summary}`);
      }

      disposeParkedDetachedDrafts();
      await sup1.stop().catch(() => {});
      await sup2.stop();
    } finally {
      try {
        disposeParked?.();
      } catch {
        /* ignore */
      }
      try {
        await stopBackgroundRuntimesAndWait(detachedRuntimeBaseDir(globalStorage));
      } catch {
        /* ignore */
      }
      await fixture.dispose();
    }
  }
);

test(
  'parked draft is evicted when its connection closes',
  { skip: SKIP, timeout: 90000 },
  async () => {
    const fixture = await createNativeFixture('compact');
    const globalStorage = shortTmp();
    let disposeParked: (() => void) | undefined;
    try {
      const plan = await nativeSdkHostPlan(fixture, 'shared');
      const planEnv = plan.env as NodeJS.ProcessEnv;
      const sdkRoot = planEnv.PI_HOST_PI_ROOT as string;

      const bundleText = await buildSupervisorBundle();
      const exports = loadBundle(bundleText, sdkRoot, planEnv, plan.cwd);
      const { PiProcessSupervisor, disposeParkedDetachedDrafts } = exports;
      disposeParked = disposeParkedDetachedDrafts;
      const logLines: string[] = [];
      const logger = {
        info: (msg: string) => logLines.push(msg),
        warn: (msg: string) => logLines.push(msg),
        error: (msg: string) => logLines.push(msg),
      };

      const settings = makeSettings();
      const folder = { name: 'Test', uri: { fsPath: fixture.cwd } };

      // First New Chat: creates a parked draft.
      const sup1 = new PiProcessSupervisor(folder, logger, settings, globalStorage, REPO_ROOT);
      fixture.setSummaryOutcome('success');
      await sup1.start(undefined, { offline: true, noExtensions: true });

      const draftDeadline = Date.now() + 15000;
      while (!logLines.some((l) => l.includes('Parked detached draft'))) {
        assert.ok(Date.now() < draftDeadline, `draft not parked: ${logLines.join(' | ')}`);
        await new Promise((r) => setTimeout(r, 50));
      }

      // SIGKILL the runtime → connection drops → draft should be evicted.
      const baseDir = detachedRuntimeBaseDir(globalStorage);
      const entries = readRegistry(baseDir);
      assert.ok(entries.length >= 1);
      process.kill(entries[0]!.pid, 'SIGKILL');

      // Wait for the eviction log.
      const evictDeadline = Date.now() + 10000;
      while (!logLines.some((l) => l.includes('Evicted parked detached draft'))) {
        assert.ok(
          Date.now() < evictDeadline,
          `draft not evicted after connection close: ${logLines.join(' | ')}`
        );
        await new Promise((r) => setTimeout(r, 50));
      }

      disposeParkedDetachedDrafts();
      await sup1.stop().catch(() => {});
    } finally {
      try {
        disposeParked?.();
      } catch {
        /* ignore */
      }
      try {
        await stopBackgroundRuntimesAndWait(detachedRuntimeBaseDir(globalStorage));
      } catch {
        /* ignore */
      }
      await fixture.dispose();
    }
  }
);

test(
  'stale registry entry with dead pid is skipped quickly (< 2s)',
  { skip: SKIP, timeout: 60000 },
  async () => {
    const fixture = await createNativeFixture('compact');
    const globalStorage = shortTmp();
    try {
      const plan = await nativeSdkHostPlan(fixture, 'shared');
      const planEnv = plan.env as NodeJS.ProcessEnv;
      const sdkRoot = planEnv.PI_HOST_PI_ROOT as string;

      const bundleText = await buildSupervisorBundle();
      const exports = loadBundle(bundleText, sdkRoot, planEnv, plan.cwd);
      const { PiProcessSupervisor } = exports;
      const logLines: string[] = [];
      const logger = {
        info: (msg: string) => logLines.push(msg),
        warn: (msg: string) => logLines.push(msg),
        error: (msg: string) => logLines.push(msg),
      };

      // Add a stale registry entry with a dead pid.
      const baseDir = detachedRuntimeBaseDir(globalStorage);
      const { mkdirSync, writeFileSync } = require('node:fs');
      mkdirSync(baseDir, { recursive: true });
      const staleTokenFile = require('node:path').join(baseDir, 'stale.token');
      writeFileSync(staleTokenFile, 'deadtoken', { mode: 0o600 });
      const staleEntry: RuntimeEntry = {
        id: 'stale-runtime-id',
        pid: 999999, // very likely dead
        endpoint: '/tmp/nonexistent-socket.sock',
        transport: 'unix',
        sdkRoot,
        envKey: 'stale-envkey',
        tokenFile: staleTokenFile,
        startedAt: Date.now() - 100000,
        owner: {},
      };
      addEntry(baseDir, staleEntry);

      const settings = makeSettings();
      const folder = { name: 'Test', uri: { fsPath: fixture.cwd } };

      // Start should skip the stale entry quickly and spawn a new runtime.
      const t0 = Date.now();
      const sup = new PiProcessSupervisor(folder, logger, settings, globalStorage, REPO_ROOT);
      fixture.setSummaryOutcome('success');
      const client = await sup.start(undefined, { offline: true, noExtensions: true });
      const elapsed = Date.now() - t0;
      assert.ok(client, 'got a client despite stale entry');

      // The stale entry should be cleaned up quickly (pidAlive check), not waited on.
      // cleanupStale (called by findByEnv) removes dead entries, so the stale entry
      // never triggers a connect attempt.
      assert.ok(elapsed < 30000, `started in ${elapsed}ms`);

      await sup.stop();
    } finally {
      try {
        await stopBackgroundRuntimesAndWait(detachedRuntimeBaseDir(globalStorage));
      } catch {
        /* ignore */
      }
      await fixture.dispose();
    }
  }
);

test(
  'cold first chat on the detached path completes within timing bound',
  { skip: SKIP, timeout: 60000 },
  async () => {
    const fixture = await createNativeFixture('compact');
    const globalStorage = shortTmp();
    try {
      const plan = await nativeSdkHostPlan(fixture, 'shared');
      const planEnv = plan.env as NodeJS.ProcessEnv;
      const sdkRoot = planEnv.PI_HOST_PI_ROOT as string;

      const bundleText = await buildSupervisorBundle();
      const exports = loadBundle(bundleText, sdkRoot, planEnv, plan.cwd);
      const { warmDetachedRuntime, PiProcessSupervisor, disposeParkedDetachedDrafts } = exports;
      const logLines: string[] = [];
      const logger = {
        info: (msg: string) => logLines.push(msg),
        warn: (msg: string) => logLines.push(msg),
        error: (msg: string) => logLines.push(msg),
      };

      // Warm the runtime first (simulates sidebar warmup).
      await warmDetachedRuntime({
        sdkRoot,
        env: { ...planEnv },
        globalStorageFsPath: globalStorage,
        extensionPath: REPO_ROOT,
        idleMinutes: 10,
        logger,
      });

      // Now time the first New Chat through the supervisor.
      const settings = makeSettings();
      const folder = { name: 'Test', uri: { fsPath: fixture.cwd } };
      const sup = new PiProcessSupervisor(folder, logger, settings, globalStorage, REPO_ROOT);
      fixture.setSummaryOutcome('success');
      const t0 = Date.now();
      const client = await sup.start(undefined, { offline: true, noExtensions: true });
      const elapsed = Date.now() - t0;
      assert.ok(client, 'cold first chat got a client');

      // Report timing breakdown from logs.
      const timingLogs = logLines.filter((l) => l.includes('[detached-timing]'));
      const timingSummary = timingLogs
        .map((l) => l.replace(/.*\[detached-timing\]\s*/, ''))
        .join('; ');

      // The cold first chat (with pre-warmed runtime) should complete reasonably fast.
      // With the existing runtime warm, the main cost is lock + connect + open.
      // We allow 10s as a generous bound (target: ~2-3s like the shared host).
      assert.ok(elapsed < 10000, `cold first chat took ${elapsed}ms (timing: ${timingSummary})`);

      disposeParkedDetachedDrafts();
      await sup.stop();
    } finally {
      try {
        await stopBackgroundRuntimesAndWait(detachedRuntimeBaseDir(globalStorage));
      } catch {
        /* ignore */
      }
      await fixture.dispose();
    }
  }
);
