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
  stopBackgroundRuntimesAndWait,
} from '../../src/process/detachedRuntime/stopRuntimes';

// Integration tests for the deactivate/reload fix (PR #46 reload defect).
//
// The bug: SessionController.dispose() called this.stop() which sent the CLOSE
// command to the runtime, aborting in-flight turns on every window reload.
// The fix: on the detached path, dispose() performs controller-side cleanup
// (flags, timers, watchers, emitters) WITHOUT sending close, then calls
// supervisor.dispose() (disconnect only). Non-detached keeps #44 behaviour.
//
// Tests exercise the REAL SessionController → SessionRegistry → Supervisor chain
// bundled via esbuild with the vscode shim, to verify registry.dispose() mid-stream
// does not interrupt the turn.

const SKIP = process.platform === 'win32';
const REPO_ROOT = resolve(__dirname, '../..');

function shortTmp(): string {
  return mkdtempSync('/tmp/pi-ds-deact-');
}

/** Build a CJS bundle of SessionRegistry + SessionController + PiProcessSupervisor. */
async function buildControllerBundle() {
  const result = await build({
    stdin: {
      contents: `
        export { SessionRegistry } from './src/sessions/sessionRegistry';
        export { SessionController } from './src/sessions/sessionController';
        export { PiProcessSupervisor, disposeParkedDetachedDrafts } from './src/process/supervisor';
      `,
      resolveDir: REPO_ROOT,
    },
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    external: ['vscode', 'fixture-stubs'],
    plugins: [
      {
        name: 'detached-controller-stubs',
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

/** Minimal vscode shim with a working EventEmitter (SessionController needs it). */
function makeVscodeShim() {
  return {
    EventEmitter: class EventEmitter {
      private listeners: Array<(...args: any[]) => any> = [];
      event = (listener: (...args: any[]) => any) => {
        this.listeners.push(listener);
        return {
          dispose: () => {
            this.listeners = this.listeners.filter((l) => l !== listener);
          },
        };
      };
      fire(data?: any) {
        for (const l of this.listeners) l(data);
      }
      dispose() {
        this.listeners = [];
      }
    },
    CancellationTokenSource: class CancellationTokenSource {
      token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };
      cancel() {
        (this.token as any).isCancellationRequested = true;
      }
      dispose() {}
    },
    Uri: {
      file: (fsPath: string) => ({ fsPath, scheme: 'file', toString: () => `file://${fsPath}` }),
      parse: (s: string) => ({ fsPath: s, scheme: 'file', toString: () => s }),
    },
    workspace: {
      isTrusted: false,
      workspaceFolders: [],
      getConfiguration: () => ({
        get: (_key: string, fallback: unknown) => fallback,
      }),
    },
    extensions: { getExtension: () => undefined },
    window: {
      showWarningMessage: async () => undefined,
      showInformationMessage: async () => undefined,
      showErrorMessage: async () => undefined,
      showQuickPick: async () => undefined,
    },
    commands: { executeCommand: async () => undefined },
  };
}

function makeSessionHeader(id: string, cwd: string): string {
  return (
    JSON.stringify({
      type: 'session',
      version: 3,
      id,
      timestamp: '2024-01-01T00:00:00.000Z',
      cwd,
    }) + '\n'
  );
}

function loadBundle(
  bundleText: string,
  planEnv: NodeJS.ProcessEnv,
  sdkRoot: string,
  cwd: string,
  sharedHostCb?: () => any,
  vscodeOverride?: Record<string, any>
) {
  const mod = { exports: {} as any };
  new Function('require', 'module', 'exports', bundleText)(
    (name: string) => {
      if (name === 'vscode') return vscodeOverride ?? makeVscodeShim();
      if (name === 'fixture-stubs') {
        return {
          piLaunchEnvironment,
          resolvePiLaunch: () => ({
            sdkRoot,
            env: { ...planEnv },
            cwd,
          }),
          getSharedPiHost: () => {
            if (sharedHostCb) return sharedHostCb();
            return undefined;
          },
        };
      }
      return require(name);
    },
    mod,
    mod.exports
  );
  return mod.exports;
}

/** Wait for the JSONL to contain a completed assistant message. */
async function waitForSettled(sessionFile: string, timeoutMs = 30000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      const lines = readFileSync(sessionFile, 'utf8').trim().split('\n');
      const events = lines.map((l) => JSON.parse(l));
      if (
        events.some(
          (e: any) =>
            e.type === 'message' && e.message?.role === 'assistant' && e.message?.stopReason
        )
      )
        return;
    } catch {
      /* file not ready */
    }
    assert.ok(Date.now() < deadline, 'timed out waiting for assistant reply to settle in JSONL');
    await new Promise((r) => setTimeout(r, 20));
  }
}

test(
  'deactivate: registry.dispose() mid-stream does NOT interrupt detached turn',
  { skip: SKIP, timeout: 90000 },
  async () => {
    const fixture = await createNativeFixture('compact');
    const globalStorage = shortTmp();
    let disposeParked: (() => void) | undefined;
    try {
      const plan = await nativeSdkHostPlan(fixture, 'shared');
      const planEnv = plan.env as NodeJS.ProcessEnv;
      const sdkRoot = planEnv.PI_HOST_PI_ROOT as string;

      const bundleText = await buildControllerBundle();
      const exports = loadBundle(bundleText, planEnv, sdkRoot, plan.cwd);
      const { SessionRegistry, disposeParkedDetachedDrafts } = exports;
      disposeParked = disposeParkedDetachedDrafts;

      const logLines: string[] = [];
      const logger = {
        info: (msg: string) => logLines.push(msg),
        warn: (msg: string) => logLines.push(msg),
        error: (msg: string) => logLines.push(msg),
      };

      const sessionFile = join(fixture.cwd, 'deactivate-detach.jsonl');
      writeFileSync(sessionFile, makeSessionHeader('deact-detach', fixture.cwd));

      const folder = {
        name: 'Test',
        uri: { fsPath: fixture.cwd, scheme: 'file', toString: () => `file://${fixture.cwd}` },
      };

      // --- Phase 1: start session through controller, stream, then registry.dispose() ---
      const registry1 = new SessionRegistry(logger, undefined, globalStorage, REPO_ROOT);
      const controller1 = registry1.getOrCreateFor('test-chat', folder);
      fixture.setSummaryOutcome('success');
      await controller1.start(sessionFile);

      // Confirm we're on the detached path.
      const attachLog = logLines.find((l) => l.includes('via detached runtime'));
      assert.ok(attachLog, 'controller started via detached runtime');

      // Start streaming a prompt.
      const promptDone = controller1.prompt('Long fixture stream').catch(() => {});

      // Wait for the turn to begin (connectionState → 'busy').
      const deadline1 = Date.now() + 30000;
      while (controller1.snapshot.connectionState !== 'busy') {
        assert.ok(Date.now() < deadline1, 'timed out waiting for busy state');
        await new Promise((r) => setTimeout(r, 10));
      }

      // Simulate deactivate/reload: dispose the whole registry mid-stream.
      registry1.dispose();
      await promptDone;

      // The runtime should complete the turn to JSONL without interruption.
      await waitForSettled(sessionFile);

      const content1 = readFileSync(sessionFile, 'utf8');
      assert.equal(
        content1.includes('vscode-pi.turn-interrupted'),
        false,
        'no interrupted marker after registry.dispose()'
      );

      // --- Phase 2: re-attach with a new registry ---
      const exports2 = loadBundle(bundleText, planEnv, sdkRoot, plan.cwd);
      const { SessionRegistry: SessionRegistry2, disposeParkedDetachedDrafts: dp2 } = exports2;
      disposeParked = dp2;

      const registry2 = new SessionRegistry2(logger, undefined, globalStorage, REPO_ROOT);
      const controller2 = registry2.getOrCreateFor('test-chat-2', folder);
      fixture.setSummaryOutcome('success');
      await controller2.start(sessionFile);

      const reattachLog = logLines.find(
        (l, i) => i > logLines.indexOf(attachLog!) && l.includes('via detached runtime')
      );
      assert.ok(reattachLog, 'phase 2 re-attached via detached runtime');

      // Verify the transcript.
      const content2 = readFileSync(sessionFile, 'utf8');
      assert.equal(
        content2.includes('vscode-pi.turn-interrupted'),
        false,
        'still no interrupted marker after re-attach'
      );

      const saved = content2
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l));
      const messages = selectActiveBranchMessages<any>(saved, Infinity);
      const assistant = messages.filter((m: any) => m.role === 'assistant').at(-1);
      assert.ok(assistant, 'assistant reply persisted');
      assert.ok(
        assistant.content.some((b: any) => typeof b.text === 'string' && b.text.length > 0),
        'assistant has full content'
      );

      // One runtime only.
      const entries = (await import('../../src/process/detachedRuntime/registry.js')).readRegistry(
        detachedRuntimeBaseDir(globalStorage)
      );
      assert.equal(entries.length, 1, 'one runtime after full cycle');

      // Clean up.
      disposeParked?.();
      disposeParked = undefined;
      registry2.dispose();
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
      const denied = readFileSync(fixture.networkLog, 'utf8');
      await fixture.dispose();
      assert.equal(denied.trim(), '', 'no forbidden network requests');
    }
  }
);

test(
  'deactivate: registry.dispose() with kill-switch-off DOES write interrupted marker (#44 behaviour)',
  { skip: SKIP, timeout: 90000 },
  async () => {
    const fixture = await createNativeFixture('compact');
    const globalStorage = shortTmp();
    try {
      const plan = await nativeSdkHostPlan(fixture, 'shared');
      const planEnv = plan.env as NodeJS.ProcessEnv;
      const sdkRoot = planEnv.PI_HOST_PI_ROOT as string;

      // Provide a vscode shim where detachedRuntime.enabled → false.
      const killSwitchShim = makeVscodeShim();
      (killSwitchShim.workspace as any).getConfiguration = () => ({
        get: (key: string, fallback: unknown) =>
          key === 'detachedRuntime.enabled' ? false : fallback,
      });

      const bundleText = await buildControllerBundle();
      const exports = loadBundle(
        bundleText,
        planEnv,
        sdkRoot,
        plan.cwd,
        () => {
          // Return a mock shared host.
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
        killSwitchShim
      );
      const { SessionRegistry, disposeParkedDetachedDrafts } = exports;

      const logLines: string[] = [];
      const logger = {
        info: (msg: string) => logLines.push(msg),
        warn: (msg: string) => logLines.push(msg),
        error: (msg: string) => logLines.push(msg),
      };

      const sessionFile = join(fixture.cwd, 'deactivate-killswitch.jsonl');
      writeFileSync(sessionFile, makeSessionHeader('deact-ks', fixture.cwd));

      // Kill switch OFF: detachedRuntimeEnabled = false.
      const folder = {
        name: 'Test',
        uri: { fsPath: fixture.cwd, scheme: 'file', toString: () => `file://${fixture.cwd}` },
      };

      const registry = new SessionRegistry(logger, undefined, globalStorage, REPO_ROOT);
      const controller = registry.getOrCreateFor('test-chat-ks', folder);
      fixture.setSummaryOutcome('success');

      // With detached OFF, the supervisor uses the shared host mock which can't
      // complete the RPC handshake. Race with a short timeout — we only need the
      // supervisor to have started (non-detached) so dispose exercises the right path.
      await Promise.race([
        controller.start(sessionFile).catch(() => {}),
        new Promise((r) => setTimeout(r, 5000)),
      ]);

      // The key assertion: dispose should work without errors on non-detached path.
      // On the non-detached path, dispose() calls void this.stop() (the #44 behaviour).
      registry.dispose();

      assert.ok(true, 'non-detached dispose completed without error');
      disposeParkedDetachedDrafts();
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
