import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, rm, symlink, writeFile, realpath } from 'node:fs/promises';
import { mkdtempSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, type ChildProcess } from 'node:child_process';
import {
  createNativeFixture,
  nativeSdkHostPlan,
  resolveNativeCli,
  resolveNativeSdkDependency,
} from '../helpers/nativeFixture';

/**
 * Build a managed-install layout in a temp directory, with the release package
 * being a symlink to the pi-sdk-15 fixture's @earendil-works/pi-coding-agent.
 */
async function createManagedInstallFixture() {
  const sdk = await resolveNativeCli();
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pi-managed-integ-')));
  const binDir = join(root, 'bin');
  const installRoot = join(root, 'install');

  // Create the bin directory with shims and launcher marker
  await mkdir(binDir, { recursive: true });
  await writeFile(join(binDir, 'pi'), `#!/bin/sh\nexec node "$basedir/pi-launcher.js" "$@"\n`, {
    mode: 0o755,
  });
  await writeFile(join(binDir, 'pi.cmd'), '@node "%~dp0pi-launcher.js" %*\r\n');
  await writeFile(join(binDir, 'pi-launcher.js'), '// managed install launcher\n');

  // Create the install directory structure
  await mkdir(installRoot, { recursive: true });
  await writeFile(
    join(installRoot, 'managed-install.json'),
    JSON.stringify({ kind: 'pi-managed-install', schemaVersion: 1, layout: 'releases-v1' })
  );
  await writeFile(join(installRoot, 'current-version'), `${sdk.version}\n`);
  await mkdir(join(installRoot, 'staging'), { recursive: true });

  // Create releases/<ver>/node_modules/@earendil-works/ and symlink the fixture package
  const releaseModules = join(
    installRoot,
    'releases',
    sdk.version,
    'node_modules',
    '@earendil-works'
  );
  await mkdir(releaseModules, { recursive: true });
  await symlink(sdk.root, join(releaseModules, 'pi-coding-agent'));

  // Also symlink the SDK's dependency packages that the host script resolves.
  // The startup-adapter resolves these at runtime, so they need to be accessible
  // from the release node_modules.
  const depsRoot = join(installRoot, 'releases', sdk.version, 'node_modules');
  // Walk up from the actual SDK root to find hoisted dependencies (the fixture's
  // node_modules is at .github/pi-sdk-15/node_modules which already has everything).
  const fixtureNodeModules = resolve(sdk.root, '../..');
  const piAiPath = await resolveNativeSdkDependency(
    sdk.root,
    '@earendil-works/pi-ai/dist/models.js'
  );
  // The dependency root is two levels up from dist/models.js
  const piAiRoot = resolve(piAiPath, '../../..');
  const piAiName = piAiRoot.split('/node_modules/').pop()!;
  if (piAiName.startsWith('@')) {
    const [scope, pkg] = piAiName.split('/');
    await mkdir(join(depsRoot, scope!), { recursive: true });
    try {
      await symlink(join(fixtureNodeModules, scope!, pkg!), join(depsRoot, scope!, pkg!));
    } catch {
      // May already exist from the earendil-works scope
    }
  }

  return {
    root,
    binDir,
    installRoot,
    sdkRoot: await realpath(join(releaseModules, 'pi-coding-agent')),
    version: sdk.version,
    cleanup: async () => rm(root, { recursive: true, force: true }),
  };
}

test(
  'managed-install SDK host: session opens via shared host and responds to prompts',
  { timeout: 60000 },
  async () => {
    const fixture = await createNativeFixture('scopes');
    const managed = await createManagedInstallFixture();
    let child: ChildProcess | undefined;
    try {
      // Get the host plan from the native fixture infrastructure
      const plan = await nativeSdkHostPlan(fixture, 'shared');

      // Spawn the host but override PI_HOST_PI_ROOT to point at the managed install SDK
      child = spawn(plan.command, [...plan.args], {
        cwd: plan.cwd,
        env: {
          ...plan.env,
          PI_HOST_PI_ROOT: managed.sdkRoot,
          PI_MANAGED_INSTALL_ROOT: realpathSync(managed.installRoot),
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let buffer = '';
      let stderr = '';
      child.stderr!.on('data', (c: Buffer) => {
        stderr += c.toString();
      });

      const pending = new Map<string, { resolve: (r: any) => void; reject: (e: Error) => void }>();
      child.stdout!.on('data', (c: Buffer) => {
        buffer += c.toString();
        let i;
        while ((i = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, i);
          buffer = buffer.slice(i + 1);
          try {
            const { k, d } = JSON.parse(line);
            const key = `${k}:${d.id ?? d.command}`;
            if (d.type === 'response') {
              pending.get(key)?.resolve(d);
              pending.delete(key);
            }
          } catch {
            /* non-JSON stderr leak */
          }
        }
      });

      child.on('exit', () => {
        for (const p of pending.values())
          p.reject(new Error(`host exited unexpectedly: ${stderr}`));
      });

      let seq = 0;
      const rpc = async (k: string, d: any): Promise<any> => {
        const id = d.type === 'open' ? undefined : String(++seq);
        const key = `${k}:${id ?? 'open'}`;
        const result = new Promise<any>((resolve, reject) => pending.set(key, { resolve, reject }));
        child!.stdin!.write(JSON.stringify({ k, d: { ...d, id } }) + '\n');
        return result;
      };

      // Open a session — this is the 'via shared SDK host' path
      const openResult = await rpc('one', plan.open);
      assert.equal(openResult.success, true, `open should succeed: ${openResult.error ?? ''}`);

      // Verify the session is working by getting capabilities
      const caps = await rpc('one', { type: 'get_capabilities' });
      assert.ok(caps.data, 'should return capabilities');
      assert.equal(caps.data.sdkVersion, managed.version);

      // Verify state is accessible
      const state = await rpc('one', { type: 'get_state' });
      assert.ok(state.data?.sessionId, 'should have a session ID');

      // Close the session cleanly
      child.stdin!.write(JSON.stringify({ k: 'one', d: { type: 'close' } }) + '\n');
    } finally {
      if (child) {
        child.stdin?.end();
        child.kill('SIGTERM');
      }
      await fixture.dispose();
      await managed.cleanup();
    }
  }
);
