/**
 * Detached-runtime IPC layer for the multi-session SDK host.
 *
 * When PI_HOST_IPC_ENDPOINT is set, pi-multi-host.mjs serves the existing
 * multiplexed {k,d} JSONL protocol over a LOCAL IPC endpoint (Unix domain
 * socket on macOS/Linux/WSL, named pipe on Windows) instead of stdio, so the
 * runtime can outlive the extension host and a later extension host can
 * re-attach to the same sessions.
 *
 * This module owns only the deterministic, separately testable primitives
 * (constant-time compare, per-session replay ring buffer, active-turn tracker,
 * idle-exit manager) plus the socket server (auth, per-session acks, single
 * attach). It never imports the Pi SDK, so it is unit-testable in isolation.
 */
import net from 'node:net';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';

/** Constant-time string equality. Length mismatch is an immediate, safe fail. */
export function constantTimeEqual(a, b) {
  const ba = Buffer.from(String(a ?? ''), 'utf8');
  const bb = Buffer.from(String(b ?? ''), 'utf8');
  if (ba.length !== bb.length) {
    // Compare against self so a length check alone does not leak via timing.
    timingSafeEqual(ba, ba);
    return false;
  }
  return timingSafeEqual(ba, bb);
}

/**
 * Bounded per-session ring buffer of outbound {k,d} frames, each tagged with a
 * per-session monotonic seq. Capped by both bytes and count; the oldest frames
 * are trimmed first. A re-attaching client that asks for frames after an ack
 * older than the trimmed head is told to resync instead.
 */
export function createRingBuffer({ maxBytes = 4 * 1024 * 1024, maxCount = 2000 } = {}) {
  const sessions = new Map();
  const ensure = (k) => {
    let s = sessions.get(k);
    if (!s) {
      s = { seq: 0, trimmedUpTo: 0, frames: [], bytes: 0 };
      sessions.set(k, s);
    }
    return s;
  };
  return {
    /** Record a frame; returns its new per-session seq. */
    push(k, frameText) {
      const s = ensure(k);
      s.seq += 1;
      const bytes = Buffer.byteLength(frameText, 'utf8');
      s.frames.push({ seq: s.seq, text: frameText, bytes });
      s.bytes += bytes;
      while (s.frames.length > maxCount || (s.bytes > maxBytes && s.frames.length > 1)) {
        const dropped = s.frames.shift();
        s.bytes -= dropped.bytes;
        s.trimmedUpTo = dropped.seq;
      }
      return s.seq;
    },
    /**
     * Frames the client is missing given the last seq it saw.
     * overflow=true means the needed frames were already trimmed → caller must
     * resync that session from JSONL/get_state.
     */
    since(k, ack) {
      const s = sessions.get(k);
      if (!s) return { overflow: false, frames: [], seq: 0 };
      let from = Number.isFinite(ack) ? ack : 0;
      if (from > s.seq) from = s.seq;
      const overflow = from < s.trimmedUpTo;
      const frames = overflow ? [] : s.frames.filter((f) => f.seq > from);
      return { overflow, frames, seq: s.seq };
    },
    seq(k) {
      return sessions.get(k)?.seq ?? 0;
    },
    drop(k) {
      sessions.delete(k);
    },
    has(k) {
      return sessions.has(k);
    },
    sessionKeys() {
      return [...sessions.keys()];
    },
  };
}

/**
 * Tracks which sessions have an in-flight turn by observing the outbound event
 * stream (agent_start → agent_settled). Keeps the runtime alive while a turn is
 * running even with no client attached.
 */
export function createTurnTracker() {
  const active = new Set();
  return {
    observe(k, d) {
      const type = d && d.type;
      if (type === 'agent_start') active.add(k);
      else if (type === 'agent_settled') active.delete(k);
    },
    clear(k) {
      active.delete(k);
    },
    hasActive() {
      return active.size > 0;
    },
    isActive(k) {
      return active.has(k);
    },
    size() {
      return active.size;
    },
  };
}

/**
 * Fires onIdle only after idleMs of continuous idleness, where "idle" means NO
 * client attached AND NO active turn. Any attach, or an active turn, suspends
 * the timer; it (re)starts once both conditions clear. Timers are injectable
 * for deterministic tests.
 */
export function createIdleManager({
  idleMs,
  hasActiveTurn,
  onIdle,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  let timer;
  let attached = 0;
  const cancel = () => {
    if (timer) {
      clearTimer(timer);
      timer = undefined;
    }
  };
  const evaluate = () => {
    cancel();
    if (attached > 0 || hasActiveTurn()) return;
    timer = setTimer(() => {
      timer = undefined;
      if (attached === 0 && !hasActiveTurn()) onIdle();
      else evaluate();
    }, idleMs);
    timer?.unref?.();
  };
  return {
    clientAttached() {
      attached += 1;
      evaluate();
    },
    clientDetached() {
      attached = Math.max(0, attached - 1);
      evaluate();
    },
    turnSettled() {
      evaluate();
    },
    start() {
      evaluate();
    },
    stop() {
      cancel();
    },
    get attachedCount() {
      return attached;
    },
  };
}

function attachLineReader(socket, onLine) {
  let buffer = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (line.trim()) onLine(line);
    }
  });
}

/**
 * IPC server over a Unix domain socket or Windows named pipe.
 *
 * Protocol:
 *   client → server first frame: {"auth":"<hex>","sessions":{"<k>":<ackSeq>}}
 *   server → client on auth:     {"attach":{ok:true,sessions:{<k>:{state}}}}
 *                                 followed by replayed data frames, or
 *                                {"attach":{ok:false,error:"unauthorized"}}
 *   server → client data frame:  {"f":{k,d},"s":<seq>}
 *   client → server after auth:  raw {k,d} envelopes (routed to onInbound) and
 *                                {"ack":{"<k>":<seq>}} control frames.
 *
 * Single attach: a session is controlled by at most one connection; a second
 * client listing it gets {state:"busy-elsewhere"} and receives no control.
 */
export function createIpcServer({
  endpoint,
  readToken,
  onInbound,
  replayFor,
  onClientAttached,
  onClientDetached,
}) {
  const controllers = new Map(); // sessionKey -> connection
  let nextConnId = 1;

  const server = net.createServer((socket) => {
    const conn = { id: nextConnId++, socket, authed: false, sessions: new Set() };
    const write = (obj) => {
      try {
        socket.write(JSON.stringify(obj) + '\n');
      } catch {
        /* client gone */
      }
    };

    attachLineReader(socket, (line) => {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (!conn.authed) {
        const ok = constantTimeEqual(msg && msg.auth, readToken());
        if (!ok) {
          write({ attach: { ok: false, error: 'unauthorized' } });
          socket.destroy();
          return;
        }
        conn.authed = true;
        const acks = (msg && msg.sessions) || {};
        const sessionStates = {};
        const replay = [];
        for (const [k, ack] of Object.entries(acks)) {
          const other = controllers.get(k);
          if (other && other !== conn) {
            sessionStates[k] = { state: 'busy-elsewhere' };
            continue;
          }
          controllers.set(k, conn);
          conn.sessions.add(k);
          const result = replayFor(k, Number(ack) || 0);
          sessionStates[k] = { state: result.overflow ? 'resync' : 'attached', seq: result.seq };
          for (const f of result.frames) replay.push(f);
        }
        write({ attach: { ok: true, sessions: sessionStates } });
        for (const f of replay) write(f);
        onClientAttached?.(conn);
        return;
      }
      if (msg && msg.ack) return; // acks are advisory; buffer is seq-driven
      // Take control of a session on first open from this connection.
      if (msg && msg.k && msg.d && msg.d.type === 'open') {
        const other = controllers.get(msg.k);
        if (other && other !== conn) {
          write({
            f: {
              k: msg.k,
              d: {
                type: 'response',
                command: 'open',
                success: false,
                error: 'SDK_SESSION_BUSY_ELSEWHERE',
              },
            },
            s: 0,
          });
          return;
        }
        controllers.set(msg.k, conn);
        conn.sessions.add(msg.k);
      }
      // Only route control for sessions this connection owns.
      if (msg && msg.k && controllers.get(msg.k) && controllers.get(msg.k) !== conn) return;
      onInbound(line);
    });

    const teardown = () => {
      for (const k of conn.sessions) {
        if (controllers.get(k) === conn) controllers.delete(k);
      }
      conn.sessions.clear();
      if (conn.authed) onClientDetached?.(conn);
    };
    socket.on('close', teardown);
    socket.on('error', () => socket.destroy());
  });

  return {
    server,
    listen() {
      return new Promise((resolve, reject) => {
        if (process.platform !== 'win32' && existsSync(endpoint)) {
          try {
            unlinkSync(endpoint);
          } catch {
            /* ignore */
          }
        }
        server.once('error', reject);
        server.listen(endpoint, () => {
          server.removeListener('error', reject);
          resolve();
        });
      });
    },
    /** Deliver an outbound frame to the controller of session k, if attached. */
    emit(k, envelope, seq) {
      const conn = controllers.get(k);
      if (!conn || !conn.authed) return;
      try {
        conn.socket.write(JSON.stringify({ f: envelope, s: seq }) + '\n');
      } catch {
        /* client gone */
      }
    },
    clientCount() {
      const live = new Set();
      for (const conn of controllers.values()) live.add(conn);
      return live.size;
    },
    close() {
      for (const conn of controllers.values()) {
        try {
          conn.socket.destroy();
        } catch {
          /* ignore */
        }
      }
      controllers.clear();
      try {
        server.close();
      } catch {
        /* ignore */
      }
    },
  };
}

/** Read the token from the file whose path is in PI_HOST_TOKEN_FILE. */
export function readTokenFromEnv(env = process.env) {
  const file = env.PI_HOST_TOKEN_FILE;
  if (!file) return '';
  try {
    return readFileSync(file, 'utf8').trim();
  } catch {
    return '';
  }
}
