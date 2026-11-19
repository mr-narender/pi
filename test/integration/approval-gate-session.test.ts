import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createNativeFixture,
  prepareNativeApprovalGate,
  spawnNativeSdkHost,
} from '../helpers/nativeFixture';
import { spawnRealPi, shutdown } from '../helpers/rpc';
import { assertApprovalGateActive } from '../../src/review/approvalGateSettings';

async function until(predicate: () => boolean) {
  const deadline = Date.now() + 15000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'approval gate fixture timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

for (const mode of ['stock', 'shared', 'shared-project', 'shared-missing'] as const) {
  test(
    mode === 'shared-missing'
      ? 'approval gate shared-missing: missing packaged gate blocks prompt admission'
      : `approval gate ${mode}: explicit gate allows/denies real edits and isolates concurrent policies`,
    { timeout: 45000 },
    async () => {
      const fixture = await createNativeFixture('compact');
      await prepareNativeApprovalGate(fixture, mode === 'shared-missing');
      let stock: Awaited<ReturnType<typeof spawnRealPi>> | undefined;
      let host: Awaited<ReturnType<typeof spawnNativeSdkHost>> | undefined;
      try {
        let stderr = '';
        let checkConcurrentSession: (() => Promise<void>) | undefined;
        let prompt: (message: string) => Promise<unknown>;
        let newSession: () => Promise<unknown>;
        let commands: () => Promise<any>;
        let answer: (request: any, choice: string) => void;
        const requests: any[] = [];
        const events: any[] = [];
        if (mode === 'stock') {
          stock = await spawnRealPi([], fixture);
          stock.client.onExtensionUi((request) => {
            requests.push(request);
          });
          stock.client.onEvent((event) => {
            events.push(event);
          });
          prompt = (message) => stock!.client.prompt(message);
          newSession = () => stock!.client.newSession();
          commands = () => stock!.client.getCommands();
          answer = (request, choice) => {
            void stock!.client.respondExtensionUi({ id: request.id, value: choice });
          };
        } else {
          host = await spawnNativeSdkHost(
            fixture,
            'shared',
            mode === 'shared-project' ? 'project' : 'default'
          );
          let buffer = '';
          let seq = 0;
          const pending = new Map<string, (result: any) => void>();
          host.child.stdout!.on('data', (chunk) => {
            buffer += chunk;
            let index;
            while ((index = buffer.indexOf('\n')) >= 0) {
              const { k, d } = JSON.parse(buffer.slice(0, index));
              buffer = buffer.slice(index + 1);
              if (d.type === 'response') {
                pending.get(d.id ?? 'open')?.(d);
                pending.delete(d.id ?? 'open');
              } else if (d.type === 'extension_ui_request') requests.push({ ...d, sessionKey: k });
              else events.push({ ...d, sessionKey: k });
            }
          });
          host.child.stderr!.on('data', (chunk) => {
            stderr += chunk;
          });
          const request = async (command: any, key = 'one') => {
            const id = command.type === 'open' ? undefined : String(++seq);
            const result = new Promise<any>((resolve, reject) => {
              const timer = setTimeout(
                () => reject(new Error(`approval fixture ${key}:${command.type} timed out`)),
                15000
              );
              pending.set(id ?? 'open', (reply) => {
                clearTimeout(timer);
                resolve(reply);
              });
            });
            host!.child.stdin!.write(JSON.stringify({ k: key, d: { ...command, id } }) + '\n');
            const reply = await result;
            assert.equal(reply.success, true, reply.error);
            return reply.data;
          };
          await request(host.open);
          checkConcurrentSession = async () => {
            const cwd = join(fixture.cwd, 'automatic');
            await mkdir(join(cwd, '.pi'), { recursive: true });
            await writeFile(join(cwd, '.pi/pi-vscode-manual-mode.json'), '{"enabled":false}');
            await writeFile(join(cwd, 'owned-edit.txt'), 'ORIGINAL');
            await request({ ...host!.open, cwd }, 'two');
            await request({ type: 'prompt', message: 'Automatic scripted edit' }, 'two');
            await until(() =>
              events.some((event) => event.sessionKey === 'two' && event.type === 'agent_end')
            );
            assert.equal(await readFile(join(cwd, 'owned-edit.txt'), 'utf8'), 'UPDATED');
            assert.equal(
              requests.filter(
                (request) => request.sessionKey === 'two' && request.method === 'select'
              ).length,
              0
            );
            host!.child.stdin!.write(JSON.stringify({ k: 'two', d: { type: 'close' } }) + '\n');
          };
          prompt = (message) => request({ type: 'prompt', message });
          newSession = () => request({ type: 'new_session' });
          commands = () => request({ type: 'get_commands' });
          answer = (request, choice) => {
            host!.child.stdin!.write(
              JSON.stringify({
                k: 'one',
                d: { type: 'extension_ui_response', id: request.id, value: choice },
              }) + '\n'
            );
          };
        }
        const catalog = await commands();
        if (mode === 'shared-missing') {
          assert.throws(
            () => assertApprovalGateActive(catalog.commands),
            /approval gate is not active.*Prompt blocked/
          );
          assert.equal(fixture.requests, 0, 'missing gate never admits a provider turn');
          assert.equal(await readFile(join(fixture.cwd, 'owned-edit.txt'), 'utf8'), 'ORIGINAL');
          return;
        }
        assert.ok(
          catalog.commands.some((command: any) => command.name === 'pi-vscode-approval-gate'),
          JSON.stringify({ catalog, stderr, events })
        );
        if (mode === 'shared-project') {
          assert.ok(
            catalog.commands.some((command: any) => command.name === 'pi-project-approval-gate'),
            'approved projects still load the enforcing terminal/CI copy'
          );
        }
        for (const choice of ['Deny', 'Allow']) {
          await newSession();
          events.length = 0;
          const start = requests.length;
          const pending = prompt('Perform the scripted edit');
          await until(() => requests.slice(start).some((request) => request.method === 'select'));
          const request = requests.slice(start).find((request) => request.method === 'select');
          assert.match(request.title, /Allow edit/);
          assert.equal(await readFile(join(fixture.cwd, 'owned-edit.txt'), 'utf8'), 'ORIGINAL');
          if (choice === 'Deny' && checkConcurrentSession) await checkConcurrentSession();
          answer(request, choice);
          await pending;
          await until(() =>
            events.some(
              (event) =>
                event.type === 'agent_end' && (mode === 'stock' || event.sessionKey === 'one')
            )
          );
          assert.equal(
            requests.slice(start).filter((request) => request.method === 'select').length,
            1,
            'project and packaged copies never prompt twice'
          );
          assert.equal(
            await readFile(join(fixture.cwd, 'owned-edit.txt'), 'utf8'),
            choice === 'Allow' ? 'UPDATED' : 'ORIGINAL'
          );
        }
        assert.equal(await readFile(fixture.networkLog, 'utf8'), '');
      } finally {
        if (stock) await shutdown(stock);
        else {
          if (host && host.child.exitCode === null && host.child.signalCode === null) {
            host.child.kill('SIGKILL');
            await new Promise((resolve) => host!.child.once('exit', resolve));
          }
          await fixture.dispose();
        }
      }
    }
  );
}
