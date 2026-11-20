import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { transform } from 'esbuild';

async function startupFixture(autoStart: boolean) {
  const source = readFileSync('src/extension.ts', 'utf8');
  const start = source.indexOf('  const workers = getSettings().runtimeWorkers;');
  const end = source.indexOf('  // Record the loaded build', start);
  assert.ok(start >= 0 && end > start);
  const compiled = await transform(
    `function run() {${source.slice(start, end)}; return warmSidebar;}`,
    { loader: 'ts' }
  );
  const warmed: any[] = [];
  const timers: { callback: () => void; delay: number }[] = [];
  let roots = 0;
  const context = {
    extensionPath: '/extension',
    globalStorageUri: { fsPath: '/tmp/pi-extension/activation-neutral' },
    subscriptions: [] as any[],
  };
  const run = new Function(
    'vscode',
    'context',
    'getSettings',
    'initSharedPiHost',
    'disposeSharedPiHost',
    'resolvePiRoot',
    'piLaunchEnvironment',
    'logger',
    'setTimeout',
    'clearTimeout',
    `${compiled.code}; return run;`
  )(
    {
      Uri: { joinPath: () => ({ fsPath: '/tmp/pi-extension/activation-neutral/cache' }) },
      workspace: {
        get workspaceFolders() {
          throw new Error('activation warmup must not inspect folders');
        },
      },
    },
    context,
    () => ({ autoStart, sharedRuntime: true, piSource: 'managed', runtimeWorkers: 'auto' }),
    () => ({ warmPool: (...args: any[]) => warmed.push(args) }),
    () => {},
    async () => {
      roots++;
      return '/sdk';
    },
    () => ({}),
    { warn: assert.fail },
    (callback: () => void, delay: number) => {
      timers.push({ callback, delay });
      return 1;
    },
    () => {}
  );
  return { warm: run() as () => void, warmed, timers, roots: () => roots };
}

for (const autoStart of [false, true]) {
  test(`activation never warms a folder or starts a session (autoStart=${autoStart})`, async () => {
    const fixture = await startupFixture(autoStart);
    assert.equal(fixture.roots(), 0);
    assert.deepEqual(fixture.warmed, []);
    assert.equal(fixture.timers.length, 0);
    fixture.warm();
    fixture.warm();
    assert.equal(fixture.timers.length, 1, 'sidebar reveal is one-shot and debounced');
    assert.equal(fixture.timers[0]!.delay, autoStart ? 0 : 100);
    fixture.timers[0]!.callback();
    // SDK resolution and neutral storage mkdir are async, with no session open.
    for (let i = 0; i < 100 && !fixture.warmed.length; i++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.deepEqual(fixture.warmed, [
      [undefined, { cwd: '/tmp/pi-extension/activation-neutral', sdkRoot: '/sdk', env: {} }],
    ]);
  });
}

test('restored tabs own folder startup; no eager first-folder controller or session scan remains', () => {
  const source = readFileSync('src/extension.ts', 'utf8');
  assert.doesNotMatch(
    source,
    /await controller\.start\(\);\s*refreshViews\(\);\s*}\s*}\s*export async function deactivate/
  );
  assert.doesNotMatch(source, /void recentSessions\.refresh\(\);/);
  assert.match(readFileSync('src/process/supervisor.ts', 'utf8'), /sharedHost\.warmPool\(cwd, \{/);
  assert.match(
    readFileSync('src/editorTabs/tabManager.ts', 'utf8'),
    /this\.onChatSurface\?\.\(\);/
  );
});
