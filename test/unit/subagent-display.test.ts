import test from 'node:test';
import assert from 'node:assert/strict';
import { reduceEvent } from '../../src/state/reducer';
import { createInitialControllerState } from '../../src/state/types';
import type { RpcEvent } from '../../src/rpc/protocol';

function ev(value: Record<string, unknown>): RpcEvent {
  return value as unknown as RpcEvent;
}

test('tool_execution_start stores parentToolCallId when present', () => {
  let state = createInitialControllerState('w', '/tmp');
  state = reduceEvent(
    state,
    ev({
      type: 'tool_execution_start',
      toolCallId: 'child-1',
      toolName: 'bash',
      parentToolCallId: 'delegate-abc',
    })
  );
  assert.equal(state.tools.length, 1);
  assert.equal(state.tools[0]!.id, 'child-1');
  assert.equal(state.tools[0]!.parentToolCallId, 'delegate-abc');
});

test('tool_execution_start omits parentToolCallId when absent', () => {
  let state = createInitialControllerState('w', '/tmp');
  state = reduceEvent(
    state,
    ev({ type: 'tool_execution_start', toolCallId: 'top-1', toolName: 'read' })
  );
  assert.equal(state.tools[0]!.parentToolCallId, undefined);
});

test('child tools survive update and end events', () => {
  let state = createInitialControllerState('w', '/tmp');
  state = reduceEvent(
    state,
    ev({
      type: 'tool_execution_start',
      toolCallId: 'child-1',
      toolName: 'bash',
      parentToolCallId: 'delegate-abc',
    })
  );
  state = reduceEvent(
    state,
    ev({
      type: 'tool_execution_update',
      toolCallId: 'child-1',
      partialResult: { content: 'partial' },
    })
  );
  assert.equal(state.tools[0]!.parentToolCallId, 'delegate-abc');
  state = reduceEvent(
    state,
    ev({
      type: 'tool_execution_end',
      toolCallId: 'child-1',
      result: { content: 'done' },
    })
  );
  assert.equal(state.tools[0]!.parentToolCallId, 'delegate-abc');
  assert.ok(state.tools[0]!.endedAt);
});
