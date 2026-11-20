import { existsSync, realpathSync, readFileSync, accessSync, constants, statSync } from 'node:fs';
import { delimiter, dirname, join, resolve, isAbsolute, relative, sep } from 'node:path';
import type { PiRpcSettings } from '../config/settings';

export interface PathPiInfo {
  binPath: string;
  /** npm package root (importable by the shared runtime); undefined when the
   * binary can't be traced to @earendil-works/pi-coding-agent (e.g. wrappers). */
  packageRoot?: string;
  version?: string;
  /** Set when the binary is Pi's own managed-install shim (<agentDir>/bin/pi).
   * This is the `install/` directory that pi-launcher.js manages. */
  managedInstallRoot?: string;
}

// Semver-range gate: the thin SDK host depends on stable public API surface
// (createAgentSessionServices, AgentSession, AgentSessionRuntime, etc.).
// Verified against installed fixtures: .github/pi-sdk-13 (1.3.0) and
// .github/pi-sdk-15 (1.5.2). The range admits any future 1.x patch/minor that
// preserves the same exports without requiring a new extension release.
export const PI_SDK_RANGE = { minMajor: 1, minMinor: 3, maxExclusiveMajor: 2 } as const;
/** Specific version targeted by managed auto-install. */
export const MANAGED_PI_TARGET = '1.5.2';
export const TESTED_PI_VERSION = { major: 1, minor: 5 };

/** Check whether a version string falls in the supported SDK range (>=1.3.0 <2.0.0).
 *  Pre-release versions (e.g. 1.3.0-next) are rejected — only stable releases are admitted. */
export function isSupportedPiSdkVersion(version: unknown): version is string {
  if (typeof version !== 'string') return false;
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) return false;
  const [major, minor] = [Number(match[1]), Number(match[2])];
  return (
    major >= PI_SDK_RANGE.minMajor &&
    major < PI_SDK_RANGE.maxExclusiveMajor &&
    (major > PI_SDK_RANGE.minMajor || minor >= PI_SDK_RANGE.minMinor)
  );
}
/** Pi-launcher.js version validation: only safe filesystem-name characters. */
const MANAGED_VERSION_RE = /^[0-9A-Za-z._+-]+$/;
const PI_PACKAGE_NAME = '@earendil-works/pi-coding-agent';

export interface ManagedInstallInfo {
  /** Package root of the resolved release (the sdkRoot). */
  sdkRoot: string;
  /** Resolved cli.js inside the release package. */
  cliPath: string;
  /** The `install/` directory (PI_MANAGED_INSTALL_ROOT value). */
  installRoot: string;
  /** Version string from current-version. */
  version: string;
}

/**
 * Detect and resolve Pi's own MANAGED-INSTALL layout from a bin path.
 *
 * Layout (created by `pi update self` / the managed installer):
 *   <agentDir>/bin/pi | pi.cmd          (shim)
 *   <agentDir>/bin/pi-launcher.js
 *   <agentDir>/install/managed-install.json
 *   <agentDir>/install/current-version
 *   <agentDir>/install/releases/<ver>/node_modules/@earendil-works/pi-coding-agent/
 *
 * Resolution mirrors pi-launcher.js: read current-version, validate the version
 * string, locate the package, verify name + SDK range + bin.pi containment.
 */
export function resolveManagedInstallSdk(binPath: string): ManagedInstallInfo | undefined {
  try {
    const binDir = dirname(binPath);
    // Marker: pi-launcher.js must exist alongside the shim.
    if (!existsSync(join(binDir, 'pi-launcher.js'))) return undefined;
    const agentDir = dirname(binDir);
    const installRoot = join(agentDir, 'install');
    // Both markers must exist.
    if (!existsSync(join(installRoot, 'managed-install.json'))) return undefined;
    const versionFile = join(installRoot, 'current-version');
    if (!existsSync(versionFile)) return undefined;
    const version = readFileSync(versionFile, 'utf8').trim();
    if (!MANAGED_VERSION_RE.test(version)) return undefined;
    // Reject path-traversal attempts in the version string.
    if (version.includes('..') || version.includes('/') || version.includes('\\')) return undefined;
    const pkgDir = join(
      installRoot,
      'releases',
      version,
      'node_modules',
      '@earendil-works',
      'pi-coding-agent'
    );
    if (!existsSync(join(pkgDir, 'package.json'))) return undefined;
    const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as {
      name?: string;
      version?: string;
      bin?: { pi?: string };
    };
    if (pkg.name !== PI_PACKAGE_NAME) return undefined;
    if (!isSupportedPiSdkVersion(pkg.version)) return undefined;
    if (!pkg.bin?.pi) return undefined;
    // Reject traversal in bin.pi (e.g. "../../etc/evil").
    const binPi = pkg.bin.pi;
    const resolvedCli = resolve(pkgDir, binPi);
    const realCli = realpathSync(resolvedCli);
    // Containment: the resolved CLI must live inside the package directory.
    const rel = relative(realpathSync(pkgDir), realCli);
    if (isAbsolute(rel) || rel.startsWith('..' + sep) || rel === '..') return undefined;
    if (!existsSync(realCli)) return undefined;
    return {
      sdkRoot: realpathSync(pkgDir),
      cliPath: realCli,
      installRoot: realpathSync(installRoot),
      version,
    };
  } catch {
    return undefined;
  }
}

let compatLogged = false;

/** PATH pi's package root, gated on SDK semver range compatibility. */
export function usablePathPiRoot(logger?: {
  warn(message: string): void;
  info(message: string): void;
}): string | undefined {
  const info = detectPathPi();
  if (!info?.packageRoot) {
    return undefined;
  }
  const root = verifiedSdkRoot(info.binPath);
  if (!root && !compatLogged) {
    compatLogged = true;
    logger?.warn(
      `PATH pi v${info.version} is outside the supported SDK range (>=1.3.0 <2.0.0); using stock RPC subprocess only.`
    );
  }
  return root;
}

/** Resolve ONLY the chosen JavaScript CLI, never substitute an unrelated PATH SDK. */
export function selectedSdkRoot(settings: PiRpcSettings): string | undefined {
  return resolvePiLaunch(settings).sdkRoot;
}

function verifiedSdkRoot(cli: string): string | undefined {
  try {
    const realCli = realpathSync(cli);
    let dir = dirname(realCli);
    for (let i = 0; i < 6 && dir !== dirname(dir); i++, dir = dirname(dir)) {
      const pkgPath = join(dir, 'package.json');
      if (!existsSync(pkgPath)) continue;
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
        name?: string;
        version?: string;
        bin?: { pi?: string };
      };
      if (
        pkg.name === '@earendil-works/pi-coding-agent' &&
        isSupportedPiSdkVersion(pkg.version) &&
        pkg.bin?.pi &&
        realCli === realpathSync(join(dir, pkg.bin.pi))
      )
        return dir;
    }
  } catch {
    /* Unknown wrapper/binary remains stock-only. */
  }
  // Managed-install fallback: the CLI is a shim, walk-up cannot find the package.
  const managed = resolveManagedInstallSdk(cli);
  if (managed) return managed.sdkRoot;
  return undefined;
}

/** Find the current `pi` on PATH and resolve its npm package root. */
export function detectPathPi(): PathPiInfo | undefined {
  const names = process.platform === 'win32' ? ['pi.cmd', 'pi.exe', 'pi'] : ['pi'];
  let bin: string | undefined;
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) {
      continue;
    }
    for (const name of names) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) {
        bin = candidate;
        break;
      }
    }
    if (bin) {
      break;
    }
  }
  if (!bin) {
    return undefined;
  }
  let packageRoot: string | undefined;
  let version: string | undefined;
  try {
    let dir = dirname(realpathSync(bin));
    for (let hop = 0; hop < 6 && dir !== dirname(dir); hop += 1) {
      const pkgPath = join(dir, 'package.json');
      if (existsSync(pkgPath)) {
        try {
          const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
            name?: string;
            version?: string;
          };
          if (pkg.name === '@earendil-works/pi-coding-agent') {
            packageRoot = dir;
            version = pkg.version;
            break;
          }
        } catch {
          /* unreadable package.json — keep walking */
        }
      }
      dir = dirname(dir);
    }
  } catch {
    /* realpath failed — binary still usable as an external subprocess */
  }
  // Managed-install fallback: the shim's realpath doesn't walk up to a package.
  if (!packageRoot) {
    const managed = resolveManagedInstallSdk(bin);
    if (managed) {
      return {
        binPath: bin,
        packageRoot: managed.sdkRoot,
        version: managed.version,
        managedInstallRoot: managed.installRoot,
      };
    }
  }
  return { binPath: bin, packageRoot, version };
}

// cli.js locations, set at activation. `bundled` = vendored in the VSIX;
// `managed` = auto-installed into the extension's globalStorage (#3).
let bundledCliPath: string | undefined;
let managedCliPath: string | undefined;

export function setBundledPiCliPath(path: string | undefined): void {
  bundledCliPath = path;
  invalidatePiLaunchCache();
}
export function setManagedPiCliPath(path: string | undefined): void {
  invalidatePiLaunchCache();
  managedCliPath = path && verifiedSdkRoot(path) ? path : undefined;
}
export function bundledPiAvailable(): boolean {
  return typeof bundledCliPath === 'string' && existsSync(bundledCliPath);
}

export type PiLaunchMode = 'subprocess' | 'worker';

export interface PiLaunchPlan {
  readonly sdkRoot?: string;
  /** Set when the CLI is Pi's managed-install shim; the value to pass as
   * PI_MANAGED_INSTALL_ROOT so `pi update self` and other managed features work. */
  readonly managedInstallRoot?: string;
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly mode: PiLaunchMode;
  /** subprocess: executable to spawn. */
  readonly command: string;
  /** subprocess: args before the Pi args (e.g. the cli.js path for the bundled run). */
  readonly prefixArgs: readonly string[];
  /** worker: the cli.js to run in-process. */
  readonly cliPath?: string;
  readonly extraEnv: Readonly<Record<string, string>>;
  readonly usingBundled: boolean;
  readonly label: string;
}

function vendoredCli(): string | undefined {
  return bundledCliPath && existsSync(bundledCliPath) ? bundledCliPath : undefined;
}
function managedCli(): string | undefined {
  return managedCliPath && existsSync(managedCliPath) ? managedCliPath : undefined;
}

type LaunchChoice = Omit<PiLaunchPlan, 'sdkRoot' | 'env' | 'cwd'>;

function bundledSubprocess(cli: string, label: string): LaunchChoice {
  // Run the vendored/managed cli.js with VS Code's own Node (Electron-as-node);
  // its Node 24 satisfies Pi's engines: node >=22.19.
  return {
    mode: 'subprocess',
    command: process.execPath,
    prefixArgs: [cli],
    extraEnv: { ELECTRON_RUN_AS_NODE: '1' },
    usingBundled: true,
    label,
  };
}
function externalSubprocess(settings: PiRpcSettings): LaunchChoice {
  return {
    mode: 'subprocess',
    command: settings.executable,
    prefixArgs: [],
    extraEnv: {},
    usingBundled: false,
    label: `external Pi ('${settings.executable}')`,
  };
}

/** Warmup and chat opens must agree on the effective process environment. */
export function piLaunchEnvironment(
  settings: PiRpcSettings,
  offline = settings.offline,
  env: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const launchShell =
    settings.launchShell.trim() ||
    env.PI_LAUNCH_SHELL ||
    (process.platform === 'win32' ? env.ComSpec || 'cmd.exe' : env.SHELL || '');
  return {
    ...env,
    PI_TELEMETRY: '0',
    PI_SKIP_VERSION_CHECK: '1',
    ...(offline ? { PI_OFFLINE: '1' } : {}),
    ...(launchShell ? { PI_LAUNCH_SHELL: launchShell } : {}),
  };
}

// Cache filesystem discovery only, never the captured environment or launch plan.
// A short TTL detects CLI replacements outside extension-controlled installs.
// managedInstallRoot + managedVersionContent enable cheap invalidation when
// `pi update self` writes a new current-version without waiting for TTL expiry.
const launchDiscovery = new Map<
  string,
  {
    expires: number;
    command: string;
    sdkRoot?: string;
    managedInstallRoot?: string;
    managedVersionContent?: string;
  }
>();
export function invalidatePiLaunchCache(): void {
  launchDiscovery.clear();
}

/** Resolve one authoritative runtime: explicit executable, current PATH, then
 * the selected managed/dev fallback when neither external source exists. */
export function resolvePiLaunch(
  settings: PiRpcSettings,
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd()
): PiLaunchPlan {
  const configuredExecutable = settings.executable !== 'pi';
  const discoveryKey = JSON.stringify([
    settings.executable,
    settings.piSource,
    env.PATH,
    env.Path,
    env.PATHEXT,
    cwd,
    bundledCliPath,
    managedCliPath,
  ]);
  const cached = launchDiscovery.get(discoveryKey);
  const discovery = cached && cached.expires > Date.now() ? cached : undefined;
  const pathExecutable = discovery?.command ?? resolveExecutable(settings.executable, env, cwd);
  const existingPathPi = (() => {
    try {
      accessSync(pathExecutable, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
      return statSync(pathExecutable).isFile();
    } catch {
      return false;
    }
  })();
  const choice =
    configuredExecutable || existingPathPi
      ? externalSubprocess(settings)
      : choosePiLaunch(settings);
  const launchCwd = resolve(cwd);
  const launchEnv = Object.freeze({ ...env, ...choice.extraEnv });
  const cliPath = choice.cliPath ? realpathSync(choice.cliPath) : undefined;
  const prefixArgs = choice.prefixArgs.map((arg) => realpathSync(arg));
  const command = choice.usingBundled
    ? choice.command
    : resolveExecutable(choice.command, launchEnv, launchCwd);
  // Detect managed-install: resolve sdkRoot and installRoot together.
  let sdkRoot: string | undefined;
  let managedInstallRoot: string | undefined;
  let managedVersionContent: string | undefined;
  if (discovery) {
    // Invalidate cached managed-install when current-version file changed.
    if (discovery.managedInstallRoot && discovery.managedVersionContent !== undefined) {
      try {
        const current = readFileSync(
          join(discovery.managedInstallRoot, 'current-version'),
          'utf8'
        ).trim();
        if (current !== discovery.managedVersionContent) {
          // Version changed (pi update self); force fresh discovery.
          launchDiscovery.delete(discoveryKey);
          return resolvePiLaunch(settings, env, cwd);
        }
      } catch {
        /* File disappeared — fall through to fresh discovery. */
        launchDiscovery.delete(discoveryKey);
        return resolvePiLaunch(settings, env, cwd);
      }
    }
    sdkRoot = discovery.sdkRoot;
    managedInstallRoot = discovery.managedInstallRoot;
  } else {
    const target = cliPath ?? prefixArgs[0] ?? command;
    // Try managed-install first (captures installRoot for PI_MANAGED_INSTALL_ROOT).
    const managed = resolveManagedInstallSdk(target);
    if (managed) {
      sdkRoot = managed.sdkRoot;
      managedInstallRoot = managed.installRoot;
      managedVersionContent = managed.version;
    } else {
      sdkRoot = verifiedSdkRoot(target);
    }
  }
  if (!discovery) {
    if (launchDiscovery.size >= 32) launchDiscovery.clear();
    launchDiscovery.set(discoveryKey, {
      expires: Date.now() + 1000,
      command: pathExecutable,
      sdkRoot,
      managedInstallRoot,
      managedVersionContent,
    });
  }
  // Merge PI_MANAGED_INSTALL_ROOT into the launch env when the shim is a
  // managed install, matching pi-launcher.js's behaviour for both SDK host
  // and stock subprocess spawns.
  const managedEnvPatch: Record<string, string> = managedInstallRoot
    ? { PI_MANAGED_INSTALL_ROOT: managedInstallRoot }
    : {};
  const finalExtraEnv = Object.freeze({ ...choice.extraEnv, ...managedEnvPatch });
  const finalEnv = Object.freeze({ ...env, ...finalExtraEnv });
  return Object.freeze({
    ...choice,
    command,
    cliPath,
    prefixArgs: Object.freeze(prefixArgs),
    extraEnv: finalExtraEnv,
    env: finalEnv,
    cwd: launchCwd,
    sdkRoot,
    managedInstallRoot,
  });
}

/** Launch discovery is deliberately uncached and uses the captured environment/cwd. */
function resolveExecutable(executable: string, env: NodeJS.ProcessEnv, cwd: string): string {
  if (isAbsolute(executable) || /[/\\\\]/.test(executable)) {
    const path = resolve(cwd, executable);
    try {
      return realpathSync(path);
    } catch {
      return path;
    }
  }
  const pathValue = env.PATH ?? (process.platform === 'win32' ? env.Path : undefined) ?? '';
  const extensions =
    process.platform === 'win32'
      ? ['', ...(env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';')]
      : [''];
  for (const dir of pathValue.split(delimiter)) {
    for (const extension of extensions) {
      const candidate = resolve(cwd, dir, executable + extension);
      try {
        if (!statSync(candidate).isFile()) continue;
        accessSync(candidate, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
        return realpathSync(candidate);
      } catch {
        /* Continue PATH search. */
      }
    }
  }
  // Keep failure bound to this cwd, not a future PATH lookup after an async probe.
  return resolve(cwd, executable);
}

function choosePiLaunch(settings: PiRpcSettings): LaunchChoice {
  switch (settings.piSource) {
    case 'external':
      return externalSubprocess(settings);
    case 'inprocess': {
      const cli = vendoredCli() ?? managedCli();
      if (cli) {
        return {
          mode: 'worker',
          command: process.execPath,
          prefixArgs: [],
          cliPath: cli,
          extraEnv: {},
          usingBundled: true,
          label: `in-process worker (${cli})`,
        };
      }
      return externalSubprocess(settings);
    }
    case 'managed': {
      const managed = managedCli();
      if (managed) {
        return bundledSubprocess(managed, `managed Pi (${managed})`);
      }
      const vendored = vendoredCli();
      if (vendored) {
        return bundledSubprocess(vendored, `bundled Pi (managed not ready) (${vendored})`);
      }
      return externalSubprocess(settings);
    }
    case 'bundled':
    default: {
      const vendored = vendoredCli();
      if (vendored) {
        return bundledSubprocess(vendored, `bundled Pi (${vendored})`);
      }
      return externalSubprocess(settings);
    }
  }
}
