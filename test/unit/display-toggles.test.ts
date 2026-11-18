import test from 'node:test';
import assert from 'node:assert/strict';
import { createInitialControllerState } from '../../src/state/types';
import { createWebviewSnapshot } from '../../src/webview/model';
import { createEmptyComposerState } from '../../src/webview/composer';
import { renderChatApp } from '../../src/webview/render';
import manifest from '../../package.json';

function fixture() {
  const state = createInitialControllerState('work', '/tmp/work');
  const snapshot = () =>
    createWebviewSnapshot(state, 1, {
      composer: createEmptyComposerState(),
      isTrusted: true,
      folders: [],
    });
  return { state, snapshot };
}

test('snapshot defaults showToolDetails and showThinking to undefined', () => {
  const { snapshot } = fixture();
  const s = snapshot();
  assert.equal(s.showToolDetails, undefined);
  assert.equal(s.showThinking, undefined);
});

test('display toolbar defaults hidden and reflects both persisted modes', () => {
  const { snapshot } = fixture();
  const s = snapshot();
  const hidden = renderChatApp(s);
  assert.doesNotMatch(hidden, /data-show-tool-details|data-show-thinking/);
  assert.match(hidden, /data-action="toggleToolDetails"[^>]+aria-pressed="false"/);
  const shown = renderChatApp({ ...s, showToolDetails: true, showThinking: true });
  assert.match(shown, /data-show-tool-details data-show-thinking/);
  assert.match(shown, /data-action="toggleThinking"[^>]+aria-pressed="true"/);
});

test('display keybindings avoid AltGr and file-open keys and stay scoped to Pi', () => {
  for (const [command, key] of [
    ['toggleToolDetails', 'o'],
    ['toggleThinking', 't'],
    ['toggleDetailMode', 'd'],
  ]) {
    const binding = manifest.contributes.keybindings.find(
      (item) => item.command === `piRpc.${command}`
    );
    assert.equal(binding?.key, `ctrl+k alt+${key}`);
    assert.equal(binding?.mac, `cmd+alt+${key}`);
    assert.equal(
      binding?.when,
      "activeCustomEditorId == 'piRpc.chatEditor' || focusedView == 'piRpc.chat'"
    );
  }
});

test('snapshot interruptedTurn is undefined when no messages', () => {
  const { snapshot } = fixture();
  const s = snapshot();
  assert.equal(s.interruptedTurn, undefined);
});

test('ToolRunState type allows parentToolCallId', () => {
  const { state } = fixture();
  state.tools = [{ id: 'x', name: 'bash', startedAt: 1, parentToolCallId: 'parent-1' }];
  assert.equal(state.tools[0]!.parentToolCallId, 'parent-1');
});
