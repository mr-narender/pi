import test from 'node:test';
import assert from 'node:assert/strict';
import { createInitialControllerState } from '../../src/state/types';
import { createWebviewSnapshot } from '../../src/webview/model';
import { createEmptyComposerState } from '../../src/webview/composer';
import { renderChatApp, renderActivityContent } from '../../src/webview/render';

function fixture() {
  const state = createInitialControllerState('work', '/tmp/work');
  state.connectionState = 'busy';
  state.state = { isStreaming: true };
  const snapshot = () =>
    createWebviewSnapshot(state, 1, {
      composer: createEmptyComposerState(),
      isTrusted: true,
      folders: [],
    });
  return { state, snapshot };
}

test('live delegation is visible before any children report arrives', () => {
  const { state, snapshot } = fixture();
  state.tools = [
    { id: 'parent', name: 'delegate_tasks', startedAt: 1 },
    { id: 'child', name: 'bash', startedAt: 2, parentToolCallId: 'parent' },
  ];
  state.messages = [
    {
      role: 'assistant',
      content: [{ type: 'toolCall', id: 'parent', name: 'delegate_tasks', arguments: {} }],
    },
  ];
  const s = snapshot();
  assert.match(renderActivityContent(s), /Delegated tools/);
  const html = renderChatApp(s);
  assert.match(html, /Delegated tools/);
  assert.match(html, /Individual agent attribution unavailable/);
  assert.doesNotMatch(html, /id="delegated-[^"]+" open/);
  assert.deepEqual(s.activity?.agents, []);
  assert.equal(s.activity?.delegatedTools?.[0]?.tools[0]?.name, 'bash');
});

test('nested parent links render recursively beneath the delegating tool row', () => {
  const { state, snapshot } = fixture();
  state.tools = [
    { id: 'parent', name: 'subagent', args: { agent: 'scout', task: 'Inspect' }, startedAt: 1 },
    { id: 'nested', name: 'subagent', startedAt: 2, parentToolCallId: 'parent' },
    { id: 'leaf', name: 'read', startedAt: 3, endedAt: 4, parentToolCallId: 'nested' },
  ];
  state.messages = [
    {
      role: 'assistant',
      content: [{ type: 'toolCall', id: 'parent', name: 'subagent', arguments: {} }],
    },
  ];
  const html = renderChatApp(snapshot());
  assert.match(html, /Delegated tools · subagent · scout/);
  assert.match(html, /delegated-work-[^\"]+-parent/);
  assert.match(html, /Parent call: nested/);
  assert.match(html, /<span>read<\/span><span class="muted">completed/);
});

test('activity tools include parentToolCallId when present', () => {
  const { state, snapshot } = fixture();
  state.tools = [
    { id: 'delegate-1', name: 'delegate_tasks', startedAt: 1 },
    { id: 'child-1', name: 'bash', startedAt: 2, parentToolCallId: 'delegate-1' },
  ];
  const s = snapshot();
  const childTool = s.activity?.tools.find((t) => t.id === 'child-1');
  assert.ok(childTool);
  assert.equal(childTool.parentToolCallId, 'delegate-1');
  const parentTool = s.activity?.tools.find((t) => t.id === 'delegate-1');
  assert.ok(parentTool);
  assert.equal(parentTool.parentToolCallId, undefined);
});

test('delegated tools group live events by parent without attributing them to reported agents', () => {
  const { state, snapshot } = fixture();
  // Simulate delegate_tasks with a child status in partial result
  state.tools = [
    {
      id: 'delegate-1',
      name: 'delegate_tasks',
      startedAt: 1,
      partialResult: {
        details: {
          parentToolCallId: 'delegate-1',
          children: [
            {
              id: 'agent-a',
              parentToolCallId: 'delegate-1',
              role: 'worker',
              status: 'running',
            },
          ],
        },
      },
    },
    { id: 'child-1', name: 'read', startedAt: 2, parentToolCallId: 'delegate-1' },
  ];
  // The delegate_tasks call must appear in the assistant message blocks.
  state.messages = [
    {
      role: 'assistant',
      timestamp: 1,
      content: [
        {
          type: 'toolCall',
          id: 'delegate-1',
          name: 'delegate_tasks',
          arguments: '{}',
        },
      ],
    },
  ];
  const s = snapshot();
  const agents = s.activity?.agents ?? [];
  assert.ok(agents.length > 0, 'Should have at least one reported agent');
  const agent = agents[0]!;
  assert.equal(agent.toolCallId, 'delegate-1');
  assert.equal('childTools' in agent, false);
  const group = s.activity?.delegatedTools?.[0];
  assert.equal(group?.toolCallId, 'delegate-1');
  assert.equal(group?.tools.length, 1);
  assert.equal(group?.tools[0]?.id, 'child-1');
  assert.equal(group?.tools[0]?.name, 'read');
  assert.equal(group?.tools[0]?.status, 'running');
});
