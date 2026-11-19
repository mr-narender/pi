import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import * as path from 'node:path';

// Per-user registry of live detached runtimes. A 0600 JSON file under the
// per-user runtime directory. Written atomically (temp file + rename). An entry
// is "live" only when its pid is alive AND its endpoint authenticates; stale
// entries are cleaned up. The hard cap of one runtime per (sdkRoot, envKey) is
// enforced against this registry before spawning.

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
  const runtimes = readRegistry(dir).filter((e) => e.id !== entry.id);
  runtimes.push(entry);
  writeRegistry(dir, runtimes);
}

export function removeEntry(dir: string, id: string): void {
  const runtimes = readRegistry(dir).filter((e) => e.id !== id);
  writeRegistry(dir, runtimes);
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
