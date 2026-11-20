import * as vscode from 'vscode';
import type { ChatTabManager } from '../../editorTabs/tabManager';
import type {
  RecentSessionService,
  RecentSessionsState,
} from '../../sessions/recentSessionService';
import { buildChatListModel } from '../../webview/chatListData';
import {
  applyPendingDeletions,
  decideSnapshotPush,
  type ChatListModel,
  type PendingDeletion,
  type SnapshotDecisionState,
} from '../../webview/chatListShared';
import { renderChatListWebviewHtml } from '../../webview/chatListHtml';

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** Agentic's chat list in the sidebar. A
 * dedicated webview, not the native TreeView the first two attempts used:
 * a vscode.TreeDataProvider has no extension-facing API for row spacing,
 * font size, or custom (non-Codicon) icons/buttons — verified against
 * VS Code's own listView.ts (row height is set by the internal renderer,
 * never exposed to extensions) and the VS Code team's own admission that
 * list/tree isn't a good fit for chat UI (microsoft/vscode#268858).
 *
 * Reuses the SAME real data sources as the tree-view attempt
 * (ChatTabManager.listOpenChats() for "open", RecentSessionService for
 * "recent") and the SAME lesson learned there: diff on stable identity
 * (ids/paths/active flags), never on rendered text — comparing rendered
 * output caused a real "reloads on every click" bug there. */
export class AgenticChatListHost implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private view: vscode.WebviewView | undefined;
  private messageSub: vscode.Disposable | undefined;
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private snapshotState: SnapshotDecisionState = { hasShownRealData: false };
  private pendingDeletions: PendingDeletion[] = [];
  private filterText = '';
  private selectedFolder = '';

  public constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly chatTabs: ChatTabManager,
    private readonly recentSessions: RecentSessionService,
    private readonly folder: vscode.WorkspaceFolder
  ) {
    this.disposables.push(
      chatTabs.onDidChangeOpenChats(() => this.scheduleRefresh()),
      recentSessions.onDidChange(() => this.scheduleRefresh())
    );
    const foldersChanged = vscode.workspace?.onDidChangeWorkspaceFolders?.(() => {
      void recentSessions.refresh();
      this.scheduleRefresh();
    });
    if (foldersChanged) this.disposables.push(foldersChanged);
  }

  public attach(view: vscode.WebviewView): void {
    this.messageSub?.dispose();
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri, vscode.Uri.joinPath(this.extensionUri, 'dist')],
    };
    view.webview.html = renderChatListWebviewHtml(this.extensionUri, view.webview, __PI_BUILD__);
    this.snapshotState = { hasShownRealData: false };
    this.messageSub = view.webview.onDidReceiveMessage((message) => void this.onMessage(message));
    void this.pushSnapshot();
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
    // Matches the tree-view attempt's debounce: a few event sources
    // (open-chats changed, recent-sessions changed) can fire together for
    // one user action; settle to a single re-render.
    this.refreshTimer = setTimeout(() => void this.pushSnapshot(), 120);
  }

  private buildModel(): ChatListModel {
    const openChats = this.chatTabs.listOpenChats().map((chat) => ({
      resource: chat.resource.toString(),
      title: chat.title,
      sessionFile: asString(chat.controller.snapshot.state.sessionFile),
      cwd: chat.controller.folder.uri.fsPath,
      active: chat.visible,
    }));
    const model = buildChatListModel({
      openChats,
      recent: this.recentState(),
      folders: (vscode.workspace?.workspaceFolders ?? [this.folder]).map(
        (folder) => folder.uri.fsPath
      ),
      selectedFolder: this.selectedFolder,
    });
    this.selectedFolder = model.selectedFolder ?? '';
    if (this.pendingDeletions.length === 0) {
      return model;
    }
    return { ...model, rows: applyPendingDeletions(model, this.pendingDeletions) };
  }

  private recentState(): RecentSessionsState {
    const folders = vscode.workspace?.workspaceFolders ?? [this.folder];
    const states = folders.map((folder) => ({
      folder,
      state: this.recentSessions.getState(folder),
    }));
    const items = states.flatMap(({ folder, state }) =>
      state.items.map((item) => ({
        ...item,
        cwd: item.cwd || folder.uri.fsPath,
        workspaceLabel: item.workspaceLabel || folder.name,
      }))
    );
    const others = states.flatMap(({ state }) => state.others ?? []);
    const empty = items.length === 0 && others.length === 0;
    return {
      items,
      others,
      filterText: this.filterText,
      loading: empty && states.some(({ state }) => state.loading),
      error:
        empty && states.every(({ state }) => !state.loading)
          ? states.find(({ state }) => state.error)?.state.error
          : undefined,
    };
  }

  private async pushSnapshot(): Promise<void> {
    if (!this.view) {
      return;
    }
    const model = this.buildModel();
    const decision = decideSnapshotPush(model, this.snapshotState);
    this.snapshotState = {
      lastIdentity: decision.lastIdentity,
      hasShownRealData: decision.hasShownRealData,
    };
    if (!decision.push) {
      return;
    }
    await this.view.webview.postMessage({ type: 'listSnapshot', model });
  }

  private async onMessage(message: unknown): Promise<void> {
    const record = asRecord(message);
    switch (record?.type) {
      case 'requestListSnapshot':
        this.snapshotState.lastIdentity = undefined;
        return this.pushSnapshot();
      case 'openChat': {
        const resource = asString(record.resource);
        const sessionPath = asString(record.sessionPath);
        const row = this.buildModel().rows.find((item) =>
          record.isOpen && resource
            ? item.isOpen && item.openCommand.resource === resource
            : !!sessionPath && item.sessionPath === sessionPath
        );
        if (!row) return;
        if (row.isOpen && row.openCommand.resource) {
          await vscode.commands.executeCommand('piRpcInternal.revealOpenChat', {
            resource: row.openCommand.resource,
          });
        } else if (row.sessionPath) {
          const recent = this.recentState();
          const session = [...recent.items, ...(recent.others ?? [])].find(
            (item) => item.path === row.sessionPath
          );
          if (!session?.cwd) return;
          await vscode.commands.executeCommand('piRpcInternal.openOtherChat', {
            sessionPath: session.path,
            cwd: session.cwd,
          });
        }
        return;
      }
      case 'filterChats': {
        // Filter after merging roots and other projects, before the row cap.
        for (const folder of vscode.workspace?.workspaceFolders ?? [this.folder]) {
          this.recentSessions.clearFilter(folder);
        }
        this.filterText = asString(record.text) ?? '';
        this.scheduleRefresh();
        return;
      }
      case 'filterChatFolder': {
        const selected = asString(record.path);
        const model = this.buildModel();
        if (selected !== '' && !model.folders?.some((folder) => folder.path === selected)) return;
        this.selectedFolder = selected ?? '';
        this.scheduleRefresh();
        return;
      }
      case 'renameChat': {
        const sessionPath = asString(record.sessionPath);
        if (sessionPath) {
          await vscode.commands.executeCommand('piRpcInternal.renameSession', {
            sessionPath,
            sessionLabel: asString(record.label),
          });
        }
        return;
      }
      case 'deleteChat': {
        const sessionPath = asString(record.sessionPath);
        const resource = asString(record.resource);
        const id = sessionPath ?? resource;
        if (!id || this.pendingDeletions.some((entry) => entry.id === id)) return;
        this.pendingDeletions.push({ id });
        void this.pushSnapshot();
        try {
          if (sessionPath) {
            await vscode.commands.executeCommand('piRpcInternal.deleteSession', { sessionPath });
          } else if (resource) {
            // A fresh draft has no file to delete; closing its tab removes it.
            await this.chatTabs.closeResource(vscode.Uri.parse(resource));
          }
        } catch (error) {
          this.pendingDeletions = this.pendingDeletions.filter((entry) => entry.id !== id);
          await this.view?.webview.postMessage({ type: 'deleteFailed', id });
          void vscode.window.showErrorMessage(
            `Could not delete chat: ${error instanceof Error ? error.message : String(error)}`
          );
          this.snapshotState.lastIdentity = undefined;
          void this.pushSnapshot();
          return;
        }
        this.pendingDeletions = this.pendingDeletions.filter((entry) => entry.id !== id);
        // For a session file, deleteSession has synchronously removed the
        // cached record. An in-flight scan cannot reintroduce it.
        void this.pushSnapshot();
        await this.view?.webview.postMessage({ type: 'deleteSucceeded', id });
        return;
      }
      default:
        return;
    }
  }

  /** Release view wiring while retaining the list data subscriptions. */
  public detach(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = undefined;
    }
    this.messageSub?.dispose();
    this.messageSub = undefined;
    this.view = undefined;
  }

  public dispose(): void {
    this.detach();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }
}
