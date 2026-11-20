import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';

// Per-runtime authentication token. File-primary (the supervisor's decision):
// the 0600 token file under globalStorage is the source of truth; its PATH is
// handed to the runtime via an inherited env var, never argv. First-frame auth,
// constant-time compare.

/** Env var carrying the PATH to the token file (never the token itself). */
export const TOKEN_FILE_ENV = 'PI_HOST_TOKEN_FILE';

/** 256-bit random token, hex-encoded. */
export function generateToken(): string {
  return randomBytes(32).toString('hex');
}

export function tokenFilePath(dir: string, runtimeId: string): string {
  return path.join(dir, `${runtimeId}.token`);
}

/** Write the token with 0600 perms (owner read/write only). */
export function writeTokenFile(file: string, token: string): void {
  writeFileSync(file, token, { mode: 0o600 });
}

export function readTokenFile(file: string): string {
  return readFileSync(file, 'utf8').trim();
}

/** Constant-time string equality; length mismatch is an immediate safe fail. */
export function constantTimeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a ?? '', 'utf8');
  const bb = Buffer.from(b ?? '', 'utf8');
  if (ba.length !== bb.length) {
    timingSafeEqual(ba, ba);
    return false;
  }
  return timingSafeEqual(ba, bb);
}
