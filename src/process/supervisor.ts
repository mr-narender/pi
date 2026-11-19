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
import { findByEnv } from './detachedRuntime/registry';
import { readTokenFile } from './detachedRuntime/token';
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
    // --- Detached runtime path (opt-in, default OFF) ---
    // When enabled, spawn or re-attach to a detached runtime that outlives the
    // extension host. Falls back to the shared host on any failure.
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
    this.transport = undefined;
    this.client = undefined;
    this.piProcess = undefined;
    this.detachedConnection = undefined;
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
  private static computeEnvKey(env: NodeJS.ProcessEnv): string {
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
    const channelKey =
      existingSessionPath ?? `new-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const cancelled = () =>
      Object.assign(new Error('Pi startup was cancelled'), { code: 'SDK_STARTUP_CANCELLED' });

    // Look for a live runtime for this (sdkRoot, envKey).
    let entry = findByEnv(baseDir, sdkRoot, envKey);
    let token: string | undefined;
    let runtime: DetachedRuntime | undefined;

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

    if (startEpoch !== this.startEpoch) throw cancelled();

    // Connect to the runtime.
    const conn = new DetachedIpcConnection(sdkRoot);
    const acks: Record<string, number> = {};
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
    if (sessionState?.state === 'attached' || sessionState?.state === 'resync') {
      // Re-attach: the runtime already holds this session.
      handle = conn.attachSession(channelKey);
    } else {
      // Open a new session on the detached runtime.
      handle = await conn.openSession(channelKey, {
        cwd,
        sessionFile: existingSessionPath,
        args,
      });
    }

    if (startEpoch !== this.startEpoch) {
      conn.dispose();
      throw cancelled();
    }

    this.generation += 1;
    this.detachedConnection = conn;
    this.usingDetached = true;
    const client = this.attachClient(handle, 'detached runtime');
    options?.onClient?.(client);
    this.logger.info(
      `Starting Pi for ${this.folder.name} (generation=${this.generation}) via detached runtime ` +
        `[cwd=${cwd}, session=${existingSessionPath ?? '(new)'}]`
    );
    return client;
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
