import test from 'node:test';
import assert from 'node:assert/strict';
import {
  highlightCode,
  clearHighlightCache,
  highlightCacheSize,
} from '../../src/webview/highlight';

const esc = (s: string) => s.replace(/</g, '&lt;').replace(/>/g, '&gt;');

test('highlightCode caches results for the same (code, lang) pair', () => {
  clearHighlightCache();
  const first = highlightCode('const x = 1;', 'javascript', esc);
  assert.equal(highlightCacheSize(), 1);
  const second = highlightCode('const x = 1;', 'javascript', esc);
  assert.equal(highlightCacheSize(), 1);
  assert.deepEqual(first, second);
});

test('different code produces different cache entries', () => {
  clearHighlightCache();
  highlightCode('const x = 1;', 'javascript', esc);
  highlightCode('const y = 2;', 'javascript', esc);
  assert.equal(highlightCacheSize(), 2);
});

test('different language produces different cache entries', () => {
  clearHighlightCache();
  highlightCode('print("hello")', 'python', esc);
  highlightCode('print("hello")', 'ruby', esc);
  assert.equal(highlightCacheSize(), 2);
});

test('clearHighlightCache empties the cache', () => {
  highlightCode('a', 'text', esc);
  assert.ok(highlightCacheSize() > 0);
  clearHighlightCache();
  assert.equal(highlightCacheSize(), 0);
});

test('long code with equal prefixes and lengths never shares cached HTML', () => {
  clearHighlightCache();
  const prefix = '//'.padEnd(2100, ' ');
  const first = highlightCode(`${prefix}\nconst a = 1;`, 'javascript', esc);
  const second = highlightCode(`${prefix}\nconst b = 2;`, 'javascript', esc);
  assert.notEqual(first.html, second.html);
});

test('cache hits refresh recency and huge blocks are not retained', () => {
  clearHighlightCache();
  const first = highlightCode('const first = 1;', 'javascript', esc);
  for (let i = 0; i < 255; i++) highlightCode(`const v${i} = 0;`, 'javascript', esc);
  assert.equal(highlightCode('const first = 1;', 'javascript', esc), first);
  highlightCode('const extra = 0;', 'javascript', esc);
  assert.equal(highlightCode('const first = 1;', 'javascript', esc), first);
  clearHighlightCache();
  highlightCode('x'.repeat(65537), 'text', esc);
  assert.equal(highlightCacheSize(), 0);
});

test('cache evicts oldest entry when full', () => {
  clearHighlightCache();
  // Fill the cache near capacity
  for (let i = 0; i < 257; i++) {
    highlightCode(`const x${i} = ${i};`, 'javascript', esc);
  }
  // Cache should not exceed 256 entries
  assert.ok(highlightCacheSize() <= 256);
});
