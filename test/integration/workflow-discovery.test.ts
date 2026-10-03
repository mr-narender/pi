import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { shutdown, spawnRealPi } from '../helpers/rpc';

const execFileAsync = promisify(execFile);

// Pi's existing -e contract accepts a reviewed local package directory as well
// as an archived fixture. CI can provide current source without inventing refs.
const workflowSource = process.env.PI_WORKFLOW_SOURCE;
const WORKFLOW_REPO = '/Users/narender/Developer/agent-registry';
const workflowBranchExists = (() => {
  try {
    execSync(`git -C ${WORKFLOW_REPO} rev-parse --verify --quiet origin/feat/pi-agent-workflow`, {
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
})();

test(
  'pi-agent-workflow archived source is discoverable through get_commands',
  {
    skip:
      !workflowSource &&
      !workflowBranchExists &&
      'requires agent-registry origin/feat/pi-agent-workflow or PI_WORKFLOW_SOURCE',
  },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-agent-workflow-'));
    if (!workflowSource)
      await execFileAsync('bash', [
        '-lc',
        `git -C ${WORKFLOW_REPO} archive --format=tar --prefix=pi-agent-workflow/ origin/feat/pi-agent-workflow:pi-agent-workflow | tar -xf - -C ${JSON.stringify(root)}`,
      ]);
    const spawned = await spawnRealPi(['-e', workflowSource || join(root, 'pi-agent-workflow')]);
    try {
      const commands = await spawned.client.getCommands();
      const names = Array.isArray(commands?.commands)
        ? commands.commands.map((command) =>
            String((command as Record<string, unknown>).name ?? '')
          )
        : [];
      assert.ok(names.includes('workflow'));
      assert.ok(names.includes('workflow-status'));
      assert.ok(names.includes('skill:pi-agent-workflow'));
    } finally {
      await shutdown(spawned);
    }
  }
);
