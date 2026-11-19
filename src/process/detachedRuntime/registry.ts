import { randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import * as path from 'node:path';

// Per-user registry of live detached runtimes. A 0600 JSON file under the
// per-user runtime directory. Written atomically (temp file + rename). An entry
// is "live" only when its pid is alive AND its endpoint authenticates; stale
// entries are cleaned up. The hard cap of one runtime per (sdkRoot, envKey) is
// enforced against this registry before spawning. Protected by an O_EXCL
// lockfile for concurrent safety.

export interface RuntimeEntry {
  id: string;
  pid: number;
  endpoint: string;
  transport: 'unix' | 'pipe';
  sdkRoot: string;
  envKey: string;
  tokenFile: string;
  startedAt: number;
  owner: { workspace?: string; window?: string };
}

interface RegistryFile {
  v: 1;
  runtimes: RuntimeEntry[];
}

export function registryPath(dir: string): string {
  return path.join(dir, 'registry.json');
}

export function lockPath(dir: string): string {
  return path.join(dir, 'registry.lock');
}

/** Stale lock timeout in milliseconds. */
const STALE_LOCK_MS = 10_000;
/** Max retry attempts for acquiring the lock. */
const LOCK_MAX_RETRIES = 20;
/** Base backoff delay in milliseconds. */
const LOCK_BASE_DELAY_MS = 50;

/**
 * Acquire an exclusive lockfile using O_EXCL (atomic create-or-fail).
 * Retries with exponential backoff. Removes stale locks older than STALE_LOCK_MS.
 * Returns a release function.
 */
export function acquireLock(dir: string): () => void {
  mkdirSync(dir, { recursive: true, mode: process.platform === 'win32' ? undefined : 0o700 });
  const lock = lockPath(dir);

  for (let attempt = 0; attempt < LOCK_MAX_RETRIES; attempt++) {
    try {
      // O_CREAT | O_EXCL | O_WRONLY — fails if the file already exists.
      const fd = openSync(lock, 'wx');
      writeFileSync(lock, String(Date.now()), { mode: 0o600 });
      closeSync(fd);
      return () => {
        try {
          unlinkSync(lock);
        } catch {
          /* ignore */
        }
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      // Check if the lock is stale.
      try {
        const stat = statSync(lock);
        if (Date.now() - stat.mtimeMs > STALE_LOCK_MS) {
          try {
            unlinkSync(lock);
          } catch {
            /* another process may have removed it */
          }
          continue; // retry immediately after removing stale lock
        }
      } catch {
        // Lock file disappeared between our open and stat — retry.
        continue;
      }
    }
    // Backoff with jitter.
    const delay = LOCK_BASE_DELAY_MS * Math.pow(2, Math.min(attempt, 6)) * (0.5 + Math.random());
    const start = Date.now();
    while (Date.now() - start < delay) {
      /* spin — sync sleep is acceptable for sub-second delays in this context */
    }
  }
  throw new Error(`Failed to acquire registry lock after ${LOCK_MAX_RETRIES} attempts`);
}

export function readRegistry(dir: string): RuntimeEntry[] {
  const file = registryPath(dir);
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as RegistryFile;
    if (!parsed || parsed.v !== 1 || !Array.isArray(parsed.runtimes)) return [];
    return parsed.runtimes.filter(
      (e) => e && typeof e.pid === 'number' && typeof e.id === 'string'
    );
  } catch {
    return [];
  }
}

/** Atomic 0600 write (temp + rename). */
export function writeRegistry(dir: string, runtimes: RuntimeEntry[]): void {
  mkdirSync(dir, { recursive: true, mode: process.platform === 'win32' ? undefined : 0o700 });
  const file = registryPath(dir);
  const tmp = `${file}.${randomUUID()}.tmp`;
  const payload: RegistryFile = { v: 1, runtimes };
  writeFileSync(tmp, JSON.stringify(payload), { mode: 0o600 });
  renameSync(tmp, file);
}

export function addEntry(dir: string, entry: RuntimeEntry): void {
  const release = acquireLock(dir);
  try {
    const runtimes = readRegistry(dir).filter(
      (e) =>
        e.id !== entry.id &&
        // Dedupe on (sdkRoot, envKey): only one runtime per environment.
        !(e.sdkRoot === entry.sdkRoot && e.envKey === entry.envKey)
    );
    runtimes.push(entry);
    writeRegistry(dir, runtimes);
  } finally {
    release();
  }
}

export function removeEntry(dir: string, id: string): void {
  const release = acquireLock(dir);
  try {
    const runtimes = readRegistry(dir).filter((e) => e.id !== id);
    writeRegistry(dir, runtimes);
  } finally {
    release();
  }
}

/** Default liveness: the process still exists. Callers add an endpoint auth check. */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but is owned by another user.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Remove entries whose pid is dead (and best-effort unlink their token/socket
 * files). Returns the still-live entries. `isAlive` is injectable for tests.
 */
export function cleanupStale(
  dir: string,
  isAlive: (pid: number) => boolean = pidAlive
): RuntimeEntry[] {
  const all = readRegistry(dir);
  const live: RuntimeEntry[] = [];
  const dead: RuntimeEntry[] = [];
  for (const entry of all) (isAlive(entry.pid) ? live : dead).push(entry);
  if (dead.length) {
    for (const entry of dead) {
      for (const file of [
        entry.tokenFile,
        entry.transport === 'unix' ? entry.endpoint : undefined,
      ]) {
        if (file && existsSync(file)) {
          try {
            unlinkSync(file);
          } catch {
            /* ignore */
          }
        }
      }
    }
    writeRegistry(dir, live);
  }
  return live;
}

/** Live runtime for a given (sdkRoot, envKey), if any (after stale cleanup). */
export function findByEnv(
  dir: string,
  sdkRoot: string,
  envKey: string,
  isAlive: (pid: number) => boolean = pidAlive
): RuntimeEntry | undefined {
  return cleanupStale(dir, isAlive).find((e) => e.sdkRoot === sdkRoot && e.envKey === envKey);
}

/**
 * Hold the lock across findByEnv → callback → addEntry to prevent two callers
 * from spawning duplicate runtimes for the same (sdkRoot, envKey). The callback
 * receives the existing entry (if any) and must return the new entry to add, or
 * undefined to skip adding.
 */
export function lockedFindAndAdd(
  dir: string,
  sdkRoot: string,
  envKey: string,
  callback: (existing: RuntimeEntry | undefined) => RuntimeEntry | undefined,
  isAlive: (pid: number) => boolean = pidAlive
): RuntimeEntry | undefined {
  const release = acquireLock(dir);
  try {
    const all = readRegistry(dir);
    const live: RuntimeEntry[] = [];
    const dead: RuntimeEntry[] = [];
    for (const entry of all) (isAlive(entry.pid) ? live : dead).push(entry);
    if (dead.length) {
      for (const entry of dead) {
        for (const file of [
          entry.tokenFile,
          entry.transport === 'unix' ? entry.endpoint : undefined,
        ]) {
          if (file && existsSync(file)) {
            try {
              unlinkSync(file);
            } catch {
              /* ignore */
            }
          }
        }
      }
    }
    const existing = live.find((e) => e.sdkRoot === sdkRoot && e.envKey === envKey);
    const newEntry = callback(existing);
    if (newEntry) {
      const updated = live.filter(
        (e) =>
          e.id !== newEntry.id && !(e.sdkRoot === newEntry.sdkRoot && e.envKey === newEntry.envKey)
      );
      updated.push(newEntry);
      writeRegistry(dir, updated);
    } else if (dead.length) {
      writeRegistry(dir, live);
    }
    return existing ?? newEntry;
  } finally {
    release();
  }
}
