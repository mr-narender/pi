import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveNativeCli } from '../helpers/nativeFixture';

test('llama-builtin retains selected SDK factory and degrades safely for missing internals', async () => {
  const { loadLlamaBuiltin } = await import(pathToFileURL(resolve('host/llama-builtin.mjs')).href);
  const sdk = await resolveNativeCli();
  const warnings: string[] = [];
  const entries = await loadLlamaBuiltin(sdk.root, sdk.version, (message: string) =>
    warnings.push(message)
  );
  assert.equal(entries[0].name, 'llama.cpp');
  assert.equal(typeof entries[0].factory, 'function');
  assert.equal(warnings.length, 0);
  assert.deepEqual(
    await loadLlamaBuiltin('/missing-owned-sdk', '1.99.0', (message: string) =>
      warnings.push(message)
    ),
    []
  );
  assert.deepEqual(warnings, [
    'llama.cpp builtin unavailable for SDK 1.99.0; user extensions unaffected',
  ]);
});
