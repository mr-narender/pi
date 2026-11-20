import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createNativeFixture, spawnNativeSdkHost } from '../helpers/nativeFixture';
import { createWebviewSnapshot } from '../../src/webview/model';
import { createInitialControllerState } from '../../src/state/types';
import { createEmptyComposerState } from '../../src/webview/composer';
import { selectActiveBranchMessages } from '../../src/sessions/activeBranch';

async function until(predicate: () => boolean) {
  const deadline = Date.now() + 10000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'shutdown fixture timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

for (const ending of ['stdin-closed', 'signal', 'host-shutdown', 'user-stop'] as const) {
  test(
    `interrupted-shutdown: ${ending} persists only involuntary interruption`,
    { timeout: 30000 },
    async (t) => {
      const fixture = await createNativeFixture('compact');
      const children: Awaited<ReturnType<typeof spawnNativeSdkHost>>['child'][] = [];
      const launch = async () => {
        const host = await spawnNativeSdkHost(fixture, 'shared');
        const child = host.child;
        children.push(child);
        const records: any[] = [];
        let buffer = '';
        child.stdout!.on('data', (chunk) => {
          buffer += chunk;
          let index;
          while ((index = buffer.indexOf('\n')) >= 0) {
            records.push(JSON.parse(buffer.slice(0, index)).d);
            buffer = buffer.slice(index + 1);
          }
        });
        child.stderr!.resume();
        const send = (d: object) => child.stdin!.write(JSON.stringify({ k: 'one', d }) + '\n');
        send(host.open);
        await until(() => records.some((d) => d.command === 'open'));
        assert.equal(records.find((d) => d.command === 'open').success, true);
        let nextId = 0;
        const request = async (type: string, extra = {}) => {
          const id = String(++nextId);
          send({ type, id, ...extra });
          await until(() => records.some((d) => d.id === id && d.type === 'response'));
          const response = records.find((d) => d.id === id && d.type === 'response');
          assert.equal(response.success, true, `${type}: ${response.error}`);
          return response.data;
        };
        return { child, send, request, records };
      };
      try {
        const file = join(fixture.cwd, 'shutdown-session.jsonl');
        await writeFile(
          file,
          JSON.stringify({
            type: 'session',
            version: 3,
            id: 'shutdown',
            timestamp: '2024-01-01T00:00:00.000Z',
            cwd: fixture.cwd,
          }) + '\n'
        );
        const first = await launch();
        await first.request('switch_session', { sessionPath: file });
        fixture.setSummaryOutcome('stream-hold');
        await first.request('prompt', { message: 'Long fixture stream' });
        await until(() =>
          first.records.some(
            (d) => d.type === 'message_update' && d.assistantMessageEvent?.type === 'text_delta'
          )
        );
        if (ending === 'user-stop') await first.request('abort');
        const exited = once(first.child, 'exit');
        const started = performance.now();
        if (ending === 'signal') first.child.kill('SIGTERM');
        else if (ending === 'host-shutdown') {
          first.send({ type: 'close' });
          await until(() => first.records.some((d) => d.type === 'agent_settled'));
          first.child.stdin!.end();
        } else first.child.stdin!.end();
        await exited;
        const shutdownMs = performance.now() - started;
        t.diagnostic(`${ending}: shutdown and persisted JSONL in ${shutdownMs.toFixed(1)}ms`);
        assert.ok(shutdownMs < 10000, 'durable shutdown completes promptly');
        const saved = (await readFile(file, 'utf8'))
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line));
        const markers = saved.filter((entry) => entry.customType === 'vscode-pi.turn-interrupted');
        assert.equal(markers.length, ending === 'user-stop' ? 0 : 1);
        if (markers.length) {
          assert.equal(markers[0].type, 'custom');
          assert.equal(markers[0].data.reason, ending);
          assert.ok(Number.isFinite(Date.parse(markers[0].data.at)));
          assert.equal(
            saved.find((entry) => entry.id === markers[0].parentId).message.stopReason,
            'aborted'
          );
        }
        const second = await launch();
        await second.request('switch_session', { sessionPath: file });
        const state = await second.request('get_state');
        const messages = selectActiveBranchMessages<any>(saved, Infinity, state.leafId);
        assert.equal(messages.at(-1).stopReason, 'aborted');
        assert.equal(
          messages.some((message) => message.customType === 'vscode-pi.turn-interrupted'),
          false
        );
        assert.ok(
          messages.at(-1).content.some((block: any) => block.text === 'OWNED PARTIAL REPLY')
        );
        const reconciled = createInitialControllerState('fixture', fixture.cwd);
        reconciled.connectionState = 'ready';
        reconciled.state = state;
        reconciled.messages = messages;
        reconciled.leafId = state.leafId;
        // Like reconcile(), the entry tree remains lazy; get_state supplies metadata.
        assert.deepEqual(reconciled.entries, []);
        const interruption = createWebviewSnapshot(reconciled, 1, {
          composer: createEmptyComposerState(),
          isTrusted: true,
          folders: [],
        }).interruptedTurn;
        assert.equal(interruption?.kind, ending === 'user-stop' ? undefined : 'incompleteReply');
        if (interruption) {
          assert.equal(interruption.lastUserMessage, 'Long fixture stream');
          assert.equal(interruption.canResend, true);
        }
        const context = await second.request('get_messages');
        assert.equal(
          context.messages.some(
            (message: any) => message.customType === 'vscode-pi.turn-interrupted'
          ),
          false
        );
        const stopped = once(second.child, 'exit');
        second.child.stdin!.end();
        await stopped;
      } finally {
        for (const child of children) {
          if (child.exitCode === null && child.signalCode === null) {
            const stopped = once(child, 'exit');
            child.kill('SIGKILL');
            await stopped;
          }
        }
        const denied = await readFile(fixture.networkLog, 'utf8');
        await fixture.dispose();
        assert.equal(denied.trim(), '', 'no forbidden network requests');
      }
    }
  );
}
