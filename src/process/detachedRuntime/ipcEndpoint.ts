import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Local IPC endpoint builders for the detached runtime. Unix domain socket on
// macOS/Linux/WSL (inside a per-user 0700 directory), named pipe on Windows.
// NEVER TCP. Path building is pure + injectable so the Windows pipe shape is
// unit-testable on any platform.

export interface EndpointEnv {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  username: string;
  uid?: number;
}

export function currentEndpointEnv(): EndpointEnv {
  let username = 'user';
  let uid: number | undefined;
  try {
    const info = os.userInfo();
    username = info.username;
    uid = typeof info.uid === 'number' && info.uid >= 0 ? info.uid : undefined;
  } catch {
    /* userInfo can throw on some sandboxes */
  }
  return { platform: process.platform, env: process.env, username, uid };
}

/** Short, stable, non-reversible per-user token for directory/pipe naming. */
export function userHash(ctx: EndpointEnv = currentEndpointEnv()): string {
  const seed = `${ctx.username}:${ctx.uid ?? ''}`;
  return createHash('sha256').update(seed).digest('hex').slice(0, 12);
}

/**
 * Per-user directory for the socket + registry + token files. On WSL/Linux this
 * resolves to the Linux filesystem (XDG_RUNTIME_DIR when present), never /mnt/c.
 * On Windows this is under the user profile (default user-only ACL).
 *
 * When `remoteName` is 'wsl', an extra guard ensures the resolved dir is NOT
 * under `/mnt/` (which would be the Windows filesystem exposed to WSL); if it
 * is, we fall back to `os.tmpdir()` / XDG_RUNTIME_DIR on the Linux side.
 */
export function runtimeDir(ctx: EndpointEnv = currentEndpointEnv(), remoteName?: string): string {
  const hash = userHash(ctx);
  if (ctx.platform === 'win32') {
    const base =
      ctx.env.LOCALAPPDATA ?? ctx.env.APPDATA ?? ctx.env.TEMP ?? ctx.env.TMP ?? os.tmpdir();
    return path.join(base, 'pi-vscode', `rt-${hash}`);
  }
  let base = ctx.env.XDG_RUNTIME_DIR ?? ctx.env.TMPDIR ?? '/tmp';
  // WSL guard: if the resolved base lives under /mnt/ (Windows FS) fall back
  // to os.tmpdir() (guaranteed on the Linux FS) so the socket stays fast and
  // permission bits are honoured.
  if (remoteName === 'wsl' && base.startsWith('/mnt/')) {
    base =
      ctx.env.XDG_RUNTIME_DIR && !ctx.env.XDG_RUNTIME_DIR.startsWith('/mnt/')
        ? ctx.env.XDG_RUNTIME_DIR
        : os.tmpdir();
  }
  return path.join(base, `pi-vscode-${hash}`);
}

/**
 * Stat-based options for directory validation. Injectable for testing.
 */
export interface DirStatOpts {
  lstatSync?: (p: string) => { isSymbolicLink(): boolean; uid: number; mode: number };
  getuid?: () => number;
}

/**
 * Validate a directory is safe for use as a UDS endpoint:
 * - Not a symlink
 * - Owned by the current uid
 * - No group/other permissions (mode & 0o077 === 0)
 *
 * Returns true if safe, false otherwise.
 */
export function validateDirSecurity(dir: string, opts: DirStatOpts = {}): boolean {
  const lstat = opts.lstatSync ?? lstatSync;
  const getuid = opts.getuid ?? (process.getuid ? () => process.getuid!() : () => -1);

  try {
    const stat = lstat(dir);
    if (stat.isSymbolicLink()) return false;
    const myUid = getuid();
    if (myUid >= 0 && stat.uid !== myUid) return false;
    if ((stat.mode & 0o077) !== 0) return false;
    return true;
  } catch {
    return false; // doesn't exist yet → safe to create
  }
}

/**
 * Create the per-user runtime dir with 0700 perms (POSIX).
 *
 * Hardened: on POSIX, after creating/finding the directory, lstat it to verify
 * it is not a symlink, is owned by the current user, and has no group/other
 * permissions. If the existing directory fails these checks, a new directory
 * with an unpredictable name is used instead (fail-closed).
 */
export function ensureRuntimeDir(
  dir: string,
  platform: NodeJS.Platform = process.platform,
  statOpts: DirStatOpts = {}
): string {
  if (platform === 'win32') {
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  // Try to create or use the requested directory.
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  // Validate the directory after creation (mkdirSync with recursive does not
  // correct permissions on an existing directory).
  if (validateDirSecurity(dir, statOpts)) {
    return dir;
  }

  // The existing directory is unsafe (symlink, wrong owner, or wrong perms).
  // Create a new unpredictable directory under the same parent.
  const parent = path.dirname(dir);
  const safeDir = mkdtempSync(path.join(parent, 'pi-vscode-safe-'));
  // mkdtempSync creates with 0700 by default on POSIX (umask-masked, but we
  // set mode explicitly on the new dir to be sure).
  try {
    const { chmodSync } = require('node:fs') as typeof import('node:fs');
    chmodSync(safeDir, 0o700);
  } catch {
    /* best effort */
  }
  return safeDir;
}

/**
 * IPC endpoint for a runtime id. Unix socket path is kept short (hashed id) to
 * respect the ~104-char sun_path limit; the Windows pipe name embeds the
 * per-user hash so other users' VS Code cannot guess it.
 */
export function ipcEndpoint(runtimeId: string, ctx: EndpointEnv = currentEndpointEnv()): string {
  const shortId = createHash('sha256').update(runtimeId).digest('hex').slice(0, 10);
  if (ctx.platform === 'win32') {
    return `\\\\.\\pipe\\pi-vscode-${userHash(ctx)}-${shortId}`;
  }
  return path.join(runtimeDir(ctx), `${shortId}.sock`);
}
