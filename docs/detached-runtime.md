# Detached runtime (on by default)

Pi runs in a background runtime so replies survive network drops, window reloads
and closes. The next VS Code window re-attaches automatically.

- **Kill switch**: set `piRpc.detachedRuntime.enabled` to `false` to fall back
  to the in-window host (identical to the pre-detached behaviour).
- **Idle exit**: `piRpc.detachedRuntime.idleMinutes` (default 10) — a detached
  runtime exits on its own after this many minutes with no attached window and no
  active turn.
- **Manual stop**: run **Pi: Stop background runtimes** from the Command Palette
  to SIGTERM every live detached runtime immediately.

## Security fix round

### Protocol (HMAC-SHA256 mutual authentication)

```
Client                              Server
  │                                   │
  │─── {hello, clientNonce} ─────────►│  Step 1: 32 random bytes hex
  │                                   │
  │◄── {challenge, serverProof,       │  Step 2: serverProof = HMAC(token,
  │     serverNonce} ────────────────│          "server"||clientNonce||serverNonce)
  │                                   │
  │  Client verifies serverProof      │  Step 3: abort if mismatch (never
  │  (constant-time)                  │          reveals token to rogue server)
  │                                   │
  │─── {clientProof, sessions} ──────►│  clientProof = HMAC(token,
  │                                   │   "client"||serverNonce||clientNonce)
  │                                   │
  │◄── {attach: {ok, sessions}} ─────│  Step 4: server verifies, then attach
```

### Findings fixed

| ID                             | Fix                                                                                                                    | Files                                               |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| **P1-1** Empty-token fail-open | `readTokenFromEnv` throws if unset/unreadable/<64 hex; token read ONCE at startup; auth guards non-empty expected      | `host/detached-ipc.mjs`, `host/pi-multi-host.mjs`   |
| **P1-2** Mutual auth           | HMAC-SHA256 challenge-response replaces raw token send; client verifies server before sending proof                    | `host/detached-ipc.mjs`, `src/.../ipcClient.ts`     |
| **P1-2** UDS dir hardening     | `ensureRuntimeDir` lstat: rejects symlinks, foreign owner, group/other perms; falls back to mkdtemp                    | `src/.../ipcEndpoint.ts`, `src/.../detachedHost.ts` |
| **P2-1** Pre-auth DoS          | 64 KiB byte cap, 5 s auth deadline, 16 concurrent unauthed cap                                                         | `host/detached-ipc.mjs`                             |
| **P2-2** Registry race         | O_EXCL lockfile with backoff + stale timeout; dedupe on (sdkRoot, envKey); supervisor holds lock across find→spawn→add | `src/.../registry.ts`, `src/.../supervisor.ts`      |
| **P2-3** Windows pipe          | Covered by mutual auth (client never reveals token to unverified pipe holder)                                          | (same as P1-2)                                      |

### Tests added/updated

- **Unit** (`test/unit/detached-runtime.test.ts`): `readTokenFromEnv` fail-closed (missing, unreadable, short token); HMAC challenge-response (correct token, wrong-token client, wrong-token server); empty `{}` frame rejected; pre-auth byte cap; auth deadline; concurrent unauthed cap; `ensureRuntimeDir` symlink/perms/foreign-owner rejection; `validateDirSecurity`; registry dedupe on (sdkRoot, envKey); lock serialization.
- **Integration** (`detached-runtime-native.test.ts`, `detached-supervisor-reattach.test.ts`): updated wrong-token assertions to `server_auth_failed` (client detects mismatch before sending proof).

### Verification counts

| Check                    | SDK 13                     | SDK 15                     |
| ------------------------ | -------------------------- | -------------------------- |
| `typecheck`              | ✓                          | ✓                          |
| `lint`                   | ✓                          | ✓                          |
| `format:check`           | ✓                          | ✓                          |
| `test:unit`              | 1206 pass / 0 fail         | 1206 pass / 0 fail         |
| `test:integration`       | 386 pass / 0 fail / 1 skip | 386 pass / 0 fail / 1 skip |
| `node scripts/build.mjs` | ✓                          | ✓                          |
