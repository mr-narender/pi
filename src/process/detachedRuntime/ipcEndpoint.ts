import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
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

/** Create the per-user runtime dir with 0700 perms (POSIX). */
export function ensureRuntimeDir(dir: string, platform: NodeJS.Platform = process.platform): void {
  mkdirSync(dir, { recursive: true, mode: platform === 'win32' ? undefined : 0o700 });
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
