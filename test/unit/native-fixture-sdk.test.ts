import assert from 'node:assert/strict';
import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { resolveNativeCli } from '../helpers/nativeFixture';

test('native Pi 1.5 fixtures resolve their locked SDK without a global Pi on PATH', async () => {
  const previous = process.env.PATH;
  const previousSelection = process.env.PI_TEST_SDK;
  try {
    delete process.env.PI_TEST_SDK;
    process.env.PATH = '';
    const selected = await resolveNativeCli('path-cli');
    assert.equal(selected.version, '1.5.2');
    assert.equal(
      selected.root,
      await realpath(resolve('.github/pi-sdk-15/node_modules/@earendil-works/pi-coding-agent'))
    );
  } finally {
    if (previousSelection === undefined) delete process.env.PI_TEST_SDK;
    else process.env.PI_TEST_SDK = previousSelection;
    if (previous === undefined) delete process.env.PATH;
    else process.env.PATH = previous;
  }
});
