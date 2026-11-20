import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';

test('deleting an allocated unwritten draft ignores only missing-file errors', async () => {
  const compiled = await build({
    entryPoints: ['src/sessions/deleteSessionFile.ts'],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    external: ['vscode'],
  });
  let code: string | undefined;
  const paths: string[] = [];
  const module = { exports: {} as any };
  new Function('require', 'module', 'exports', compiled.outputFiles[0]!.text)(
    () => ({
      Uri: { file: (path: string) => path },
      workspace: {
        fs: {
          delete: async (path: string) => {
            paths.push(path);
            if (code) throw Object.assign(new Error(code), { code });
          },
        },
      },
    }),
    module,
    module.exports
  );
  for (code of [undefined, 'ENOENT', 'FileNotFound'])
    await module.exports.deleteSessionFileIfExists('/owned/draft.jsonl');
  code = 'NoPermissions';
  await assert.rejects(
    module.exports.deleteSessionFileIfExists('/owned/draft.jsonl'),
    /NoPermissions/
  );
  assert.equal(paths.length, 4);
});
