import test from 'node:test';
import assert from 'node:assert/strict';
import { detectInterruptedTurn } from '../../src/webview/model';

test('no messages → no interruption', () => {
  assert.equal(detectInterruptedTurn([], 'ready', false), undefined);
});

test('last message is user with no reply → noReply', () => {
  const messages = [{ role: 'user', content: 'Hello' }];
  const result = detectInterruptedTurn(messages, 'ready', false);
  assert.equal(result?.kind, 'noReply');
  assert.equal(result?.lastUserMessage, 'Hello');
  assert.equal(result?.canResend, true);
});

test('last message is assistant with stopReason → no interruption', () => {
  const messages = [
    { role: 'user', content: 'Hello' },
    { role: 'assistant', content: [{ type: 'text', text: 'Hi' }], stopReason: 'stop' },
  ];
  assert.equal(detectInterruptedTurn(messages, 'ready', false), undefined);
});

test('last message is assistant without stopReason → incompleteReply', () => {
  const messages = [
    { role: 'user', content: 'Hello' },
    { role: 'assistant', content: [{ type: 'text', text: 'Hi' }] },
  ];
  const result = detectInterruptedTurn(messages, 'ready', false);
  assert.equal(result?.kind, 'incompleteReply');
  assert.equal(result?.lastUserMessage, 'Hello');
});

test('native text blocks restore text only, never image data', () => {
  const result = detectInterruptedTurn(
    [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Review this' },
          { type: 'image', data: 'not-restorable', mimeType: 'image/png' },
          { type: 'text', text: 'carefully' },
        ],
      },
    ],
    'ready',
    false
  );
  assert.equal(result?.lastUserMessage, 'Review this\ncarefully');
  assert.equal(result?.canResend, false);
});

test('attachment metadata requires manual reattachment even with string content', () => {
  const result = detectInterruptedTurn(
    [{ role: 'user', content: 'Review', attachments: [{ name: 'file.txt' }] }],
    'ready',
    false
  );
  assert.equal(result?.canResend, false);
});

test('streaming → no interruption detected', () => {
  const messages = [{ role: 'user', content: 'Hello' }];
  assert.equal(detectInterruptedTurn(messages, 'ready', true), undefined);
});

test('busy → no interruption detected', () => {
  const messages = [{ role: 'user', content: 'Hello' }];
  assert.equal(detectInterruptedTurn(messages, 'busy', false), undefined);
});

test('connecting → no interruption detected', () => {
  const messages = [{ role: 'user', content: 'Hello' }];
  assert.equal(detectInterruptedTurn(messages, 'starting', false), undefined);
});

test('unmatched tool call remains interrupted until its matching result arrives', () => {
  const messages = [
    { role: 'user', content: 'Inspect the code' },
    {
      role: 'assistant',
      stopReason: 'toolUse',
      content: [{ type: 'toolCall', id: 'read-1', name: 'read' }],
    },
  ];
  assert.equal(detectInterruptedTurn(messages, 'ready', false)?.kind, 'incompleteReply');
  assert.equal(
    detectInterruptedTurn(
      [...messages, { role: 'toolResult', toolCallId: 'unrelated', content: 'File content' }],
      'ready',
      false
    )?.lastUserMessage,
    'Inspect the code'
  );
});

test('completed conversation → no interruption', () => {
  const messages = [
    { role: 'user', content: 'How are you?' },
    { role: 'assistant', content: [{ type: 'text', text: 'Good' }], stopReason: 'stop' },
    { role: 'user', content: 'Great!' },
    { role: 'assistant', content: [{ type: 'text', text: 'Thanks' }], stopReason: 'stop' },
  ];
  assert.equal(detectInterruptedTurn(messages, 'ready', false), undefined);
});

for (const role of ['toolResult', 'tool_result', 'tool']) {
  test(`completed tool results (${role}) may end a turn without a final assistant reply`, () => {
    const messages = [
      { role: 'user', content: 'Finish the task' },
      {
        role: 'assistant',
        stopReason: 'toolUse',
        content: [
          { type: 'toolCall', id: 'one', name: 'read' },
          { type: 'toolCall', id: 'two', name: 'terminate' },
        ],
      },
      { role, toolCallId: 'one', content: 'done' },
    ];
    assert.equal(detectInterruptedTurn(messages, 'ready', false)?.kind, 'incompleteReply');
    assert.equal(
      detectInterruptedTurn(
        [...messages, { role, toolCallId: 'two', content: 'done' }],
        'ready',
        false
      ),
      undefined
    );
  });
}

test('toolUse without tool calls is complete and earlier turns do not leak interruption', () => {
  assert.equal(
    detectInterruptedTurn(
      [
        { role: 'assistant', stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'old' }] },
        { role: 'user', content: 'New turn' },
        { role: 'assistant', stopReason: 'toolUse', content: [] },
      ],
      'ready',
      false
    ),
    undefined
  );
});

test('last assistant without stopReason remains interrupted even after tool results', () => {
  assert.equal(
    detectInterruptedTurn(
      [
        { role: 'user', content: 'Read' },
        { role: 'assistant', content: [{ type: 'toolCall', id: 'one' }] },
        { role: 'toolResult', toolCallId: 'one', content: 'done' },
      ],
      'ready',
      false
    )?.kind,
    'incompleteReply'
  );
});
