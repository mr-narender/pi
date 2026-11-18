import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

test('native fixture realpath shim delegates unlisted paths unchanged', () => {
  const script = `
    const fs = require('node:fs');
    const assert = require('node:assert/strict');
    let calls = 0;
    const original = (path, callback) => { calls++; callback(null, 'original:' + path); };
    original.native = () => { throw new Error('unlisted path reached native'); };
    const originalSync = fs.realpathSync;
    const wrappedSync = (path, ...args) => path === '/unlisted' ? 'sync:' + path : originalSync(path, ...args);
    wrappedSync.native = () => { throw new Error('unlisted sync path reached native'); };
    fs.realpathSync = wrappedSync;
    fs.realpath = original;
    fs.promises.realpath = async path => 'promise:' + path;
    require(${JSON.stringify(resolve('test/helpers/network-denial.cjs'))});
    fs.realpath('/unlisted', (error, value) => assert.equal(value, 'original:/unlisted'));
    assert.equal(calls, 1);
    assert.equal(fs.realpathSync('/unlisted'), 'sync:/unlisted');
    fs.promises.realpath('/unlisted').then(value => assert.equal(value, 'promise:/unlisted'));
  `;
  const child = spawnSync(
    process.execPath,
    ['--permission', `--allow-fs-read=${process.cwd()}`, '-e', script],
    {
      env: {
        ...process.env,
        PI_FIXTURE_PORT: '12345',
        PI_FIXTURE_NETWORK_LOG: '/unused',
        PI_CODING_AGENT_DIR: '/owned',
      },
      encoding: 'utf8',
    }
  );
  assert.equal(child.status, 0, child.stderr);
});
