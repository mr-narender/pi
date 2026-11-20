import * as path from 'node:path';
import { cleanupStale, removeEntry } from './registry';

// Per-user base directory for the detached-runtime token + registry files.
export function detachedRuntimeBaseDir(globalStorageFsPath: string): string {
  return path.join(globalStorageFsPath, 'detached-runtime');
}

/**
 * "Pi: Stop background runtimes" — SIGTERM every live detached runtime (the
 * user owns these processes) and prune the registry. A runtime with an active
 * turn will persist its interrupted marker on the signal, exactly as a real
 * shutdown does.
 */
export function stopBackgroundRuntimes(baseDir: string): { stopped: number } {
  const live = cleanupStale(baseDir);
  let stopped = 0;
  for (const entry of live) {
    try {
      process.kill(entry.pid, 'SIGTERM');
      stopped += 1;
    } catch {
      /* already gone */
    }
    removeEntry(baseDir, entry.id);
  }
  return { stopped };
}

/**
 * Like {@link stopBackgroundRuntimes} but waits for every process to actually
 * exit (polls `kill(pid,0)`). Falls back to SIGKILL after `timeoutMs`.
 */
export async function stopBackgroundRuntimesAndWait(
  baseDir: string,
  timeoutMs = 5000
): Promise<{ stopped: number; forced: number }> {
  const live = cleanupStale(baseDir);
  const pids: number[] = [];
  let stopped = 0;
  for (const entry of live) {
    try {
      process.kill(entry.pid, 'SIGTERM');
      pids.push(entry.pid);
      stopped += 1;
    } catch {
      /* already gone */
    }
    removeEntry(baseDir, entry.id);
  }

  // Poll until every pid has exited or the timeout fires.
  const pidAlive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const deadline = Date.now() + timeoutMs;
  let alive = pids.filter(pidAlive);
  while (alive.length > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
    alive = alive.filter(pidAlive);
  }

  // SIGKILL any survivors.
  let forced = 0;
  for (const pid of alive) {
    try {
      process.kill(pid, 'SIGKILL');
      forced += 1;
    } catch {
      /* already gone */
    }
  }
  // Wait briefly for SIGKILL to take effect.
  if (forced > 0) {
    const killDeadline = Date.now() + 1000;
    let stillAlive = alive.filter(pidAlive);
    while (stillAlive.length > 0 && Date.now() < killDeadline) {
      await new Promise((r) => setTimeout(r, 50));
      stillAlive = stillAlive.filter(pidAlive);
    }
  }
  return { stopped, forced };
}
