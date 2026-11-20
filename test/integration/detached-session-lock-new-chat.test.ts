import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { createNativeFixture, nativeSdkHostPlan } from '../helpers/nativeFixture';
import { piLaunchEnvironment } from '../../src/process/piLauncher';
import {
  detachedRuntimeBaseDir,
  stopBackgroundRuntimesAndWait,
} from '../../src/process/detachedRuntime/stopRuntimes';

// Session file lock for chats started as "(new)": the file is only known after
// the first reconcile. A second VS Code profile (separate runtime registry) must
// not open that file while the first runtime holds it.

const SKIP = process.platform === 'win32';
const REPO_ROOT = resolve(__dirname, '../..');

function shortTmp(): string {
  return mkdtempSync('/tmp/pi-dsl-');
}

/** Build a CJS bundle of PiProcessSupervisor with piLauncher and sharedPiHost mocked. */
async function buildSupervisorBundle() {
  const result = await build({
    stdin: {
      contents:
        "export { PiProcessSupervisor, disposeParkedDetachedDrafts } from './src/process/supervisor';",
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
): { PiProcessSupervisor: any; disposeParkedDetachedDrafts: () => void } {
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

test(
  'detached session lock: a new chat is locked once its file is known; another profile is refused until it closes',
  { skip: SKIP, timeout: 90000 },
  async () => {
    const fixture = await createNativeFixture('compact');
    const storage1 = shortTmp();
    const storage2 = shortTmp();
    let disposeParked: (() => void) | undefined;
    try {
      const plan = await nativeSdkHostPlan(fixture, 'shared');
      const planEnv = plan.env as NodeJS.ProcessEnv;
      const sdkRoot = planEnv.PI_HOST_PI_ROOT as string;
      const tracker = { sharedHostUsed: false };
      const bundleText = await buildSupervisorBundle();
      const stubs = makeFixtureStubs(sdkRoot, planEnv, plan.cwd, tracker);
      const { PiProcessSupervisor, disposeParkedDetachedDrafts } = loadBundle(bundleText, stubs);
      disposeParked = disposeParkedDetachedDrafts;
      const logLines: string[] = [];
      const logger = makeLogger(logLines);
      const settings = makeSettings();
      const folder = { name: 'Test', uri: { fsPath: fixture.cwd } };

      // Window 1: a brand-new chat (no session file yet).
      const sup1 = new PiProcessSupervisor(folder, logger, settings, storage1, REPO_ROOT);
      const client1 = await sup1.start(undefined, { offline: true, noExtensions: true });
      const sessionFile = (await client1.getState())?.sessionFile as string;
      assert.ok(sessionFile, 'new chat reports its session file');
      assert.equal(existsSync(`${sessionFile}.pilock`), false, 'no lock before the file is noted');

      sup1.noteSessionFile(sessionFile);
      assert.ok(existsSync(`${sessionFile}.pilock`), 'lock written once the file is known');
      const lock = JSON.parse(readFileSync(`${sessionFile}.pilock`, 'utf8'));
      assert.equal(typeof lock.runtimeId, 'string');

      // Window 2: separate profile → separate registry → its own runtime.
      const sup2 = new PiProcessSupervisor(folder, logger, settings, storage2, REPO_ROOT);
      await assert.rejects(
        sup2.start(sessionFile, { offline: true, noExtensions: true }),
        (error: any) => error?.code === 'SDK_SESSION_LOCKED',
        'second profile is refused while the first runtime holds the chat'
      );
      assert.equal(tracker.sharedHostUsed, false, 'no fallback to the shared host');

      // Closing the chat in window 1 releases the lock; window 2 can then open it.
      await sup1.stop();
      assert.equal(existsSync(`${sessionFile}.pilock`), false, 'lock released on close');
      const client2 = await sup2.start(sessionFile, { offline: true, noExtensions: true });
      assert.ok(client2, 'second profile opens the chat after release');
      await sup2.stop();
    } finally {
      try {
        disposeParked?.();
      } catch {
        /* ignore */
      }
      for (const storage of [storage1, storage2]) {
        try {
          await stopBackgroundRuntimesAndWait(detachedRuntimeBaseDir(storage));
        } catch {
          /* ignore */
        }
      }
      const denied = readFileSync(fixture.networkLog, 'utf8');
      await fixture.dispose();
      assert.equal(denied.trim(), '', 'no forbidden network requests');
    }
  }
);
