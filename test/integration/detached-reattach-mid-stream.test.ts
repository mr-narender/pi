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

// Integration tests for detached re-attach to a held session (PR #46 reload bug).
//
// The bug: after a window reload mid-stream, the restored chat used the session
// file path as the IPC channel key, but the host stored the session under its
// original channel key. The IPC attach falsely claimed 'attached' even when no
// session existed under the requested key, so reconcile got 'session not open'
// and the controller faulted after three instant retries.
//
// The fix: (1) the ring buffer's `since()` now returns `known: false` when the
// key has never been seen, so the IPC attach skips phantom sessions; (2) the
// host exposes a `resolveSessionKey` callback that maps session file paths to
// their original channel keys; (3) the attach response carries `resolvedKey`
// so the client uses the host's actual key for all I/O.
//
// Tests exercise the REAL SessionRegistry/SessionController → Supervisor chain
// through the REAL SDK host to verify: dispose mid-stream → re-attach with the
// SAME session file → controller reaches ready/busy → remaining deltas arrive →
// final transcript is correct. Also covers re-attach after the stream finished.

const SKIP = process.platform === 'win32';
const REPO_ROOT = resolve(__dirname, '../..');

function shortTmp(): string {
  return mkdtempSync('/tmp/pi-ds-ratt-');
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
        name: 'detached-reattach-stubs',
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
  'reattach mid-stream: dispose → new controller for same session file → reaches ready/busy, deltas arrive, correct transcript',
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

      const sessionFile = join(fixture.cwd, 'reattach-mid-stream.jsonl');
      writeFileSync(sessionFile, makeSessionHeader('reattach-mid', fixture.cwd));

      const folder = {
        name: 'Test',
        uri: { fsPath: fixture.cwd, scheme: 'file', toString: () => `file://${fixture.cwd}` },
      };

      // --- Phase 1: start, begin streaming, then dispose mid-stream ---
      const registry1 = new SessionRegistry(logger, undefined, globalStorage, REPO_ROOT);
      const controller1 = registry1.getOrCreateFor('test-ratt', folder);
      fixture.setSummaryOutcome('success');
      await controller1.start(sessionFile);

      const attachLog = logLines.find((l) => l.includes('via detached runtime'));
      assert.ok(attachLog, 'controller started via detached runtime');

      // Start a streaming prompt.
      const promptDone = controller1.prompt('Long fixture stream').catch(() => {});

      // Wait for 'busy' (turn started).
      const deadline1 = Date.now() + 30000;
      while (controller1.snapshot.connectionState !== 'busy') {
        assert.ok(Date.now() < deadline1, 'timed out waiting for busy state');
        await new Promise((r) => setTimeout(r, 10));
      }

      // Simulate window reload: dispose the entire registry mid-stream.
      registry1.dispose();
      await promptDone;

      // --- Phase 2: re-attach with a NEW registry while the runtime is still streaming ---
      // (The runtime continues the turn independently.)
      const exports2 = loadBundle(bundleText, planEnv, sdkRoot, plan.cwd);
      const { SessionRegistry: SessionRegistry2, disposeParkedDetachedDrafts: dp2 } = exports2;
      disposeParked = dp2;

      const registry2 = new SessionRegistry2(logger, undefined, globalStorage, REPO_ROOT);
      const controller2 = registry2.getOrCreateFor('test-ratt-2', folder);
      fixture.setSummaryOutcome('success');

      // The re-attach MUST NOT fault.
      await controller2.start(sessionFile);

      const snap = controller2.snapshot;
      assert.ok(
        snap.connectionState === 'ready' || snap.connectionState === 'busy',
        `controller2 reached ready/busy, got: ${snap.connectionState}`
      );

      // If the controller is busy (still streaming), wait for it to become ready.
      if (snap.connectionState === 'busy') {
        const deadline2 = Date.now() + 30000;
        while (controller2.snapshot.connectionState === 'busy') {
          assert.ok(Date.now() < deadline2, 'timed out waiting for ready after re-attach');
          await new Promise((r) => setTimeout(r, 50));
        }
        assert.equal(
          controller2.snapshot.connectionState,
          'ready',
          'controller settled to ready after turn completed'
        );
      }

      // Wait for the JSONL to settle (runtime writes the full reply).
      await waitForSettled(sessionFile);

      // --- Verify transcript ---
      const content = readFileSync(sessionFile, 'utf8');
      assert.equal(content.includes('vscode-pi.turn-interrupted'), false, 'no interrupted marker');

      const saved = content
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l));
      const messages = selectActiveBranchMessages<any>(saved, Infinity);
      const assistants = messages.filter((m: any) => m.role === 'assistant');
      assert.ok(assistants.length >= 1, 'at least one assistant reply');
      const lastAssistant = assistants.at(-1);
      assert.ok(lastAssistant, 'assistant reply persisted');
      assert.ok(
        lastAssistant.content.some((b: any) => typeof b.text === 'string' && b.text.length > 0),
        'assistant has full content'
      );
      assert.ok(lastAssistant.stopReason, 'assistant has stopReason');

      // One runtime only.
      const registryMod = await import('../../src/process/detachedRuntime/registry.js');
      const entries = registryMod.readRegistry(detachedRuntimeBaseDir(globalStorage));
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
  'reattach after stream finished: controller is ready and shows full reply',
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

      const sessionFile = join(fixture.cwd, 'reattach-after-done.jsonl');
      writeFileSync(sessionFile, makeSessionHeader('reattach-done', fixture.cwd));

      const folder = {
        name: 'Test',
        uri: { fsPath: fixture.cwd, scheme: 'file', toString: () => `file://${fixture.cwd}` },
      };

      // --- Phase 1: start and complete a prompt ---
      const registry1 = new SessionRegistry(logger, undefined, globalStorage, REPO_ROOT);
      const controller1 = registry1.getOrCreateFor('test-done', folder);
      fixture.setSummaryOutcome('success');
      await controller1.start(sessionFile);

      await controller1.prompt('Long fixture stream');

      // Wait for ready after the turn completes.
      const deadline1 = Date.now() + 30000;
      while (controller1.snapshot.connectionState !== 'ready') {
        assert.ok(Date.now() < deadline1, 'timed out waiting for ready after prompt');
        await new Promise((r) => setTimeout(r, 10));
      }

      // Simulate window reload.
      registry1.dispose();

      // --- Phase 2: re-attach after the stream is completely done ---
      const exports2 = loadBundle(bundleText, planEnv, sdkRoot, plan.cwd);
      const { SessionRegistry: SessionRegistry2, disposeParkedDetachedDrafts: dp2 } = exports2;
      disposeParked = dp2;

      const registry2 = new SessionRegistry2(logger, undefined, globalStorage, REPO_ROOT);
      const controller2 = registry2.getOrCreateFor('test-done-2', folder);
      fixture.setSummaryOutcome('success');

      await controller2.start(sessionFile);

      assert.equal(
        controller2.snapshot.connectionState,
        'ready',
        'controller2 is ready immediately (stream already finished)'
      );

      // Verify the transcript is complete.
      const content = readFileSync(sessionFile, 'utf8');
      assert.equal(content.includes('vscode-pi.turn-interrupted'), false, 'no interrupted marker');

      const saved = content
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
      assert.ok(assistant.stopReason, 'assistant has stopReason (stream was complete)');

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
