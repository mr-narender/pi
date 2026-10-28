import assert from 'node:assert/strict';
import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { resolveNativeCli } from '../helpers/nativeFixture';

test('native Pi 1.3 fixtures resolve their locked SDK without a global Pi on PATH', async () => {
  const previous = process.env.PATH;
  try {
    process.env.PATH = '';
    const selected = await resolveNativeCli('path-cli');
    assert.equal(selected.version, '1.3.0');
    assert.equal(
      selected.root,
      await realpath(resolve('.github/pi-sdk-13/node_modules/@earendil-works/pi-coding-agent'))
    );
  } finally {
    if (previous === undefined) delete process.env.PATH;
    else process.env.PATH = previous;
  }
});
