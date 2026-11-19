/**
 * π Approval Gate (managed by the Pi VS Code extension — piRpc.requireApprovalForEdits)
 *
 * Manual Mode intercepts every tool call BEFORE it runs, with Allow / Deny.
 * The setting is read per call so a loaded session observes both modes. This is a
 * PROJECT-scoped policy: it applies everywhere π runs for this project
 * (VS Code, terminal, CI) — not just inside the extension.
 *
 * Keep this hook loaded in both modes. Model text and internal processing are
 * not tool actions and are not approval gated.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

// Project and explicitly loaded packaged copies share ownership by session, never
// by process: a shared host can run independently gated sessions concurrently.
const ownershipKey = Symbol.for('pi-vscode.approval-gate.sessions.v1');
const shared = globalThis as typeof globalThis & { [ownershipKey]?: WeakMap<object, object> };
const owners = (shared[ownershipKey] ??= new WeakMap<object, object>());

async function manualMode(cwd: string): Promise<boolean> {
  const mode = JSON.parse(await readFile(join(cwd, '.pi/pi-vscode-manual-mode.json'), 'utf8')) as {
    enabled?: unknown;
  };
  if (typeof mode.enabled !== 'boolean') {
    throw new Error('Manual Mode setting is invalid.');
  }
  return mode.enabled;
}

function preview(input: Record<string, unknown>): string {
  const value = input.command ?? input.path ?? input.file_path ?? input.filePath ?? input;
  return (typeof value === 'string' ? value : JSON.stringify(value)).slice(0, 600);
}

export default function (pi: ExtensionAPI) {
  const owner = {};
  const projectCopy = /[/\\]\.pi[/\\]extensions[/\\]/.test(new URL(import.meta.url).pathname);
  pi.registerCommand(projectCopy ? 'pi-project-approval-gate' : 'pi-vscode-approval-gate', {
    description: 'Manual Mode approval gate is active',
    handler: async () => undefined,
  });
  pi.on('session_shutdown', async (_event, ctx) => {
    if (owners.get(ctx.sessionManager) === owner) owners.delete(ctx.sessionManager);
  });
  pi.on('tool_call', async (event, ctx) => {
    const session = ctx.sessionManager;
    if (!owners.has(session)) owners.set(session, owner);
    if (owners.get(session) !== owner) return undefined;
    try {
      if (!(await manualMode(ctx.cwd))) {
        return undefined;
      }
    } catch {
      return {
        block: true,
        reason: 'Manual Mode could not be read. Reopen VS Code to sync it before running tools.',
      };
    }
    const name = event.toolName || 'tool';
    if (!ctx.hasUI) {
      return {
        block: true,
        reason: `Manual Mode requires approval for ${name}, but no UI is attached.`,
      };
    }
    const choice = await ctx.ui.select(
      `Allow ${name}?\n\n${preview((event.input ?? {}) as Record<string, unknown>)}`,
      ['Allow', 'Deny']
    );
    if (choice !== 'Allow') {
      return { block: true, reason: 'Blocked — tool action was not approved.' };
    }
    return undefined;
  });
}
