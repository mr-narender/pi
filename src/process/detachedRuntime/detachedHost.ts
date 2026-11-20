import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import * as path from 'node:path';

import {
  currentEndpointEnv,
  ensureRuntimeDir,
  ipcEndpoint,
  runtimeDir,
  type EndpointEnv,
} from './ipcEndpoint';
import { addEntry, type RuntimeEntry } from './registry';
import { generateToken, tokenFilePath, writeTokenFile, TOKEN_FILE_ENV } from './token';

// Spawn the multi-session host DETACHED (own process group, stdio not tied to
// the extension host) so it outlives a window reload/close. The host serves the
// {k,d} protocol over the local IPC endpoint. The token's PATH is inherited via
// an env var (never argv); the token file is 0600.

export interface SpawnDetachedOptions {
  hostScript: string;
  /** Node binary to run the host with (defaults to the current process). */
  nodeBin?: string;
  sdkRoot: string;
  /** Precomputed environment key for the one-per-(sdkRoot,envKey) cap. */
  envKey: string;
  /** Base process environment for the host. */
  env: NodeJS.ProcessEnv;
  cwd?: string;
  /** Per-user base dir (e.g. globalStorageUri/detached-runtime) for token+registry. */
  runtimeBaseDir: string;
  idleMs?: number;
  owner?: { workspace?: string; window?: string };
  endpointEnv?: EndpointEnv;
  /** Override the launcher (tests pass the native fixture's plan). */
  command?: string;
  args?: string[];
  replayMaxBytes?: number;
  replayMaxCount?: number;
  /** Explicit endpoint path (tests use a short socket path under the sandbox). */
  endpointOverride?: string;
  /**
   * When true, skip the addEntry call in spawnDetachedRuntime. The caller
   * must call addEntry itself. Use when the caller already holds the registry
   * lock to avoid a 10 s stale-lock spin deadlock.
   */
  skipRegistry?: boolean;
}

export interface DetachedRuntime {
  id: string;
  endpoint: string;
  tokenFile: string;
  token: string;
  pid: number;
  child: ChildProcess;
  entry: RuntimeEntry;
}

/** Wait until the host logs that its IPC endpoint is listening. */
function awaitListening(child: ChildProcess, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let buffer = '';
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('Detached runtime did not report listening in time'));
    }, timeoutMs);
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      buffer += chunk;
      if (buffer.includes('IPC listening')) finish();
      else if (buffer.includes('IPC listen failed'))
        finish(new Error(`Detached runtime IPC listen failed: ${buffer.trim()}`));
    });
    child.once('error', (error) =>
      finish(error instanceof Error ? error : new Error(String(error)))
    );
    child.once('exit', (code) =>
      finish(new Error(`Detached runtime exited before listening (code=${String(code)})`))
    );
  });
}

export async function spawnDetachedRuntime(
  options: SpawnDetachedOptions
): Promise<DetachedRuntime> {
  const ctx = options.endpointEnv ?? currentEndpointEnv();
  const id = randomUUID();
  const safeDir = ensureRuntimeDir(runtimeDir(ctx), ctx.platform);
  ensureRuntimeDir(options.runtimeBaseDir, ctx.platform);
  // Use the safe dir (which may differ from the predictable runtimeDir if the
  // latter was compromised) for the socket endpoint.
  const shortId = createHash('sha256').update(id).digest('hex').slice(0, 10);
  const endpoint =
    options.endpointOverride ??
    (ctx.platform === 'win32' ? ipcEndpoint(id, ctx) : path.join(safeDir, `${shortId}.sock`));
  const tokenFile = tokenFilePath(options.runtimeBaseDir, id);
  const token = generateToken();
  writeTokenFile(tokenFile, token);

  const command = options.command ?? options.nodeBin ?? process.execPath;
  const args = options.args ?? [options.hostScript];
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: {
      ...options.env,
      PI_HOST_PI_ROOT: options.sdkRoot,
      PI_HOST_IPC_ENDPOINT: endpoint,
      [TOKEN_FILE_ENV]: tokenFile,
      PI_HOST_IDLE_MS: String(options.idleMs ?? 10 * 60 * 1000),
      ...(options.replayMaxBytes
        ? { PI_HOST_REPLAY_MAX_BYTES: String(options.replayMaxBytes) }
        : {}),
      ...(options.replayMaxCount
        ? { PI_HOST_REPLAY_MAX_COUNT: String(options.replayMaxCount) }
        : {}),
    },
    detached: true,
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
  });
  try {
    await awaitListening(child, 60_000);
  } catch (error) {
    try {
      child.kill('SIGKILL');
    } catch {
      /* ignore */
    }
    throw error;
  }
  // Drain stderr so the pipe never blocks the detached child; then unref so the
  // extension host can exit without waiting on the runtime.
  child.stderr?.resume();
  child.unref();

  const entry: RuntimeEntry = {
    id,
    pid: child.pid ?? -1,
    endpoint,
    transport: ctx.platform === 'win32' ? 'pipe' : 'unix',
    sdkRoot: options.sdkRoot,
    envKey: options.envKey,
    tokenFile,
    startedAt: Date.now(),
    owner: options.owner ?? {},
  };
  // When the caller already holds the registry lock, it must pass
  // skipRegistry: true and call addEntry itself to avoid a deadlock
  // (addEntry acquires the same lock → 10 s stale-lock spin wait).
  if (!options.skipRegistry) addEntry(options.runtimeBaseDir, entry);
  return { id, endpoint, tokenFile, token, pid: child.pid ?? -1, child, entry };
}
