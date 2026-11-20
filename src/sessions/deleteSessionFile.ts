import * as vscode from 'vscode';

/** An allocated session path is not necessarily persisted: empty drafts have no file. */
export async function deleteSessionFileIfExists(sessionPath: string): Promise<void> {
  try {
    await vscode.workspace.fs.delete(vscode.Uri.file(sessionPath));
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code !== 'ENOENT' && code !== 'FileNotFound') throw error;
  }
}
