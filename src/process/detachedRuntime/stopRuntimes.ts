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
