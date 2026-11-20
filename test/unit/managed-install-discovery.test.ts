import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { PiRpcSettings } from '../../src/config/settings';
import {
  resolveManagedInstallSdk,
  detectPathPi,
  resolvePiLaunch,
  invalidatePiLaunchCache,
} from '../../src/process/piLauncher';

const PI_PACKAGE = '@earendil-works/pi-coding-agent';

/** Build a fake managed-install layout in a temp directory. */
function createManagedInstall(opts: {
  version?: string;
  currentVersion?: string;
  packageName?: string;
  packageVersion?: string;
  binPi?: string;
  skipLauncher?: boolean;
  skipMarker?: boolean;
  skipCurrentVersion?: boolean;
  skipRelease?: boolean;
}): { root: string; binDir: string; binPi: string; installRoot: string; cleanup: () => void } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pi-managed-install-')));
  const binDir = join(root, 'bin');
  mkdirSync(binDir, { recursive: true });
  const installRoot = join(root, 'install');
  mkdirSync(installRoot, { recursive: true });
  const version = opts.version ?? '1.5.2';
  const currentVersion = opts.currentVersion ?? version;
  const packageName = opts.packageName ?? PI_PACKAGE;
  const packageVersion = opts.packageVersion ?? version;
  const binPi = opts.binPi ?? 'dist/bundle/cli.js';

  // Create shim
  const shimPath = join(binDir, 'pi');
  writeFileSync(shimPath, '#!/bin/sh\nexec node "$basedir/pi-launcher.js" "$@"\n', {
    mode: 0o755,
  });
  // Create pi.cmd
  writeFileSync(join(binDir, 'pi.cmd'), '@node "%~dp0pi-launcher.js" %*\r\n');
  // Create pi-launcher.js
  if (!opts.skipLauncher) {
    writeFileSync(join(binDir, 'pi-launcher.js'), '// managed install launcher\n');
  }
  // Create managed-install.json marker
  if (!opts.skipMarker) {
    writeFileSync(
      join(installRoot, 'managed-install.json'),
      JSON.stringify({ kind: 'pi-managed-install', schemaVersion: 1, layout: 'releases-v1' })
    );
  }
  // Create current-version file
  if (!opts.skipCurrentVersion) {
    writeFileSync(join(installRoot, 'current-version'), `${currentVersion}\n`);
  }
  // Create the release package
  if (!opts.skipRelease) {
    const pkgDir = join(
      installRoot,
      'releases',
      currentVersion,
      'node_modules',
      '@earendil-works',
      'pi-coding-agent'
    );
    mkdirSync(join(pkgDir, 'dist', 'bundle'), { recursive: true });
    writeFileSync(
      join(pkgDir, 'package.json'),
      JSON.stringify({
        name: packageName,
        version: packageVersion,
        bin: { pi: binPi },
      })
    );
    // Create the CLI file
    const cliFile = join(pkgDir, binPi);
    mkdirSync(join(cliFile, '..'), { recursive: true });
    writeFileSync(cliFile, '// cli stub\n', { mode: 0o755 });
  }

  return {
    root,
    binDir,
    binPi: shimPath,
    installRoot,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test('managed-install: valid layout resolves SDK root', () => {
  const layout = createManagedInstall({});
  try {
    const result = resolveManagedInstallSdk(layout.binPi);
    assert.ok(result, 'should resolve managed install');
    assert.equal(result.version, '1.5.2');
    assert.ok(result.sdkRoot.includes('pi-coding-agent'));
    assert.ok(result.cliPath.includes('cli.js'));
    assert.equal(result.installRoot, realpathSync(layout.installRoot));
  } finally {
    layout.cleanup();
  }
});

test('managed-install: pi.cmd resolves on simulated win32 path', () => {
  const layout = createManagedInstall({});
  try {
    // The .cmd shim is in the same bin directory; pass pi.cmd path
    const cmdPath = join(layout.binDir, 'pi.cmd');
    const result = resolveManagedInstallSdk(cmdPath);
    assert.ok(result, 'pi.cmd should also resolve managed install');
    assert.equal(result.version, '1.5.2');
  } finally {
    layout.cleanup();
  }
});

test('managed-install: missing pi-launcher.js → not a managed install', () => {
  const layout = createManagedInstall({ skipLauncher: true });
  try {
    assert.equal(resolveManagedInstallSdk(layout.binPi), undefined);
  } finally {
    layout.cleanup();
  }
});

test('managed-install: missing managed-install.json marker → not detected', () => {
  const layout = createManagedInstall({ skipMarker: true });
  try {
    assert.equal(resolveManagedInstallSdk(layout.binPi), undefined);
  } finally {
    layout.cleanup();
  }
});

test('managed-install: missing current-version → not detected', () => {
  const layout = createManagedInstall({ skipCurrentVersion: true });
  try {
    assert.equal(resolveManagedInstallSdk(layout.binPi), undefined);
  } finally {
    layout.cleanup();
  }
});

test('managed-install: invalid version string → rejected', () => {
  const layout = createManagedInstall({ currentVersion: '../../../etc/passwd' });
  try {
    assert.equal(
      resolveManagedInstallSdk(layout.binPi),
      undefined,
      'path traversal in version should be rejected'
    );
  } finally {
    layout.cleanup();
  }
});

test('managed-install: version with spaces → rejected', () => {
  const layout = createManagedInstall({ currentVersion: '1.5.2 --inject' });
  try {
    assert.equal(
      resolveManagedInstallSdk(layout.binPi),
      undefined,
      'version with spaces should be rejected'
    );
  } finally {
    layout.cleanup();
  }
});

test('managed-install: missing release directory → not resolved', () => {
  const layout = createManagedInstall({ skipRelease: true });
  try {
    assert.equal(resolveManagedInstallSdk(layout.binPi), undefined);
  } finally {
    layout.cleanup();
  }
});

test('managed-install: package name mismatch → rejected', () => {
  const layout = createManagedInstall({ packageName: 'some-other-package' });
  try {
    assert.equal(
      resolveManagedInstallSdk(layout.binPi),
      undefined,
      'wrong package name should be rejected'
    );
  } finally {
    layout.cleanup();
  }
});

test('managed-install: out-of-range version → stock fallback', () => {
  const layout = createManagedInstall({ packageVersion: '0.84.2' });
  try {
    assert.equal(
      resolveManagedInstallSdk(layout.binPi),
      undefined,
      'unsupported SDK version should be rejected'
    );
  } finally {
    layout.cleanup();
  }
});

test('managed-install: future major version → stock fallback', () => {
  const layout = createManagedInstall({ packageVersion: '2.0.0' });
  try {
    assert.equal(
      resolveManagedInstallSdk(layout.binPi),
      undefined,
      'future major version should be rejected'
    );
  } finally {
    layout.cleanup();
  }
});

test('managed-install: bin.pi path traversal → rejected', () => {
  const layout = createManagedInstall({ binPi: '../../etc/evil.js' });
  try {
    assert.equal(
      resolveManagedInstallSdk(layout.binPi),
      undefined,
      'bin.pi path traversal should be rejected'
    );
  } finally {
    layout.cleanup();
  }
});

test('managed-install: detectPathPi discovers managed-install shim on PATH', () => {
  const layout = createManagedInstall({});
  const originalPath = process.env.PATH;
  try {
    process.env.PATH = layout.binDir;
    const info = detectPathPi();
    assert.ok(info, 'should find pi on PATH');
    assert.ok(info.packageRoot, 'should resolve package root via managed install');
    assert.ok(info.packageRoot!.includes('pi-coding-agent'));
    assert.equal(info.version, '1.5.2');
    assert.equal(info.managedInstallRoot, realpathSync(layout.installRoot));
  } finally {
    process.env.PATH = originalPath;
    layout.cleanup();
  }
});

test('managed-install: resolvePiLaunch sets PI_MANAGED_INSTALL_ROOT in env', () => {
  const layout = createManagedInstall({});
  const originalPath = process.env.PATH;
  try {
    invalidatePiLaunchCache();
    const settings = { piSource: 'external', executable: 'pi' } as PiRpcSettings;
    const plan = resolvePiLaunch(settings, { PATH: layout.binDir }, layout.root);
    assert.equal(
      plan.sdkRoot,
      realpathSync(
        join(
          layout.installRoot,
          'releases',
          '1.5.2',
          'node_modules',
          '@earendil-works',
          'pi-coding-agent'
        )
      )
    );
    assert.equal(plan.managedInstallRoot, realpathSync(layout.installRoot));
    assert.equal(plan.env.PI_MANAGED_INSTALL_ROOT, realpathSync(layout.installRoot));
    assert.equal(plan.extraEnv.PI_MANAGED_INSTALL_ROOT, realpathSync(layout.installRoot));
  } finally {
    invalidatePiLaunchCache();
    process.env.PATH = originalPath;
    layout.cleanup();
  }
});

test('managed-install: explicit piRpc.executable pointing at shim works', () => {
  const layout = createManagedInstall({});
  try {
    invalidatePiLaunchCache();
    const settings = {
      piSource: 'external',
      executable: layout.binPi,
    } as PiRpcSettings;
    const plan = resolvePiLaunch(settings, { PATH: '' }, layout.root);
    assert.ok(plan.sdkRoot, 'explicit shim path should resolve SDK root');
    assert.equal(plan.managedInstallRoot, realpathSync(layout.installRoot));
    assert.equal(plan.env.PI_MANAGED_INSTALL_ROOT, realpathSync(layout.installRoot));
  } finally {
    invalidatePiLaunchCache();
    layout.cleanup();
  }
});

test('managed-install: cache invalidates when current-version changes', () => {
  const layout = createManagedInstall({});
  const versionFile = join(layout.installRoot, 'current-version');
  try {
    invalidatePiLaunchCache();
    const settings = { piSource: 'external', executable: 'pi' } as PiRpcSettings;
    const env = { PATH: layout.binDir };
    // First call populates cache
    const plan1 = resolvePiLaunch(settings, env, layout.root);
    assert.equal(
      plan1.sdkRoot,
      realpathSync(
        join(
          layout.installRoot,
          'releases',
          '1.5.2',
          'node_modules',
          '@earendil-works',
          'pi-coding-agent'
        )
      )
    );
    // Change current-version to a version that doesn't exist → should lose sdkRoot
    writeFileSync(versionFile, '99.99.99\n');
    // The cache check reads current-version and invalidates
    const plan2 = resolvePiLaunch(settings, env, layout.root);
    assert.equal(plan2.sdkRoot, undefined, 'stale cache should be invalidated on version change');
    assert.equal(plan2.managedInstallRoot, undefined);
  } finally {
    invalidatePiLaunchCache();
    layout.cleanup();
  }
});

test('managed-install: symlinked release package resolves correctly', () => {
  // Create a layout where the package directory is a symlink
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pi-managed-symlink-')));
  try {
    const binDir = join(root, 'bin');
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, 'pi'), '#!/bin/sh\n', { mode: 0o755 });
    writeFileSync(join(binDir, 'pi-launcher.js'), '// launcher\n');

    const installRoot = join(root, 'install');
    mkdirSync(installRoot, { recursive: true });
    writeFileSync(
      join(installRoot, 'managed-install.json'),
      JSON.stringify({ kind: 'pi-managed-install', schemaVersion: 1, layout: 'releases-v1' })
    );
    writeFileSync(join(installRoot, 'current-version'), '1.5.2\n');

    // Create the actual package in a separate location
    const realPkgDir = join(root, 'actual-pkg');
    mkdirSync(join(realPkgDir, 'dist', 'bundle'), { recursive: true });
    writeFileSync(
      join(realPkgDir, 'package.json'),
      JSON.stringify({
        name: PI_PACKAGE,
        version: '1.5.2',
        bin: { pi: 'dist/bundle/cli.js' },
      })
    );
    writeFileSync(join(realPkgDir, 'dist', 'bundle', 'cli.js'), '// cli\n', { mode: 0o755 });

    // Symlink from release to actual package
    const releaseDir = join(installRoot, 'releases', '1.5.2', 'node_modules', '@earendil-works');
    mkdirSync(releaseDir, { recursive: true });
    symlinkSync(realPkgDir, join(releaseDir, 'pi-coding-agent'));

    const result = resolveManagedInstallSdk(join(binDir, 'pi'));
    assert.ok(result, 'symlinked package should resolve');
    assert.equal(result.version, '1.5.2');
    // Realpath should point to the actual package
    assert.equal(result.sdkRoot, realpathSync(realPkgDir));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
