import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
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

// Integration tests for the detached-runtime supervisor re-attach flow.
// Uses a REAL PiProcessSupervisor (bundled via esbuild with piLauncher/sharedPiHost
// mocked) and the REAL SDK host (PI_TEST_SDK=13|15) to verify:
// 1. Start a streaming turn through the supervisor, dispose mid-stream (disconnect
//    only), construct a NEW supervisor → it ATTACHES via the detached path with no
//    fallback to the shared host, the full reply arrives with no interrupted marker,
//    and a second prompt works.
// 2. Negative: a non-existent host script triggers the fallback log line and the
//    shared-host session works.
// 3. Wrong token is rejected with a clear error.

const SKIP = process.platform === 'win32';
const REPO_ROOT = resolve(__dirname, '../..');

function shortTmp(): string {
  return mkdtempSync('/tmp/pi-ds-');
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
          // Mock piLauncher: delegate sdkRoot/env/cwd from fixture stubs.
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
          // Mock sharedPiHost: track fallback usage.
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

test(
  'detached-supervisor: real supervisor start → dispose mid-stream → re-attach → full reply → second prompt',
  { skip: SKIP, timeout: 90000 },
  async () => {
    const fixture = await createNativeFixture('compact');
    const globalStorage = shortTmp();
    try {
      const plan = await nativeSdkHostPlan(fixture, 'shared');
      const planEnv = plan.env as NodeJS.ProcessEnv;
      const sdkRoot = planEnv.PI_HOST_PI_ROOT as string;

      // Track shared-host fallback.
      let sharedHostUsed = false;

      // Build the supervisor bundle.
      const bundleText = await buildSupervisorBundle();
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
                cwd: plan.cwd,
              }),
              getSharedPiHost: () => {
                sharedHostUsed = true;
                return undefined; // No shared host available in this test.
              },
            };
          }
          return require(name);
        },
        mod,
        mod.exports
      );

      const { PiProcessSupervisor } = mod.exports;
      const logLines: string[] = [];
      const logger = {
        info: (msg: string) => logLines.push(msg),
        warn: (msg: string) => logLines.push(msg),
        error: (msg: string) => logLines.push(msg),
      };

      const sessionFile = join(fixture.cwd, 'supervisor-reattach.jsonl');
      writeFileSync(
        sessionFile,
        JSON.stringify({
          type: 'session',
          version: 3,
          id: 'sup-reattach',
          timestamp: '2024-01-01T00:00:00.000Z',
          cwd: fixture.cwd,
        }) + '\n'
      );

      const settings = {
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

      const folder = { name: 'Test', uri: { fsPath: fixture.cwd } };

      // --- Supervisor 1: start, prompt, dispose mid-stream ---
      const sup1 = new PiProcessSupervisor(folder, logger, settings, globalStorage, REPO_ROOT);
      fixture.setSummaryOutcome('success');
      const client1 = await sup1.start(sessionFile, {
        offline: true,
        noExtensions: true,
      });
      assert.ok(client1, 'supervisor 1 returned a client');
      assert.equal(sharedHostUsed, false, 'detached path used, not shared host');

      // Verify the attach log line.
      const attachLog1 = logLines.find((l) => l.includes('via detached runtime'));
      assert.ok(attachLog1, 'supervisor logged detached runtime attach');

      // Send a prompt (the session file was already passed to start()).
      const events1: any[] = [];
      client1.onEvent((e: any) => events1.push(e));
      // Fire prompt (don't await — we dispose mid-stream).
      const promptDone = client1.prompt('Long fixture stream').catch(() => {});

      // Wait for the turn to start.
      const deadline1 = Date.now() + 30000;
      while (!events1.some((e) => e.type === 'agent_start')) {
        assert.ok(Date.now() < deadline1, 'timed out waiting for agent_start');
        await new Promise((r) => setTimeout(r, 10));
      }

      // Dispose (disconnect only, don't stop the runtime).
      sup1.dispose();
      await promptDone;

      // Wait for the runtime to complete the turn to JSONL.
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
      const deadline2 = Date.now() + 30000;
      while (!settled()) {
        assert.ok(Date.now() < deadline2, 'runtime completes the turn after supervisor dispose');
        await new Promise((r) => setTimeout(r, 20));
      }
      assert.equal(
        readFileSync(sessionFile, 'utf8').includes('vscode-pi.turn-interrupted'),
        false,
        'no interrupted marker after supervisor dispose'
      );

      // --- Supervisor 2: re-attach to the same detached runtime ---
      logLines.length = 0;
      sharedHostUsed = false;
      const sup2 = new PiProcessSupervisor(folder, logger, settings, globalStorage, REPO_ROOT);
      fixture.setSummaryOutcome('success');
      const client2 = await sup2.start(sessionFile, {
        offline: true,
        noExtensions: true,
      });
      assert.ok(client2, 'supervisor 2 returned a client');
      assert.equal(sharedHostUsed, false, 're-attach used detached path, not shared host');

      // Verify the re-attach log line.
      const attachLog2 = logLines.find((l) => l.includes('via detached runtime'));
      assert.ok(attachLog2, 'supervisor 2 logged detached runtime attach');

      // Verify the transcript is complete.
      const saved = readFileSync(sessionFile, 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l));
      assert.equal(
        saved.some((e: any) => e.customType === 'vscode-pi.turn-interrupted'),
        false,
        'no interrupted marker in transcript'
      );
      const messages = selectActiveBranchMessages<any>(saved, Infinity);
      const assistant = messages.filter((m: any) => m.role === 'assistant').at(-1);
      assert.ok(assistant, 'assistant reply persisted');
      assert.ok(
        assistant.content.some((b: any) => typeof b.text === 'string' && b.text.length > 0),
        'assistant has full content'
      );

      // Second prompt through the re-attached supervisor.
      fixture.setSummaryOutcome('success');
      await client2.prompt('Second prompt after reattach');

      await sup2.stop();
    } finally {
      // Kill any detached runtimes so the test process can exit.
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

test(
  'detached-supervisor: non-existent host script → fallback log line',
  { skip: SKIP, timeout: 30000 },
  async () => {
    const fixture = await createNativeFixture('compact');
    try {
      const plan = await nativeSdkHostPlan(fixture, 'shared');
      const planEnv = plan.env as NodeJS.ProcessEnv;
      const sdkRoot = planEnv.PI_HOST_PI_ROOT as string;
      const globalStorage = shortTmp();
      const bogusExtPath = join(shortTmp(), 'nonexistent-extension');

      let sharedHostUsed = false;
      const bundleText = await buildSupervisorBundle();
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
                cwd: plan.cwd,
              }),
              getSharedPiHost: () => {
                sharedHostUsed = true;
                // Return a mock shared host that opens a session.
                const { PassThrough } = require('node:stream');
                return {
                  warmPool: () => {},
                  openSession: async (_info: any, _cancel: any, cb: any) => {
                    const handle = {
                      stdin: new PassThrough(),
                      stdout: new PassThrough(),
                      stderr: new PassThrough(),
                      onError: () => {},
                      onExit: () => {},
                      stop: async () => {},
                    };
                    if (cb) cb(handle);
                    return handle;
                  },
                };
              },
            };
          }
          return require(name);
        },
        mod,
        mod.exports
      );

      const { PiProcessSupervisor } = mod.exports;
      const logLines: string[] = [];
      const logger = {
        info: (msg: string) => logLines.push(msg),
        warn: (msg: string) => logLines.push(msg),
        error: (msg: string) => logLines.push(msg),
      };
      const settings = {
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

      const folder = { name: 'Test', uri: { fsPath: fixture.cwd } };
      // Use bogus extensionPath so host/pi-multi-host.mjs doesn't exist.
      const sup = new PiProcessSupervisor(folder, logger, settings, globalStorage, bogusExtPath);
      const client = await sup.start(undefined, { offline: true, noExtensions: true });
      assert.ok(client, 'shared host fallback returned a client');
      assert.equal(sharedHostUsed, true, 'shared host was used as fallback');
      const fallbackLog = logLines.find(
        (l) => l.includes('host script not found') || l.includes('falling back to shared host')
      );
      assert.ok(fallbackLog, `fallback log line emitted: ${logLines.join(' | ')}`);
      await sup.stop();
    } finally {
      await fixture.dispose();
    }
  }
);

test(
  'detached-supervisor: auth failure produces clear error (fallback trigger)',
  { skip: SKIP, timeout: 30000 },
  async () => {
    // When connect/auth fails, the supervisor's detached path catches and falls
    // back to the shared host. This unit-level test verifies the wire protocol
    // rejection directly (no supervisor esbuild needed).
    const { DetachedIpcConnection } = await import(
      '../../src/process/detachedRuntime/ipcClient.js'
    );
    const { spawnDetachedRuntime } = await import(
      '../../src/process/detachedRuntime/detachedHost.js'
    );
    const fixture = await createNativeFixture('compact');
    let child;
    try {
      const plan = await nativeSdkHostPlan(fixture, 'shared');
      const planEnv = plan.env as NodeJS.ProcessEnv;
      const dir = planEnv.TMPDIR ?? shortTmp();
      const runtime = await spawnDetachedRuntime({
        hostScript: '',
        command: plan.command,
        args: [...plan.args],
        cwd: plan.cwd,
        env: planEnv,
        sdkRoot: planEnv.PI_HOST_PI_ROOT as string,
        envKey: 'test-env',
        runtimeBaseDir: dir,
        idleMs: 600_000,
        endpointOverride: join(dir, `d${Math.floor(Math.random() * 1e6)}.sock`),
      });
      child = runtime.child;

      const client = new DetachedIpcConnection();
      const result = await client.connect(runtime.endpoint, 'deadbeef'.repeat(8), {});
      assert.equal(result.ok, false, 'wrong token rejects');
      assert.equal(result.error, 'unauthorized', 'error is unauthorized');
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
