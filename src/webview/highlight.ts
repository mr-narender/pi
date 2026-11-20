// Syntax highlighting for fenced code blocks. We use highlight.js core with a
// curated set of languages (keeps the webview bundle lean vs. the full build).
// highlight.js escapes its output, so the returned HTML is safe to inject. The
// emitted `hljs-*` token classes are styled in chat.css against VS Code theme
// colors, so highlighting matches the active editor theme.
import hljs from 'highlight.js/lib/core';

import bash from 'highlight.js/lib/languages/bash';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import csharp from 'highlight.js/lib/languages/csharp';
import css from 'highlight.js/lib/languages/css';
import diff from 'highlight.js/lib/languages/diff';
import go from 'highlight.js/lib/languages/go';
import ini from 'highlight.js/lib/languages/ini';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import kotlin from 'highlight.js/lib/languages/kotlin';
import less from 'highlight.js/lib/languages/less';
import lua from 'highlight.js/lib/languages/lua';
import markdown from 'highlight.js/lib/languages/markdown';
import objectivec from 'highlight.js/lib/languages/objectivec';
import perl from 'highlight.js/lib/languages/perl';
import php from 'highlight.js/lib/languages/php';
import python from 'highlight.js/lib/languages/python';
import ruby from 'highlight.js/lib/languages/ruby';
import rust from 'highlight.js/lib/languages/rust';
import scss from 'highlight.js/lib/languages/scss';
import shell from 'highlight.js/lib/languages/shell';
import sql from 'highlight.js/lib/languages/sql';
import swift from 'highlight.js/lib/languages/swift';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';

let registered = false;

function ensureRegistered(): void {
  if (registered) {
    return;
  }
  const langs: Record<string, LanguageFn> = {
    bash,
    c,
    cpp,
    csharp,
    css,
    diff,
    go,
    ini,
    java,
    javascript,
    json,
    kotlin,
    less,
    lua,
    markdown,
    objectivec,
    perl,
    php,
    python,
    ruby,
    rust,
    scss,
    shell,
    sql,
    swift,
    typescript,
    xml,
    yaml,
  };
  for (const [name, fn] of Object.entries(langs)) {
    hljs.registerLanguage(name, fn);
  }
  registered = true;
}

// highlight.js exports LanguageFn but importing the type adds noise; alias here.
type LanguageFn = Parameters<typeof hljs.registerLanguage>[1];

// Common fence aliases -> registered language names.
const ALIASES: Record<string, string> = {
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  py: 'python',
  py3: 'python',
  rb: 'ruby',
  sh: 'bash',
  zsh: 'bash',
  shell: 'shell',
  console: 'shell',
  'c++': 'cpp',
  cc: 'cpp',
  h: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  'c#': 'csharp',
  golang: 'go',
  kt: 'kotlin',
  rs: 'rust',
  yml: 'yaml',
  html: 'xml',
  htm: 'xml',
  svg: 'xml',
  xml: 'xml',
  md: 'markdown',
  markdown: 'markdown',
  'objective-c': 'objectivec',
  objc: 'objectivec',
  toml: 'ini',
  conf: 'ini',
  patch: 'diff',
};

function resolveLanguage(language: string): string | undefined {
  const key = language.trim().toLowerCase();
  if (!key) {
    return undefined;
  }
  const resolved = ALIASES[key] ?? key;
  return hljs.getLanguage(resolved) ? resolved : undefined;
}

export interface HighlightedCode {
  html: string;
  language?: string;
}

// LRU highlight cache keyed by (code, language). Avoids re-highlighting
// unchanged code blocks on every streaming snapshot (Goal C render hygiene).
const HIGHLIGHT_CACHE_MAX = 256;
const highlightCache = new Map<string, HighlightedCode>();

function cacheKey(code: string, language: string): string {
  return `${language}\0${code}`;
}

/** Clear the highlight cache (exposed for tests). */
export function clearHighlightCache(): void {
  highlightCache.clear();
}

/** Current cache size (exposed for tests). */
export function highlightCacheSize(): number {
  return highlightCache.size;
}

/**
 * Highlight a code string. When the fence language is known it is used
 * directly; otherwise auto-detection runs over the registered subset. The
 * returned html is highlight.js output (already escaped) OR, if highlighting
 * fails, the raw code escaped by the caller-provided escaper.
 *
 * Results are cached by (code, language) to avoid re-highlighting unchanged
 * blocks during streaming.
 */
export function highlightCode(
  code: string,
  language: string,
  escape: (value: string) => string
): HighlightedCode {
  ensureRegistered();
  const key = cacheKey(code, language);
  const cached = highlightCache.get(key);
  if (cached) {
    highlightCache.delete(key);
    highlightCache.set(key, cached);
    return cached;
  }
  const resolved = resolveLanguage(language);
  let result: HighlightedCode;
  try {
    if (resolved) {
      const highlighted = hljs.highlight(code, { language: resolved, ignoreIllegals: true });
      result = { html: highlighted.value, language: resolved };
    } else if (code.includes('\n')) {
      // No explicit language: only auto-detect for multi-line blocks (single
      // lines are too ambiguous and often mis-detected).
      const auto = hljs.highlightAuto(code);
      if (auto.relevance >= 5 && auto.value) {
        result = { html: auto.value, language: auto.language };
      } else {
        result = { html: escape(code) };
      }
    } else {
      result = { html: escape(code) };
    }
  } catch {
    // Fall through to plain escaped output on any highlighter error.
    result = { html: escape(code) };
  }
  // Avoid retaining huge outputs; keys include the full code to prevent collisions.
  if (code.length > 64 * 1024) return result;
  // Evict least recently used entries when the cache grows too large.
  if (highlightCache.size >= HIGHLIGHT_CACHE_MAX) {
    const first = highlightCache.keys().next().value;
    if (first !== undefined) highlightCache.delete(first);
  }
  highlightCache.set(key, result);
  return result;
}
