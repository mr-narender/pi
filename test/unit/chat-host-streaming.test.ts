import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { build } from 'esbuild';

async function managerFixture() {
  const compiled = await build({
    stdin: {
      contents:
        "export {ChatTabManager} from './src/editorTabs/tabManager'; export {ChatTabStateCache} from './src/editorTabs/sessionCache';",
      resolveDir: process.cwd(),
    },
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    external: ['vscode'],
  });
  const require = createRequire(`${process.cwd()}/package.json`);
  const module = { exports: {} as Record<string, any> };
  new Function('require', 'module', 'exports', compiled.outputFiles[0]!.text)(
    (id: string) =>
      id === 'vscode'
        ? {
            workspace: {
              getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }),
            },
            window: { showInformationMessage: async () => undefined },
          }
        : require(id),
    module,
    module.exports
  );
  const manager = Object.create(module.exports.ChatTabManager.prototype);
  const resource = { toString: () => 'pi-chat:/remote.chat' };
  const controller = { text: '', snapshot: { eventHistory: [] as any[] } };
  const deliveries: Array<{ text: string; active: boolean }> = [];
  manager.pendingRender = new Map();
  manager.pendingVisibleFlush = new Set();
  manager.lastObservedEvent = new WeakMap();
  manager.outboxBindings = new Map();
  manager.outbox = { dispose: async () => {} };
  manager.lastRenderAt = new Map();
  manager.lastActivityAt = new Map();
  manager.detectTurnCompletion = () => {};
  manager.identityForController = () => undefined;
  manager.uiState = { restoreControllerDraft: async () => {} };
  manager.sessions = { ownerOf: () => resource };
  manager.renderResourceNow = async (_resource: unknown, options?: { active?: boolean }) => {
    deliveries.push({ text: controller.text, active: options?.active ?? false });
  };
  manager.logger = { warn() {} };
  manager.follow = { dispose() {} };
  manager.controllerSubscriptions = [];
  manager.trackedControllers = new Set();
  manager.hosts = new Map();
  manager.unseenCompletions = new Set();
  manager.cache = { dispose() {} };
  manager.openChatsEmitter = { dispose() {} };
  return { manager, resource, controller, deliveries, Cache: module.exports.ChatTabStateCache };
}

test('interrupted text-only turn resends through the normal send path with an empty draft', async () => {
  const { manager, resource, controller } = await managerFixture();
  Object.assign(controller.snapshot, {
    messages: [
      { role: 'user', content: 'Retry me' },
      { role: 'assistant', stopReason: 'aborted', content: [{ type: 'text', text: 'Partial' }] },
    ],
    leafId: 'marker',
    connectionState: 'ready',
    state: {
      shutdownInterruptionEntries: [
        {
          type: 'message',
          id: 'user',
          parentId: null,
          message: { role: 'user', content: 'Retry me' },
        },
        {
          type: 'message',
          id: 'assistant',
          parentId: 'user',
          message: {
            role: 'assistant',
            stopReason: 'aborted',
            content: [{ type: 'text', text: 'Partial' }],
          },
        },
        {
          type: 'custom',
          id: 'marker',
          parentId: 'assistant',
          customType: 'vscode-pi.turn-interrupted',
          data: { reason: 'signal' },
        },
      ],
    },
  });
  const actions: unknown[] = [];
  manager.uiState = {
    getComposerStateForIdentity: async () => ({ draft: '' }),
    updateDraftForIdentity: async (_controller: unknown, _target: unknown, text: string) =>
      actions.push(text),
    setFocusForIdentity: async () => {},
  };
  manager.handleRequestSend = async (_resource: unknown, command: string) => actions.push(command);
  await manager.handleRestoreInterruptedPrompt(resource, { controller, target: {} });
  assert.deepEqual(actions, ['Retry me', 'prompt']);
});

test('interrupted turn never overwrites or sends an existing draft', async () => {
  const { manager, resource, controller } = await managerFixture();
  Object.assign(controller.snapshot, {
    messages: [
      { role: 'user', content: 'Retry me' },
      { role: 'assistant', stopReason: 'aborted', content: [{ type: 'text', text: 'Partial' }] },
    ],
    leafId: 'marker',
    connectionState: 'ready',
    state: {
      shutdownInterruptionEntries: [
        {
          type: 'message',
          id: 'user',
          parentId: null,
          message: { role: 'user', content: 'Retry me' },
        },
        {
          type: 'message',
          id: 'assistant',
          parentId: 'user',
          message: {
            role: 'assistant',
            stopReason: 'aborted',
            content: [{ type: 'text', text: 'Partial' }],
          },
        },
        {
          type: 'custom',
          id: 'marker',
          parentId: 'assistant',
          customType: 'vscode-pi.turn-interrupted',
          data: { reason: 'signal' },
        },
      ],
    },
  });
  manager.uiState = {
    getComposerStateForIdentity: async () => ({ draft: 'Keep me' }),
    updateDraftForIdentity: async () => assert.fail('must preserve draft'),
  };
  manager.handleRequestSend = async () => assert.fail('must not send');
  await manager.handleRestoreInterruptedPrompt(resource, { controller, target: {} });
});

test('interrupted attachment turn restores text but requires manual send', async () => {
  const { manager, resource, controller } = await managerFixture();
  Object.assign(controller.snapshot, {
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Review' },
          { type: 'image', data: 'image-fixture' },
        ],
      },
    ],
    connectionState: 'ready',
    state: {},
  });
  const restored: string[] = [];
  manager.uiState = {
    getComposerStateForIdentity: async () => ({ draft: '' }),
    updateDraftForIdentity: async (_controller: unknown, _target: unknown, text: string) =>
      restored.push(text),
    setFocusForIdentity: async () => {},
  };
  manager.handleRequestSend = async () => assert.fail('must reattach before sending');
  manager.renderResource = async () => {};
  await manager.handleRestoreInterruptedPrompt(resource, { controller, target: {} });
  assert.deepEqual(restored, ['Review']);
});

test('manager disposal returns one promise that waits for the deferred cache flush', async () => {
  const { manager, Cache } = await managerFixture();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const persisted: unknown[] = [];
  manager.cache = new Cache({
    workspaceState: {
      get: (_key: string, fallback: unknown) => fallback,
      update: async (_key: string, value: unknown) => {
        await held;
        persisted.push(value);
      },
    },
  });
  await manager.cache.set({ resource: 'chat', lastKnownTitle: 'Latest frame' }, { defer: true });
  let followDisposals = 0;
  manager.follow.dispose = () => {
    followDisposals++;
  };
  const first = manager.dispose();
  const second = manager.dispose();
  let settled = false;
  void Promise.resolve(first).then(() => {
    settled = true;
  });
  try {
    for (let i = 0; i < 5; i++) await Promise.resolve();
    assert.equal(settled, false, 'normal shutdown must await the pending storage update');
    assert.equal(first, second, 'subscription disposal and deactivate share one operation');
    assert.equal(followDisposals, 1);
  } finally {
    release();
    await Promise.all([first, second]);
  }
  assert.equal(persisted.length, 2);
  assert.equal((persisted[0] as any).chat.lastKnownTitle, 'Latest frame');
  assert.equal(manager.cache.get('chat'), undefined);
});

test('ready draft renders defer persistence while a genuine working-to-settled transition flushes', async (t) => {
  const { manager, resource, controller, Cache } = await managerFixture();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  delete manager.renderResourceNow;
  const writes: unknown[] = [];
  manager.cache = new Cache({
    workspaceState: {
      get: (_key: string, fallback: unknown) => fallback,
      update: async (_key: string, value: unknown) => {
        writes.push(value);
      },
    },
  });
  let snapshot = {
    sequence: 0,
    title: 'Owned chat',
    connectionState: 'ready',
    bindingState: 'current',
    isStreaming: false,
    messages: [],
    pendingImages: [],
    draft: '',
  };
  manager.context = {
    workspaceState: {
      get: (_key: string) => undefined,
      update: async () => {},
    },
  };
  manager.pendingVisibleFlush = new Set();
  manager.contextForResource = () => ({ controller, resource, target: {} });
  manager.remoteSharing = { sharingInfoFor: () => undefined };
  manager.buildSnapshot = async () => snapshot;
  manager.titleForContext = () => 'Owned chat';
  manager.keyFor = () => resource.toString();
  manager.follow.handleSnapshot = () => {};
  const posted: string[] = [];
  manager.hosts.set(resource.toString(), {
    panel: { visible: false },
    dispose() {},
    postSnapshot: async (value: typeof snapshot) => {
      posted.push(value.connectionState);
    },
  });
  manager.outboxAcks = new Map();
  manager.extensionUiDraftAcks = new Map();
  try {
    for (let i = 0; i < 30; i++) {
      snapshot = { ...snapshot, sequence: i, draft: `typing ${i}` };
      await manager.renderResourceNow(resource);
    }
    assert.equal(
      writes.length,
      0,
      'ready composer snapshots must not serialize every cached transcript'
    );
    assert.equal(manager.cache.get(resource).lastSnapshot.sequence, 29);
    snapshot = { ...snapshot, connectionState: 'busy', isStreaming: true };
    await manager.renderResourceNow(resource);
    assert.equal(writes.length, 0);
    snapshot = { ...snapshot, connectionState: 'ready', isStreaming: false };
    await manager.renderResourceNow(resource);
    assert.equal(writes.length, 2, 'working-to-settled transition flushes immediately');
    assert.deepEqual(
      posted.slice(-2),
      ['busy', 'ready'],
      'hidden state/completion snapshots are still posted'
    );
    snapshot = { ...snapshot, sequence: 31, draft: 'new draft' };
    await manager.renderResourceNow(resource);
    assert.equal(writes.length, 2, 'later ready frames return to bounded persistence');
    t.mock.timers.tick(500);
    for (let i = 0; i < 12; i++) await Promise.resolve();
    assert.equal(writes.length, 4);
  } finally {
    await manager.dispose();
  }
});

test('continuous remote controller deltas deliver intermediate snapshots before the turn ends', async (t) => {
  const { manager, controller, deliveries } = await managerFixture();
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const pending: Promise<void>[] = [];
  for (let i = 0; i < 30; i++) {
    controller.text += 'delta ';
    pending.push(manager.onControllerChanged(controller));
    await Promise.resolve();
    t.mock.timers.tick(10);
    await Promise.resolve();
    if (i === 15) {
      assert.ok(deliveries.length >= 3, 'continuous input must not postpone every trailing frame');
      assert.ok(deliveries.at(-1)!.text.length > 'delta '.length);
      assert.ok(deliveries.at(-1)!.text.length < 30 * 'delta '.length);
    }
  }
  t.mock.timers.tick(50);
  await Promise.all(pending);
  assert.equal(deliveries.at(-1)!.text, controller.text);
  assert.equal(manager.pendingRender.size, 0);
});

test('interrupted prompt restoration with pending attachments never sends or overwrites a draft', async () => {
  const { manager, resource, controller, deliveries } = await managerFixture();
  Object.assign(controller.snapshot, {
    connectionState: 'ready',
    state: {},
    messages: [{ role: 'user', content: 'Restore me' }],
  });
  const restored: string[] = [];
  let draft = '';
  manager.uiState = {
    getComposerStateForIdentity: async () => ({ draft, pendingImages: [{ id: 'pending' }] }),
    updateDraftForIdentity: async (_controller: unknown, _target: unknown, text: string) => {
      restored.push(text);
    },
    setFocusForIdentity: async () => {},
  };
  await manager.handleRestoreInterruptedPrompt(resource, { controller, target: {} });
  assert.deepEqual(restored, ['Restore me']);
  assert.equal(deliveries.length, 1);
  draft = 'Keep me';
  await manager.handleRestoreInterruptedPrompt(resource, { controller, target: {} });
  assert.deepEqual(restored, ['Restore me']);
});

test('hidden deltas coalesce but state changes and completion still render', async () => {
  const { manager, resource, controller, deliveries } = await managerFixture();
  const panel = { visible: false };
  manager.hosts.set(resource.toString(), { panel });
  const change = async (type: string, deltaType?: string) => {
    controller.snapshot.eventHistory.push({
      type,
      data: { assistantMessageEvent: { type: deltaType } },
    });
    await manager.onControllerChanged(controller);
  };
  await change('message_update', 'text_delta');
  await change('message_update', 'thinking_delta');
  await change('tool_execution_update');
  assert.equal(deliveries.length, 0);
  assert.equal(manager.pendingVisibleFlush.size, 1);
  await change('tool_execution_start');
  await change('agent_end');
  assert.equal(deliveries.length, 2);
  // Non-event state changes must render even when lastEventType is stale.
  await manager.onControllerChanged(controller);
  assert.equal(deliveries.length, 3);
});

test('hidden tab reveal flushes once for active and unfocused visible tabs', async () => {
  for (const active of [true, false]) {
    const { manager, resource, deliveries } = await managerFixture();
    const host = { resource, panel: { visible: true } };
    manager.pendingVisibleFlush.add(resource.toString());
    manager.openChatsEmitter.fire = () => {};
    manager.clearViewedCompletions = () => {};
    manager.activateResource = async () => manager.renderResource(resource, { active: true });
    await manager.onHostViewStateChanged(host, active);
    assert.equal(deliveries.length, 1);
    assert.equal(manager.pendingVisibleFlush.size, 0);
    if (!active) {
      await manager.onHostViewStateChanged(host, false);
      assert.equal(deliveries.length, 1);
    }
  }
});

test('coalesced snapshots retain active requests and settle every caller', async (t) => {
  const { manager, resource, controller, deliveries } = await managerFixture();
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  await manager.renderResource(resource);
  const first = manager.renderResource(resource, { active: true });
  const second = manager.renderResource(resource);
  controller.text = 'newest';
  t.mock.timers.tick(50);
  await Promise.all([first, second]);
  assert.deepEqual(deliveries.at(-1), { text: 'newest', active: true });
});

test('disposing the manager cancels queued frames and settles their callers', async (t) => {
  const { manager, resource, deliveries } = await managerFixture();
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  await manager.renderResource(resource);
  let settled = false;
  const pending = manager.renderResource(resource).then(() => {
    settled = true;
  });
  manager.dispose();
  for (let i = 0; i < 5; i++) await Promise.resolve();
  assert.equal(settled, true);
  t.mock.timers.tick(100);
  await pending;
  assert.equal(deliveries.length, 1);
  assert.equal(manager.pendingRender.size, 0);
});

test('a failed trailing render settles callers and allows the next frame', async (t) => {
  const { manager, resource, deliveries } = await managerFixture();
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  await manager.renderResource(resource);
  const render = manager.renderResourceNow;
  let warnings = 0;
  manager.logger.warn = () => warnings++;
  manager.renderResourceNow = async () => {
    throw new Error('failed');
  };
  const pending = manager.renderResource(resource);
  t.mock.timers.tick(50);
  await pending;
  assert.equal(warnings, 1);
  assert.equal(manager.pendingRender.size, 0);
  manager.renderResourceNow = render;
  const retry = manager.renderResource(resource);
  t.mock.timers.tick(50);
  await retry;
  assert.equal(deliveries.length, 2);
});
