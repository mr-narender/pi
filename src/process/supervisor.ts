import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join as pathJoin } from 'node:path';
import { piLaunchEnvironment, resolvePiLaunch, type PiLaunchPlan } from './piLauncher';
import {
  spawnExternalPi,
  spawnSubprocessPi,
  spawnWorkerPi,
  type PiProcessHandle,
} from './piProcess';
import { getSharedPiHost } from './sharedPiHost';
import { spawnDetachedRuntime, type DetachedRuntime } from './detachedRuntime/detachedHost';
import { DetachedIpcConnection } from './detachedRuntime/ipcClient';
import { acquireLock, findAllBySdkRoot, findByEnv, readRegistry } from './detachedRuntime/registry';
import { readTokenFile } from './detachedRuntime/token';
import {
  readSessionLock,
  writeSessionLock,
  releaseSessionLock,
} from './detachedRuntime/sessionLock';
import { detachedRuntimeBaseDir } from './detachedRuntime/stopRuntimes';

// On Windows the npm-installed `pi` is a `pi.cmd` shim, which Node's spawn cannot
// execute directly (ENOENT / EINVAL). A shell is required there; on POSIX we keep
// shell:false so arguments are passed verbatim without shell interpretation.
const SPAWN_WITH_SHELL = process.platform === 'win32';
import { EventEmitter } from 'node:events';
import * as vscode from 'vscode';
import { DiagnosticsLogger } from '../diagnostics/logger';
import { getSettings, validateAdditionalArgs } from '../config/settings';
import type { PiRpcSettings } from '../config/settings';
import { RpcClient } from '../rpc/client';
import { RpcTransport } from '../rpc/transport';
import { checkPiVersion } from './version';
import { getIdeExtensionPath } from '../ide/query';
import { getApprovalGateExtensionPath } from '../review/approvalGate';

// ── Parked detached drafts ───────────────────────────────────────────────
// A parked draft is a session opened on the detached runtime (no session file)
// for a given (cwd, envKey). The next default New Chat for that folder adopts
// it instantly, mirroring sharedPiHost's adoption rules. Parked drafts are
// never persisted and must not keep the runtime alive: they do not count as
// active turns. They are closed on window deactivate via disposeParkedDrafts.

interface ParkedDetachedDraft {
  handle: PiProcessHandle;
  conn: DetachedIpcConnection;
  cwd: string;
  sdkRoot: string;
  envKey: string;
  args: string[];
  channelKey: string;
}

/** Map key: `${cwd}\0${envKey}` */
const parkedDetachedDrafts = new Map<string, ParkedDetachedDraft>();
const parkedDraftTimers = new Map<string, ReturnType<typeof setTimeout>>();

function parkedDraftKey(cwd: string, envKey: string): string {
  return `${cwd}\0${envKey}`;
}

/** Close all parked detached drafts (window deactivate / extension dispose). */
export function disposeParkedDetachedDrafts(): void {
  for (const timer of parkedDraftTimers.values()) clearTimeout(timer);
  parkedDraftTimers.clear();
  for (const draft of parkedDetachedDrafts.values()) {
    void draft.handle.stop();
    draft.conn.dispose();
  }
  parkedDetachedDrafts.clear();
}

/**
 * Single source of truth for the identity of a detached runtime launch.
 * Uses resolvePiLaunch (which adds PI_MANAGED_INSTALL_ROOT etc.) so both
 * warmDetachedRuntime and startDetached produce the same envKey.
 */
export function resolveDetachedLaunchIdentity(
  settings: import('../config/settings').PiRpcSettings,
  cwd?: string
): { sdkRoot: string | undefined; env: NodeJS.ProcessEnv; envKey: string } {
  const launch = resolvePiLaunch(settings, piLaunchEnvironment(settings), cwd);
  return {
    sdkRoot: launch.sdkRoot,
    env: launch.env as NodeJS.ProcessEnv,
    envKey: PiProcessSupervisor.computeEnvKey(launch.env as NodeJS.ProcessEnv),
  };
}

/**
 * Pre-spawn (or verify) the detached runtime for the sidebar warmup.
 * Folder-neutral: no session, no project resources. The runtime will be
 * ready for the first New Chat to open a session instantly.
 */
export async function warmDetachedRuntime(opts: {
  sdkRoot: string;
  env: NodeJS.ProcessEnv;
  globalStorageFsPath: string;
  extensionPath: string;
  idleMinutes: number;
  logger: { info(msg: string): void; warn(msg: string): void };
}): Promise<void> {
  const baseDir = detachedRuntimeBaseDir(opts.globalStorageFsPath);
  const envKey = PiProcessSupervisor.computeEnvKey(opts.env);

  const release = acquireLock(baseDir);
  try {
    // --- Duplicate identity awareness (safe: never signal from warmup) ---
    // If multiple live runtimes share the same identity, log but do NOT
    // SIGTERM them — a duplicate may hold active sessions or an in-flight
    // streaming turn.  Duplicates converge naturally: findByEnv prefers the
    // newest-healthy runtime so new chats land there, and the idle rules
    // (no attached client + no active turn → exit after idleMinutes) will
    // retire the other.
    const allEntries = readRegistry(baseDir);
    const byIdentity = new Map<string, typeof allEntries>();
    for (const e of allEntries) {
      const key = `${e.sdkRoot}\0${e.envKey}`;
      const list = byIdentity.get(key) ?? [];
      list.push(e);
      byIdentity.set(key, list);
    }
    for (const [identity, group] of byIdentity) {
      if (group.length > 1) {
        opts.logger.info(
          `Duplicate identity detected (${group.length} runtimes for ${identity}); ` +
            `idle rules will retire extras — no signal sent`
        );
      }
    }

    const existing = findByEnv(baseDir, opts.sdkRoot, envKey);
    if (existing) {
      // Runtime already alive — just verify via token read.
      try {
        readTokenFile(existing.tokenFile);
        opts.logger.info('Detached runtime already warm for sidebar');
        return;
      } catch {
        // Stale entry — spawn below.
      }
    }
    const hostScript = pathJoin(opts.extensionPath, 'host', 'pi-multi-host.mjs');
    if (!existsSync(hostScript)) {
      opts.logger.warn('Detached runtime host script not found; skipping sidebar warmup');
      return;
    }
    await spawnDetachedRuntime({
      hostScript,
      sdkRoot: opts.sdkRoot,
      envKey,
      env: { ...opts.env },
      runtimeBaseDir: baseDir,
      idleMs: opts.idleMinutes * 60 * 1000,
    });
    opts.logger.info('Detached runtime pre-spawned for sidebar warmup');
  } finally {
    release();
  }
}

export interface SupervisorEvents {
  exit: [number | null, NodeJS.Signals | null];
}

class TypedEmitter extends EventEmitter {
  public override on<K extends keyof SupervisorEvents>(
    eventName: K,
    listener: (...args: SupervisorEvents[K]) => void
  ): this {
    return super.on(eventName, listener);
  }

  public override emit<K extends keyof SupervisorEvents>(
    eventName: K,
    ...args: SupervisorEvents[K]
  ): boolean {
    return super.emit(eventName, ...args);
  }
}

export class PiProcessSupervisor extends TypedEmitter implements vscode.Disposable {
  private piProcess: PiProcessHandle | undefined;
  private transport: RpcTransport | undefined;
  private client: RpcClient | undefined;
  private generation = 0;
  private startEpoch = 0;
  /** Active detached IPC connection (non-null when using the detached runtime path). */
  private detachedConnection: DetachedIpcConnection | undefined;
  /** True when this supervisor is using a detached runtime (not the shared host). */
  private usingDetached = false;
  /** Session file path for session lock release on stop. */
  private detachedSessionFile: string | undefined;

  public constructor(
    private readonly folder: vscode.WorkspaceFolder,
    private readonly logger: DiagnosticsLogger,
    private readonly settingsOverride?: PiRpcSettings,
    private readonly globalStorageFsPath?: string,
    private readonly extensionPath?: string
  ) {
    super();
  }

  private get settings(): PiRpcSettings {
    return this.settingsOverride ?? getSettings();
  }

  public get currentClient(): RpcClient | undefined {
    return this.client;
  }

  public get sdkRoot(): string | undefined {
    return this.piProcess?.sdkRoot;
  }

  public get currentGeneration(): number {
    return this.generation;
  }

  public async start(
    existingSessionPath?: string,
    options?: { noExtensions?: boolean; offline?: boolean; onClient?: (client: RpcClient) => void }
  ): Promise<RpcClient> {
    if (this.client) {
      options?.onClient?.(this.client);
      return this.client;
    }
    const startEpoch = ++this.startEpoch;
    const cancelled = () =>
      Object.assign(new Error('Pi startup was cancelled'), { code: 'SDK_STARTUP_CANCELLED' });
    validateAdditionalArgs(this.settings.additionalArgs);
    const offline = options?.offline ?? this.settings.offline;
    const args = this.buildArgs(existingSessionPath, {
      noExtensions: options?.noExtensions,
      offline,
    });
    const launch = resolvePiLaunch(
      this.settings,
      piLaunchEnvironment(this.settings, offline),
      this.folder.uri.fsPath
    );
    const { env, cwd } = launch;
    // --- Detached runtime path (default ON, kill switch via setting) ---
    // Spawn or re-attach to a detached runtime that outlives the extension host.
    // Falls back to the shared host on any failure.
    if (
      this.settings.detachedRuntimeEnabled &&
      launch.sdkRoot &&
      !!this.settings.sharedRuntime && // dedicated sessions use the existing path
      this.globalStorageFsPath
    ) {
      try {
        const attached = await this.startDetached(
          launch.sdkRoot,
          env,
          cwd,
          args,
          existingSessionPath,
          startEpoch,
          options
        );
        if (attached) return attached;
      } catch (error) {
        if (startEpoch !== this.startEpoch) throw cancelled();
        // Busy-elsewhere and session-locked are user-visible states, not
        // transient failures — do NOT fall back to the shared host (that would
        // open a second controller on the same session file).
        if (
          error instanceof Error &&
          'code' in error &&
          ['SDK_SESSION_BUSY_ELSEWHERE', 'SDK_SESSION_LOCKED'].includes(
            (error as { code: string }).code
          )
        )
          throw error;
        this.logger.warn(
          `Detached runtime unavailable (${error instanceof Error ? error.message : String(error)}); falling back to shared host`
        );
      }
    }
    // Select the correct SDK backend BEFORE creating the first session.
    const sharedHost = getSharedPiHost();
    if (sharedHost && launch.sdkRoot) {
      let attached: RpcClient | undefined;
      const backendLabel = this.settings.sharedRuntime
        ? 'shared SDK host'
        : 'dedicated SDK OS process';
      try {
        this.generation += 1;
        const handle = await sharedHost.openSession(
          {
            cwd,
            sdkRoot: launch.sdkRoot,
            sessionFile: existingSessionPath,
            args,
            env,
            dedicated: !this.settings.sharedRuntime,
          },
          undefined,
          (openingHandle) => {
            if (startEpoch !== this.startEpoch) throw cancelled();
            attached = this.attachClient(openingHandle, backendLabel);
            options?.onClient?.(attached);
          }
        );
        if (startEpoch !== this.startEpoch) throw cancelled();
        if (this.settings.sharedRuntime) {
          // Capture the same trust, IDE extension, offline and user arguments as
          // the next default chat; a resumed file is never part of a parked draft.
          sharedHost.warmPool(cwd, {
            cwd,
            sdkRoot: launch.sdkRoot,
            env,
            args: this.buildArgs(undefined, { offline }),
          });
        }
        this.logger.info(
          `Starting Pi for ${this.folder.name} (generation=${this.generation}) via ${backendLabel} ` +
            `[cwd=${this.folder.uri.fsPath}, session=${existingSessionPath ?? '(new)'}]`
        );
        if (!attached) {
          attached = this.attachClient(handle, backendLabel);
          options?.onClient?.(attached);
        }
        return attached;
      } catch (error) {
        if (startEpoch !== this.startEpoch) throw cancelled();
        if (attached && this.client === attached) await this.stopClient();
        if (
          error instanceof Error &&
          'code' in error &&
          error.code === 'SDK_STARTUP_MODEL_AMBIGUOUS'
        )
          throw error;
        this.logger.warn(
          `Shared Pi host unavailable (${error instanceof Error ? error.message : String(error)}); ` +
            `falling back to a per-chat process`
        );
      }
    }
    this.generation += 1;
    // The version probe spawns `pi --version` (up to ~10s under startup load).
    // Our OWN installs (bundled/managed cli.js) have a known-good version —
    // probe only external binaries the user pointed us at.
    if (!launch.usingBundled) {
      await this.assertVersion(launch);
    }
    if (!launch.sdkRoot) {
      this.logger.info(
        'Selected executable has no compatible SDK root (>=1.3.0 <2.0.0); using stock pi --mode rpc fallback.'
      );
    }
    const useShell = launch.usingBundled ? false : SPAWN_WITH_SHELL;
    this.logger.info(
      `Starting Pi for ${this.folder.name} (generation=${this.generation}) via ${launch.label} ` +
        `[mode=${launch.mode}, args=${args.join(' ')}, cwd=${cwd}]`
    );
    const piProcess =
      launch.mode === 'worker' && launch.cliPath
        ? spawnWorkerPi({ cliPath: launch.cliPath, args, cwd, env, sdkRoot: launch.sdkRoot })
        : spawnSubprocessPi({
            command: launch.command,
            args: [...launch.prefixArgs, ...args],
            cwd,
            env,
            useShell,
            sdkRoot: launch.sdkRoot,
          });
    if (startEpoch !== this.startEpoch) {
      await piProcess.stop();
      throw cancelled();
    }
    const client = this.attachClient(piProcess, launch.label);
    options?.onClient?.(client);
    return client;
  }

  // Wire a spawned process OR a shared-host session handle into transport+client.
  // Both paths are identical from here down — the handle just exposes stdio.
  private attachClient(piProcess: PiProcessHandle, label: string): RpcClient {
    this.piProcess = piProcess;
    piProcess.onError((error) => {
      this.logger.error(`Failed to launch Pi via ${label}. ${this.spawnHint(error)}`, error);
      this.transport?.disconnect(error instanceof Error ? error : new Error(String(error)));
    });
    const transport = new RpcTransport(piProcess.stdin, piProcess.stdout, piProcess.stderr, {
      maxRecordBytes: this.settings.maxRecordBytes,
      // The residual buffer only ever holds one partial record, so it needs at
      // least maxRecordBytes; give generous headroom so resuming a large session
      // (a big stdout replay burst) never trips the limit.
      maxBufferBytes: Math.max(this.settings.maxRecordBytes * 2, 16 * 1024 * 1024),
      maxPendingRequests: this.settings.maxPendingRequests,
      maxQueuedWrites: this.settings.maxQueuedWrites,
    });
    transport.on('stderr', (text) => this.logger.warn(text));
    transport.on('protocolFault', (error) => this.logger.error(`Protocol fault: ${error.message}`));
    transport.on('disconnected', (error) =>
      this.logger.warn(`Transport disconnected: ${error.message}`)
    );
    piProcess.onExit((code, signal) => {
      if (this.piProcess !== piProcess) return;
      this.logger.warn(`Pi exited code=${String(code)} signal=${String(signal)}`);
      this.transport?.disconnect(
        new Error(`Pi exited code=${String(code)} signal=${String(signal)}`)
      );
      this.transport = undefined;
      this.client = undefined;
      this.piProcess = undefined;
      this.emit('exit', code, signal as NodeJS.Signals | null);
    });
    this.transport = transport;
    this.client = new RpcClient(this.generation, transport, {
      shortTimeoutMs: this.settings.responseTimeoutMs,
      longTimeoutMs: this.settings.longRunningTimeoutMs,
    });
    return this.client;
  }

  public async stop(): Promise<void> {
    this.startEpoch++;
    await this.stopClient();
  }

  private async stopClient(): Promise<void> {
    const piProcess = this.piProcess;
    const detachedConn = this.detachedConnection;
    const sessionFile = this.detachedSessionFile;
    this.transport = undefined;
    this.client = undefined;
    this.piProcess = undefined;
    this.detachedConnection = undefined;
    this.detachedSessionFile = undefined;
    // Release the session file lock when explicitly closing.
    if (sessionFile) releaseSessionLock(sessionFile);
    if (!piProcess) {
      return;
    }
    // For detached sessions: piProcess.stop() sends the close command to the
    // runtime (telling it to dispose the session). This is the "user explicitly
    // closes the chat" path.
    await piProcess.stop();
    // Disconnect the IPC socket after the close command has been sent.
    if (detachedConn) {
      detachedConn.dispose();
    }
  }

  /**
   * Dispose without stopping: for detached runtimes, disconnect the IPC socket
   * but do NOT tell the runtime to close the session. The runtime keeps any
   * in-flight turns running. For non-detached, delegates to stop().
   */
  public dispose(): void {
    if (this.usingDetached && this.detachedConnection) {
      // Extension deactivating: disconnect only, never stop the runtime.
      this.startEpoch++;
      const conn = this.detachedConnection;
      this.transport?.disconnect(new Error('Extension deactivating'));
      this.transport = undefined;
      this.client = undefined;
      this.piProcess = undefined;
      this.detachedConnection = undefined;
      conn.dispose();
    } else {
      void this.stop();
    }
  }

  /** Stable hash of the process environment for one-per-(sdkRoot,envKey) dedup. */
  public static computeEnvKey(env: NodeJS.ProcessEnv): string {
    const entries = Object.keys(env)
      .sort()
      .filter((key) => env[key] !== undefined)
      .map((key) => [key, env[key]]);
    return createHash('sha256').update(JSON.stringify(entries)).digest('hex');
  }

  /**
   * Try to start via the detached runtime path: find or spawn a detached runtime
   * for (sdkRoot, envKey), connect via IPC, and either open a new session or
   * re-attach to an existing one. Returns the RpcClient on success, or undefined
   * to signal the caller should fall through to the shared host.
   */
  private async startDetached(
    sdkRoot: string,
    env: NodeJS.ProcessEnv,
    cwd: string,
    args: string[],
    existingSessionPath: string | undefined,
    startEpoch: number,
    options?: { noExtensions?: boolean; offline?: boolean; onClient?: (client: RpcClient) => void }
  ): Promise<RpcClient | undefined> {
    const baseDir = detachedRuntimeBaseDir(this.globalStorageFsPath!);
    const envKey = PiProcessSupervisor.computeEnvKey(env);
    const cancelled = () =>
      Object.assign(new Error('Pi startup was cancelled'), { code: 'SDK_STARTUP_CANCELLED' });

    // --- Parked draft adoption (default New Chat only) ---
    // Mirror sharedPiHost: synchronous reservation, stale replacement on mismatch,
    // never for resume or dedicated.
    if (!existingSessionPath) {
      const draftKey = parkedDraftKey(cwd, envKey);
      const draft = parkedDetachedDrafts.get(draftKey);
      if (draft) {
        // Reserve synchronously.
        parkedDetachedDrafts.delete(draftKey);
        const argsMatch =
          JSON.stringify(args) === JSON.stringify(draft.args) && draft.sdkRoot === sdkRoot;
        if (argsMatch) {
          this.generation += 1;
          this.detachedConnection = draft.conn;
          this.usingDetached = true;
          const client = this.attachClient(draft.handle, 'detached runtime');
          options?.onClient?.(client);
          this.logger.info(
            `Adopted parked detached draft for ${this.folder.name} (generation=${this.generation})`
          );
          // Replenish.
          this.scheduleDetachedPrewarm(sdkRoot, env, envKey, cwd, args);
          return client;
        }
        // Stale: launch identity changed.
        this.logger.info('Replacing stale parked detached draft (launch identity changed)');
        void draft.handle.stop();
        draft.conn.dispose();
      }
    }

    const channelKey =
      existingSessionPath ?? `new-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    // --- Session-holder lookup (robust re-attach across envKey changes) ---
    // When resuming an existing session, check ALL live runtimes with the same
    // sdkRoot to find the one that holds this session. This guarantees an
    // in-flight turn is never orphaned by an identity change (e.g. after a
    // settings change between reloads that adds PI_MANAGED_INSTALL_ROOT).
    if (existingSessionPath) {
      const holder = await this.findSessionHolder(
        baseDir,
        sdkRoot,
        channelKey,
        startEpoch,
        cancelled
      );
      if (holder) {
        if (holder.entry.envKey !== envKey) {
          this.logger.info(
            `Re-attaching to session holder with different envKey ` +
              `(holder=${holder.entry.envKey.slice(0, 8)}, current=${envKey.slice(0, 8)})`
          );
        }
        this.generation += 1;
        this.detachedConnection = holder.conn;
        this.usingDetached = true;
        this.detachedSessionFile = existingSessionPath;
        const client = this.attachClient(holder.handle, 'detached runtime');
        options?.onClient?.(client);
        this.logger.info(
          `Starting Pi for ${this.folder.name} (generation=${this.generation}) via detached runtime ` +
            `[cwd=${cwd}, session=${existingSessionPath}, reattach=session-holder]`
        );
        return client;
      }
    }

    // Hold the registry lock across find → spawn → add to prevent two windows
    // from spawning duplicate runtimes for the same (sdkRoot, envKey).
    let entry: import('./detachedRuntime/registry').RuntimeEntry | undefined;
    let token: string | undefined;
    let runtime: DetachedRuntime | undefined;

    const release = acquireLock(baseDir);
    try {
      entry = findByEnv(baseDir, sdkRoot, envKey);

      if (entry) {
        // Try to read the token for the existing runtime.
        try {
          token = readTokenFile(entry.tokenFile);
        } catch {
          // Token file gone: stale entry; will spawn a new runtime.
          entry = undefined;
        }
      }

      if (!entry) {
        // No live runtime: spawn a new detached one.
        if (!this.extensionPath) {
          throw new Error('extensionPath is required to spawn a detached runtime');
        }
        const hostScript = pathJoin(this.extensionPath, 'host', 'pi-multi-host.mjs');
        if (!existsSync(hostScript)) {
          this.logger.warn(
            `Detached runtime host script not found at ${hostScript}; falling back to shared host`
          );
          return undefined;
        }
        runtime = await spawnDetachedRuntime({
          hostScript,
          sdkRoot,
          envKey,
          env: { ...env },
          cwd,
          runtimeBaseDir: baseDir,
          idleMs: this.settings.detachedRuntimeIdleMinutes * 60 * 1000,
        });
        entry = runtime.entry;
        token = runtime.token;
      }
    } finally {
      release();
    }

    if (startEpoch !== this.startEpoch) throw cancelled();

    // Connect to the runtime. When re-using an existing runtime (not freshly
    // spawned), include the target session key in acks so the server can report
    // busy-elsewhere upfront without waiting for the open handshake.
    const conn = new DetachedIpcConnection(sdkRoot);
    const acks: Record<string, number> = {};
    if (existingSessionPath && !runtime) acks[channelKey] = 0;
    const attachResult = await conn.connect(entry.endpoint, token!, acks);
    if (!attachResult.ok) {
      conn.dispose();
      throw new Error(`Detached runtime auth failed: ${attachResult.error ?? 'unknown'}`);
    }

    if (startEpoch !== this.startEpoch) {
      conn.dispose();
      throw cancelled();
    }

    // Determine whether the runtime already holds this session (re-attach)
    // or we need to open a new one.
    let handle: PiProcessHandle;
    const sessionState = existingSessionPath ? attachResult.sessions[channelKey] : undefined;
    if (sessionState?.state === 'busy-elsewhere') {
      // Another VS Code window already controls this session.
      conn.dispose();
      throw Object.assign(new Error('This chat is open in another VS Code window'), {
        code: 'SDK_SESSION_BUSY_ELSEWHERE',
      });
    }
    if (sessionState?.state === 'attached' || sessionState?.state === 'resync') {
      // Re-attach: the runtime already holds this session.
      handle = conn.attachSession(channelKey);
    } else {
      // Before opening, check the session file lock to prevent two runtimes
      // from opening the same session file concurrently.
      if (existingSessionPath) {
        const lock = readSessionLock(existingSessionPath);
        if (lock && lock.runtimeId !== entry!.id) {
          conn.dispose();
          throw Object.assign(
            new Error(
              `Session file is held by another runtime (${lock.runtimeId}, pid ${lock.pid})`
            ),
            { code: 'SDK_SESSION_LOCKED' }
          );
        }
      }
      // Open a new session on the detached runtime.
      try {
        handle = await conn.openSession(channelKey, {
          cwd,
          sessionFile: existingSessionPath,
          args,
        });
        // Write the session lock after successful open.
        if (existingSessionPath) {
          writeSessionLock(existingSessionPath, {
            runtimeId: entry!.id,
            pid: entry!.pid,
            timestamp: Date.now(),
          });
        }
      } catch (openError) {
        // The runtime refuses open when another client controls this session.
        if (openError instanceof Error && openError.message === 'SDK_SESSION_BUSY_ELSEWHERE') {
          conn.dispose();
          throw Object.assign(new Error('This chat is open in another VS Code window'), {
            code: 'SDK_SESSION_BUSY_ELSEWHERE',
          });
        }
        throw openError;
      }
    }

    if (startEpoch !== this.startEpoch) {
      conn.dispose();
      throw cancelled();
    }

    this.generation += 1;
    this.detachedConnection = conn;
    this.usingDetached = true;
    this.detachedSessionFile = existingSessionPath;
    const client = this.attachClient(handle, 'detached runtime');
    options?.onClient?.(client);
    this.logger.info(
      `Starting Pi for ${this.folder.name} (generation=${this.generation}) via detached runtime ` +
        `[cwd=${cwd}, session=${existingSessionPath ?? '(new)'}]`
    );

    // Schedule a parked draft for the next default New Chat (replenish).
    if (!existingSessionPath) {
      this.scheduleDetachedPrewarm(sdkRoot, env, envKey, cwd, args);
    }

    return client;
  }

  /**
   * Scan all live runtimes with the same sdkRoot and probe each for the target
   * session. Returns the first holder found (conn + handle ready for re-attach),
   * or undefined if no runtime holds the session.
   */
  private async findSessionHolder(
    baseDir: string,
    sdkRoot: string,
    channelKey: string,
    startEpoch: number,
    cancelled: () => Error
  ): Promise<
    | {
        entry: import('./detachedRuntime/registry').RuntimeEntry;
        conn: DetachedIpcConnection;
        handle: PiProcessHandle;
      }
    | undefined
  > {
    const candidates = findAllBySdkRoot(baseDir, sdkRoot);
    for (const candidate of candidates) {
      if (startEpoch !== this.startEpoch) throw cancelled();
      let token: string;
      try {
        token = readTokenFile(candidate.tokenFile);
      } catch {
        continue; // stale entry
      }
      const probe = new DetachedIpcConnection(sdkRoot);
      try {
        const acks: Record<string, number> = { [channelKey]: 0 };
        const result = await probe.connect(candidate.endpoint, token, acks, 5_000);
        if (!result.ok) {
          probe.dispose();
          continue;
        }
        const state = result.sessions[channelKey];
        if (state?.state === 'attached' || state?.state === 'resync') {
          // This runtime holds the session — re-attach.
          const handle = probe.attachSession(channelKey);
          return { entry: candidate, conn: probe, handle };
        }
        if (state?.state === 'busy-elsewhere') {
          probe.dispose();
          throw Object.assign(new Error('This chat is open in another VS Code window'), {
            code: 'SDK_SESSION_BUSY_ELSEWHERE',
          });
        }
        // Session not held by this runtime.
        probe.dispose();
      } catch (error) {
        probe.dispose();
        // Re-throw busy-elsewhere; swallow other probe errors.
        if (
          error instanceof Error &&
          'code' in error &&
          (error as { code: string }).code === 'SDK_SESSION_BUSY_ELSEWHERE'
        )
          throw error;
      }
    }
    return undefined;
  }

  /**
   * Schedule opening a parked draft session on the detached runtime for the
   * given folder so the next default New Chat adopts it instantly.
   */
  private scheduleDetachedPrewarm(
    sdkRoot: string,
    env: NodeJS.ProcessEnv,
    envKey: string,
    cwd: string,
    args: string[]
  ): void {
    const draftKey = parkedDraftKey(cwd, envKey);
    if (parkedDetachedDrafts.has(draftKey) || parkedDraftTimers.has(draftKey)) return;
    const timer = setTimeout(() => {
      parkedDraftTimers.delete(draftKey);
      void this.prewarmDetachedDraft(sdkRoot, env, envKey, cwd, args);
    }, 3000);
    timer.unref?.();
    parkedDraftTimers.set(draftKey, timer);
  }

  private async prewarmDetachedDraft(
    sdkRoot: string,
    env: NodeJS.ProcessEnv,
    envKey: string,
    cwd: string,
    args: string[]
  ): Promise<void> {
    const draftKey = parkedDraftKey(cwd, envKey);
    if (parkedDetachedDrafts.has(draftKey)) return;
    try {
      const baseDir = detachedRuntimeBaseDir(this.globalStorageFsPath!);
      const entry = findByEnv(baseDir, sdkRoot, envKey);
      if (!entry) return; // Runtime gone.
      let token: string;
      try {
        token = readTokenFile(entry.tokenFile);
      } catch {
        return; // Stale.
      }
      const conn = new DetachedIpcConnection(sdkRoot);
      const attachResult = await conn.connect(entry.endpoint, token);
      if (!attachResult.ok) {
        conn.dispose();
        return;
      }
      const channelKey = `draft-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      // Build default new-chat args (no session file).
      const handle = await conn.openSession(channelKey, { cwd, args });
      parkedDetachedDrafts.set(draftKey, {
        handle,
        conn,
        cwd,
        sdkRoot,
        envKey,
        args,
        channelKey,
      });
      this.logger.info(`Parked detached draft for ${cwd}`);
    } catch (error) {
      this.logger.warn(
        `Detached draft prewarm failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /** Human-readable remediation for a spawn failure. */
  private spawnHint(error: unknown): string {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT') {
      return (
        `Pi CLI was not found. Install it with 'npm install -g @earendil-works/pi-coding-agent', ` +
        `or set the 'Pi: Executable Path' setting to the full path of the pi binary.`
      );
    }
    if (code === 'EACCES') {
      return `Pi CLI is not executable (permission denied). Check the 'Pi: Executable Path' setting.`;
    }
    return `See the Pi output channel for details.`;
  }

  private probeVersion(
    launch: PiLaunchPlan
  ): Promise<{ code: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const spawnVersion = launch.usingBundled || !SPAWN_WITH_SHELL ? spawn : spawnExternalPi;
      const child = spawnVersion(launch.command, [...launch.prefixArgs, '--version'], {
        cwd: launch.cwd,
        shell: false,
        windowsHide: true,
        env: { ...launch.env, PI_OFFLINE: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
      // A spawn error (ENOENT/EACCES) means the binary isn't runnable at all
      // — that IS fatal; surface it with remediation.
      child.once('error', reject);
      child.once('exit', (code) => resolve({ code, stdout, stderr }));
    });
  }

  private async assertVersion(launch: PiLaunchPlan): Promise<void> {
    // The version probe is a COURTESY check, not a hard gate. It must not block
    // startup just because `pi --version` behaves unusually (e.g. writes to
    // stderr, exits non-zero, or is wrapped by a .cmd shim on Windows). Only two
    // things should stop us: the binary genuinely not existing, or a version we
    // can parse that is clearly older than the minimum.
    let probe: { code: number | null; stdout: string; stderr: string };
    try {
      probe = await this.probeVersion(launch);
    } catch (error) {
      throw new Error(`Could not run '${launch.command} --version'. ${this.spawnHint(error)}`);
    }

    const output = `${probe.stdout}\n${probe.stderr}`.trim();
    if (probe.code !== 0) {
      this.logger.warn(
        `'${launch.command} --version' exited with code ${String(probe.code)}; ` +
          `proceeding anyway. Output: ${output || '(none)'}`
      );
      return;
    }
    const check = checkPiVersion(output);
    if (!check.ok) {
      throw new Error(check.reason);
    }
    if (check.note) {
      this.logger.warn(check.note);
    } else {
      this.logger.info(`Pi version detected: ${check.version ?? 'unknown'}`);
    }
  }

  private buildArgs(
    existingSessionPath?: string,
    options?: { noExtensions?: boolean; offline?: boolean }
  ): string[] {
    const args = ['--mode', 'rpc'];
    if (options?.offline ?? this.settings.offline) {
      args.push('--offline');
    }
    if (!vscode.workspace.isTrusted || !this.settings.allowApproveInTrustedWorkspace) {
      args.push('--no-approve');
    }
    if (options?.noExtensions) {
      // Recovery path: a crashing Pi extension can make session load exit code=1.
      args.push('--no-extensions');
    }
    const ideExtension = getIdeExtensionPath();
    const excludesExtensions = this.settings.additionalArgs.some(
      (arg) => arg === '--no-extensions' || arg === '-ne'
    );
    if (
      vscode.workspace.isTrusted &&
      !options?.noExtensions &&
      !excludesExtensions &&
      ideExtension
    ) {
      args.push('--extension', ideExtension);
    }
    const approvalGate = getApprovalGateExtensionPath();
    if (
      vscode.workspace.isTrusted &&
      !options?.noExtensions &&
      !excludesExtensions &&
      approvalGate
    ) {
      args.push('--extension', approvalGate);
    }
    if (existingSessionPath) {
      args.push('--session', existingSessionPath);
    }
    return [...args, ...this.settings.additionalArgs];
  }
}
