import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

// The SDK has no public llama.cpp factory. Keep this CLI-parity exception isolated
// and optional so a changed internal layout cannot prevent supported SDK startup.
export async function loadLlamaBuiltin(sdkRoot, version, warn = console.warn) {
  try {
    const { builtInExtensions } = await import(
      pathToFileURL(join(sdkRoot, 'dist/extensions/index.js')).href
    );
    const entry = builtInExtensions?.find((entry) => entry.name === 'llama.cpp');
    if (typeof entry?.factory !== 'function') throw new Error('Missing llama.cpp factory');
    return [entry];
  } catch {
    warn(`llama.cpp builtin unavailable for SDK ${version}; user extensions unaffected`);
    return [];
  }
}
