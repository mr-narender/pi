import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import { createInitialControllerState } from '../../src/state/types';
import { createWebviewSnapshot } from '../../src/webview/model';
import { createEmptyComposerState } from '../../src/webview/composer';

test('Copy message copies exact source markdown, not Mermaid/code controls or hidden fallback', async () => {
  const source =
    '  Reply\n\n```js\nconst fixture = true;\n```\n\n```mermaid\ngraph LR\nA-->B\n```\n';
  const dom = new JSDOM('<div id="app"></div>', {
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    url: 'https://webview.test/',
  });
  const { window } = dom;
  const copied: string[] = [];
  Object.assign(window, {
    acquireVsCodeApi: () => ({ postMessage() {}, getState() {}, setState() {} }),
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    ResizeObserver: class {
      observe() {}
      disconnect() {}
    },
    IntersectionObserver: class {
      observe() {}
      disconnect() {}
    },
  });
  Object.assign(window.HTMLElement.prototype, { scrollIntoView() {} });
  Object.defineProperty(window.navigator, 'clipboard', {
    value: {
      writeText: async (text: string) => {
        copied.push(text);
      },
    },
  });
  try {
    const compiled = await build({
      entryPoints: ['src/webview/media/chat.ts'],
      bundle: true,
      platform: 'browser',
      format: 'iife',
      write: false,
    });
    window.eval(compiled.outputFiles[0]!.text);
    const snapshot = createWebviewSnapshot(createInitialControllerState('owned', '/owned'), 1, {
      composer: createEmptyComposerState(),
      isTrusted: true,
      folders: [],
    });
    snapshot.connectionState = 'ready';
    snapshot.bindingState = 'current';
    snapshot.messages = [{ id: 'reply', role: 'assistant', text: source, attachments: [] }];
    window.dispatchEvent(
      new window.MessageEvent('message', { data: { type: 'snapshot', snapshot } })
    );
    const button = window.document.querySelector<HTMLButtonElement>('.msg-copy')!;
    assert.ok(button);
    const body = window.document.querySelector('.message-body')!;
    body.insertAdjacentHTML(
      'beforeend',
      '<button>Preview ⛶</button><span hidden>Could not render this diagram</span>'
    );
    button.click();
    await Promise.resolve();
    assert.deepEqual(copied, [source]);
  } finally {
    window.close();
  }
});
