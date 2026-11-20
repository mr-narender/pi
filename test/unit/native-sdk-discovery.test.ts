import assert from 'node:assert/strict';
import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { resolveNativeCli } from '../helpers/nativeFixture';

test('native fixtures find the pinned repository SDK without a PATH installation', async (t) => {
  const previousPath = process.env.PATH;
  const previousSelection = process.env.PI_TEST_SDK;
  delete process.env.PI_TEST_SDK;
  process.env.PATH = '';
  t.after(() => {
    if (previousSelection === undefined) delete process.env.PI_TEST_SDK;
    else process.env.PI_TEST_SDK = previousSelection;
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  });
  const native = await resolveNativeCli();
  assert.equal(native.cli, await realpath(resolve('.github/pi-sdk-15/node_modules/.bin/pi')));
});
