import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { resolve } from 'node:path';

// Unit tests for the detached-runtime parked draft adoption system.
// Since supervisor.ts imports vscode (unavailable in unit tests), we build
// a CJS bundle with vscode stubbed, same pattern as other supervisor tests.

const REPO_ROOT = resolve(__dirname, '../..');

async function buildSupervisorExports() {
  const result = await build({
    stdin: {
      contents:
        "export { PiProcessSupervisor, disposeParkedDetachedDrafts } from './src/process/supervisor';",
      resolveDir: REPO_ROOT,
    },
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    external: ['vscode', 'fixture-stubs'],
    plugins: [
      {
        name: 'unit-stubs',
        setup(b) {
          b.onLoad({ filter: /piLauncher\.ts$/ }, () => ({
            contents: `
              export function piLaunchEnvironment() { return {}; }
              export function resolvePiLaunch() { return {}; }
              export function validateAdditionalArgs() {}
              export function isSupportedPiSdkVersion() { return true; }
              export const PI_SDK_RANGE = { minMajor: 1, minMinor: 3, maxExclusiveMajor: 2 };
            `,
            loader: 'ts',
          }));
          b.onLoad({ filter: /sharedPiHost\.ts$/ }, () => ({
            contents: `export function getSharedPiHost() { return undefined; }`,
            loader: 'ts',
          }));
        },
      },
    ],
  });
  const mod = { exports: {} as any };
  new Function('require', 'module', 'exports', result.outputFiles[0]!.text)(
    (name: string) => {
      if (name === 'vscode') {
        return {
          workspace: {
            isTrusted: false,
            getConfiguration: () => ({
              get: (_key: string, fallback: unknown) => fallback,
            }),
          },
          extensions: { getExtension: () => undefined },
        };
      }
      return require(name);
    },
    mod,
    mod.exports
  );
  return mod.exports;
}

test('disposeParkedDetachedDrafts clears all drafts and is idempotent', async () => {
  const { disposeParkedDetachedDrafts } = await buildSupervisorExports();
  disposeParkedDetachedDrafts();
  disposeParkedDetachedDrafts();
});

test('PiProcessSupervisor.computeEnvKey returns a stable sha256 hex string', async () => {
  const { PiProcessSupervisor } = await buildSupervisorExports();
  const env = { PATH: '/usr/bin', HOME: '/home/test' } as NodeJS.ProcessEnv;
  const key1 = PiProcessSupervisor.computeEnvKey(env);
  const key2 = PiProcessSupervisor.computeEnvKey(env);
  assert.match(key1, /^[a-f0-9]{64}$/);
  assert.equal(key1, key2);
});

test('PiProcessSupervisor.computeEnvKey differs for different environments', async () => {
  const { PiProcessSupervisor } = await buildSupervisorExports();
  const a = PiProcessSupervisor.computeEnvKey({ PATH: '/a' } as NodeJS.ProcessEnv);
  const b = PiProcessSupervisor.computeEnvKey({ PATH: '/b' } as NodeJS.ProcessEnv);
  assert.notEqual(a, b);
});

test('computeEnvKey matches manual sha256 computation', async () => {
  const { PiProcessSupervisor } = await buildSupervisorExports();
  const env = { B: '2', A: '1' } as NodeJS.ProcessEnv;
  const expected = createHash('sha256')
    .update(
      JSON.stringify([
        ['A', '1'],
        ['B', '2'],
      ])
    )
    .digest('hex');
  assert.equal(PiProcessSupervisor.computeEnvKey(env), expected);
});
