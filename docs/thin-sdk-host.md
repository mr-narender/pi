# Thin SDK host

The extension admits stable Pi SDK versions **>=1.3.0 <2.0.0**. CI qualifies
1.3.0 and 1.5.2 fixtures plus PATH selection; managed installs target 1.5.2.
Prereleases and untraceable custom executables remain stock `pi --mode rpc`
subprocesses, with a diagnostic fallback message. A version range is not a
promise about unknown future API shapes: startup validates the required exports.

## Architecture D

`host/pi-multi-host.mjs` constructs services and sessions with public package-entry
APIs (`ModelRuntime`, `createAgentSessionServices`, `createAgentSessionFromServices`,
`createAgentSessionRuntime`, and `SessionManager`). Native resources, trust,
settings, tool loadouts, model selection and lifecycle stay SDK-owned. Each worker
reuses compatible ModelRuntime instances; process-global SDK/env/cwd boundaries
remain isolated. Dedicated sessions never join reusable workers.

The host still contains substantial command dispatch and ExtensionUIContext code
adapted from `rpc-mode.js`; it is not a tiny replacement for the entire CLI and
does not claim to eliminate RPC semantic maintenance. The removed drift hash
checked source equality, not public-API compatibility. Native integration tests
now qualify behaviour on the supported fixtures.

### Audited exceptions

- `host/llama-builtin.mjs` optionally reads `dist/extensions/index.js` from the
  **selected** SDK root. There is no public llama.cpp factory. It feature-detects
  the named builtin and warns once on import/shape failure without blocking startup.
  Codemode, tool search and MCP use public factories.
- `@earendil-works/pi-ai/dist/models.js` supplies native dynamic thinking-level
  maps, resolved from the selected SDK's dependencies. The coding-agent root does
  not re-export those helpers; hardcoded GUI approximations would lose parity.
- Theme initialization uses public `initTheme`; the remote UI context reads the
  SDK's shared theme symbol because no live-theme getter is exported. This is an
  internal convention, not an additional import.

Scope resolution uses public `resolveModelScopeWithDiagnostics` with an immutable
catalog adapter, preserving native diagnostics without refreshing credentials or
performing network I/O. Scope operations are asynchronous internally; wire shapes
are unchanged. Both fixtures export this resolver, so no private fallback is needed.

## Protocol and performance

Multiplexed JSONL `{k,d}`, command IDs, `get_state.leafId`, worker pooling,
prewarming, parked sessions and dedicated mode are unchanged. All session events
are forwarded; tool-execution events retain `parentToolCallId`. Message updates
use the existing RPC projection: strip bulky partial snapshots but retain delta
fields (including thinking deltas) and tool-call identity.

Worker environment hashes cover all defined variables, independent of insertion
order. Frozen launch-plan snapshots cache their hash; mutable environments are
rehashed once per selection, never once per candidate worker. Hashes/raw values
are not logged. Parked default-argument sessions are adopted only when cwd, SDK
root and environment match and there is no resume file or dedicated request.

Launch discovery has a bounded one-second cache, invalidated on Pi configuration
changes and managed/bundled CLI updates. Fresh plans always capture their own
cwd/environment; external CLI replacement outside extension control is detected
after expiry. Stock fallback never substitutes an unrelated PATH SDK.

## Qualification

Install `.github/pi-sdk-13` and `.github/pi-sdk-15` with
`npm ci --install-strategy=nested` in each fixture directory. Run `npm run test:unit` and `npm run test:integration` with
`PI_TEST_SDK=13`, `15`, or `path`. Fixtures use synthetic credentials and a denied
network boundary except their owned loopback server; no paid provider is needed.

Pi 1.5.2 proper-lockfile calls JavaScript realpath, which traverses ungranted
ancestors under Node's permission model. The fixture-only security preload uses
native realpath for three exact canonical agentDir files: `auth.json`,
`owned-public-auth.json`, and `models-store.json`. Other calls remain untouched;
no parent read permissions are granted. Production does not use `--permission`.
