import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { pidAlive } from './registry';

// Session file lock: prevents two detached runtimes from opening the same
// session file concurrently. A `.pilock` file is placed next to the session
// file, containing JSON `{runtimeId, pid, timestamp}`. The lock is released
// on close or exit, with stale-lock handling (pid-dead → stale).

export interface SessionLockInfo {
  runtimeId: string;
  pid: number;
  timestamp: number;
}

/** Path of the lock file for a given session file. */
export function sessionLockPath(sessionFile: string): string {
  return `${sessionFile}.pilock`;
}

/**
 * Read a session lock. Returns the lock info if the lock file exists and
 * the holder is alive, or undefined (stale locks are cleaned up).
 */
export function readSessionLock(
  sessionFile: string,
  isAlive: (pid: number) => boolean = pidAlive
): SessionLockInfo | undefined {
  const lockFile = sessionLockPath(sessionFile);
  if (!existsSync(lockFile)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(lockFile, 'utf8')) as SessionLockInfo;
    if (!raw || typeof raw.pid !== 'number' || typeof raw.runtimeId !== 'string') {
      // Malformed lock file — remove.
      try {
        unlinkSync(lockFile);
      } catch {
        /* ignore */
      }
      return undefined;
    }
    if (!isAlive(raw.pid)) {
      // Stale lock (process dead) — remove.
      try {
        unlinkSync(lockFile);
      } catch {
        /* ignore */
      }
      return undefined;
    }
    return raw;
  } catch {
    return undefined;
  }
}

/** Write a session lock file (atomic enough for single-host use). */
export function writeSessionLock(sessionFile: string, info: SessionLockInfo): void {
  writeFileSync(sessionLockPath(sessionFile), JSON.stringify(info), { mode: 0o600 });
}

/** Remove a session lock file. */
export function releaseSessionLock(sessionFile: string): void {
  try {
    unlinkSync(sessionLockPath(sessionFile));
  } catch {
    /* ignore — already gone */
  }
}
