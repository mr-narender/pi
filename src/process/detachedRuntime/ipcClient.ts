import { connect, type Socket } from 'node:net';
import { once } from 'node:events';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { PassThrough, Writable } from 'node:stream';
import type { PiProcessHandle } from '../piProcess';

// Extension-side client for a detached runtime. Connects to the local IPC
// endpoint, performs HMAC-SHA256 mutual authentication, then speaks the same
// multiplexed {k,d} protocol the stdio host used — unwrapping the {f,s}
// replay/live frames and tracking the last seq per session so a later
// re-attach can ask only for what it missed. Mirrors HostWorkerConn's framing.

export interface AttachSessionState {
  state: 'attached' | 'resync' | 'busy-elsewhere';
  seq?: number;
}

export interface AttachResult {
  ok: boolean;
  error?: string;
  sessions: Record<string, AttachSessionState>;
}

interface Channel {
  stdout: PassThrough;
  stderr: PassThrough;
  onOpen?: (ok: boolean, error?: string) => void;
  onExit?: (code: number | null, signal: string | null) => void;
  opened: boolean;
  lastSeq: number;
}

/** Constant-time string comparison for HMAC verification. */
function constantTimeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) {
    timingSafeEqual(ba, ba);
    return false;
  }
  return timingSafeEqual(ba, bb);
}

/** HMAC-SHA256 helper: returns hex digest. */
function hmacSha256(key: string, data: string): string {
  return createHmac('sha256', key).update(data).digest('hex');
}

export class DetachedIpcConnection {
  private socket: Socket | undefined;
  private buffer = '';
  private readonly channels = new Map<string, Channel>();
  private pendingAttach: ((result: AttachResult) => void) | undefined;
  private attachTimer: ReturnType<typeof setTimeout> | undefined;
  /** Set during the challenge-response auth flow. */
  private authState:
    | {
        token: string;
        clientNonce: string;
        acks: Record<string, number>;
        pendingResolve: (result: AttachResult) => void;
      }
    | undefined;

  public constructor(public readonly sdkRoot?: string) {}

  private ensureChannel(key: string): Channel {
    let channel = this.channels.get(key);
    if (!channel) {
      channel = { stdout: new PassThrough(), stderr: new PassThrough(), opened: false, lastSeq: 0 };
      this.channels.set(key, channel);
    }
    return channel;
  }

  /**
   * Connect + authenticate with HMAC-SHA256 mutual auth.
   * `acks` maps session key → last seq already seen.
   */
  public async connect(
    endpoint: string,
    token: string,
    acks: Record<string, number> = {},
    timeoutMs = 10_000
  ): Promise<AttachResult> {
    for (const key of Object.keys(acks)) this.ensureChannel(key);
    const socket = connect(endpoint);
    this.socket = socket;
    await once(socket, 'connect');
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => this.onData(chunk));
    socket.on('error', () => this.failAll(new Error('ipc socket error')));
    socket.on('close', () => this.failAll(new Error('ipc socket closed')));
    const result = new Promise<AttachResult>((resolve, reject) => {
      this.pendingAttach = resolve;
      this.attachTimer = setTimeout(() => {
        this.pendingAttach = undefined;
        this.authState = undefined;
        reject(new Error('Timed out authenticating with detached runtime'));
      }, timeoutMs);
    });

    // Step 1: Send hello with clientNonce.
    const clientNonce = randomBytes(32).toString('hex');
    this.authState = { token, clientNonce, acks, pendingResolve: this.pendingAttach! };
    socket.write(JSON.stringify({ hello: true, clientNonce }) + '\n');
    return result;
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let index: number;
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      if (line.trim()) this.routeLine(line);
    }
  }

  private routeLine(line: string): void {
    let msg: {
      challenge?: boolean;
      serverProof?: string;
      serverNonce?: string;
      attach?: AttachResult;
      f?: { k: string; d: Record<string, unknown> };
      s?: number;
    };
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }

    // Step 2: Server sends challenge with serverProof + serverNonce.
    if (msg.challenge && this.authState) {
      const { token, clientNonce, acks } = this.authState;
      const serverNonce = msg.serverNonce;
      const serverProof = msg.serverProof;

      if (typeof serverNonce !== 'string' || typeof serverProof !== 'string') {
        // Invalid challenge — abort without revealing token.
        this.authState = undefined;
        this.dispose();
        if (this.pendingAttach) {
          if (this.attachTimer) clearTimeout(this.attachTimer);
          const resolve = this.pendingAttach;
          this.pendingAttach = undefined;
          resolve({ ok: false, error: 'invalid_challenge', sessions: {} });
        }
        return;
      }

      // Verify server proof (constant-time). If the server doesn't know the
      // token, we abort immediately — never send anything derived from token.
      const expectedServerProof = hmacSha256(token, 'server' + clientNonce + serverNonce);
      if (!constantTimeEqual(serverProof, expectedServerProof)) {
        this.authState = undefined;
        this.dispose();
        if (this.pendingAttach) {
          if (this.attachTimer) clearTimeout(this.attachTimer);
          const resolve = this.pendingAttach;
          this.pendingAttach = undefined;
          resolve({ ok: false, error: 'server_auth_failed', sessions: {} });
        }
        return;
      }

      // Step 3: Send clientProof + sessions.
      const clientProof = hmacSha256(token, 'client' + serverNonce + clientNonce);
      this.authState = undefined;
      try {
        this.socket?.write(JSON.stringify({ clientProof, sessions: acks }) + '\n');
      } catch {
        /* socket gone */
      }
      return;
    }

    // Step 4: Server responds with attach result.
    if (msg.attach && this.pendingAttach) {
      if (this.attachTimer) clearTimeout(this.attachTimer);
      const resolve = this.pendingAttach;
      this.pendingAttach = undefined;
      resolve(msg.attach);
      return;
    }
    if (!msg.f) return;
    const key = msg.f.k;
    const payload = msg.f.d;
    const channel = this.channels.get(key);
    if (!channel || !payload) return;
    // Dedup by seq: skip frames already seen (replay/live overlap during mid-stream attach).
    if (typeof msg.s === 'number') {
      if (msg.s <= channel.lastSeq) return; // already delivered
      channel.lastSeq = msg.s;
    }
    if (payload.command === 'open' && payload.type === 'response') {
      channel.opened = payload.success === true;
      channel.onOpen?.(payload.success === true, payload.error as string | undefined);
      channel.onOpen = undefined;
      return;
    }
    if (payload.type === 'session_closed') {
      channel.onExit?.(0, null);
      return;
    }
    channel.stdout.push(JSON.stringify(payload) + '\n');
  }

  private write(key: string, payload: Record<string, unknown>): void {
    try {
      this.socket?.write(JSON.stringify({ k: key, d: payload }) + '\n');
    } catch {
      /* socket gone */
    }
  }

  private buildHandle(key: string, channel: Channel): PiProcessHandle {
    const stdin = new Writable({
      write: (chunk: Buffer | string, _enc, cb) => {
        const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        for (const raw of text.split('\n')) {
          const trimmed = raw.trim();
          if (!trimmed) continue;
          try {
            this.write(key, JSON.parse(trimmed) as Record<string, unknown>);
          } catch {
            /* skip malformed line */
          }
        }
        cb();
      },
    });
    return {
      sdkRoot: this.sdkRoot,
      stdin,
      stdout: channel.stdout,
      stderr: channel.stderr,
      onError: () => {},
      onExit: (cb) => {
        channel.onExit = cb;
      },
      // Explicit close: tells the runtime to dispose this session. Detachment
      // (extension-host death) must NOT call this — use dispose() instead.
      stop: async () => {
        channel.onOpen?.(false, 'SDK_STARTUP_CANCELLED');
        this.write(key, { type: 'close' });
        channel.stdout.push(null);
      },
    };
  }

  /** Open a NEW session on the runtime (sends the open handshake). */
  public async openSession(
    key: string,
    info: { cwd: string; sessionFile?: string; args?: string[] },
    openTimeoutMs = 60_000
  ): Promise<PiProcessHandle> {
    const channel = this.ensureChannel(key);
    const handle = this.buildHandle(key, channel);
    const opened = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Timed out opening detached session')),
        openTimeoutMs
      );
      channel.onOpen = (ok, error) => {
        clearTimeout(timer);
        if (ok) resolve();
        else reject(new Error(error ?? 'Detached runtime failed to open session'));
      };
    });
    this.write(key, {
      type: 'open',
      cwd: info.cwd,
      sessionFile: info.sessionFile,
      args: info.args,
    });
    await opened;
    return handle;
  }

  /**
   * Re-attach to a session that already lives on the runtime. The replay was
   * requested via connect()'s acks; this just exposes the channel's streams.
   */
  public attachSession(key: string): PiProcessHandle {
    return this.buildHandle(key, this.ensureChannel(key));
  }

  /** Last seq seen per session — build the acks for the next re-attach. */
  public lastSeqs(): Record<string, number> {
    const acks: Record<string, number> = {};
    for (const [key, channel] of this.channels) acks[key] = channel.lastSeq;
    return acks;
  }

  private failAll(error: Error): void {
    if (this.attachTimer) clearTimeout(this.attachTimer);
    this.authState = undefined;
    if (this.pendingAttach) {
      const resolve = this.pendingAttach;
      this.pendingAttach = undefined;
      resolve({ ok: false, error: error.message, sessions: {} });
    }
    for (const channel of this.channels.values()) {
      channel.onOpen?.(false, error.message);
      channel.onOpen = undefined;
      channel.stdout.push(null);
    }
  }

  /**
   * Detach WITHOUT stopping the runtime or its sessions: close the socket only.
   * Simulates extension-host death — the runtime keeps running in-flight turns.
   */
  public dispose(): void {
    const socket = this.socket;
    this.socket = undefined;
    this.authState = undefined;
    try {
      socket?.destroy();
    } catch {
      /* ignore */
    }
  }
}
