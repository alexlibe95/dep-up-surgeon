import pacote from 'pacote';
import type { Manifest } from 'pacote';

const DEFAULT_TTL_MS = 5 * 60 * 1000;

interface Entry {
  manifest: Manifest;
  expires: number;
}

/**
 * Simple in-memory cache for registry manifests (same process / run).
 */
export function createManifestCache(ttlMs: number = DEFAULT_TTL_MS): {
  get: (packageName: string) => Promise<Manifest | null>;
  clear: () => void;
} {
  const store = new Map<string, Entry>();

  return {
    async get(packageName: string): Promise<Manifest | null> {
      const now = Date.now();
      const hit = store.get(packageName);
      if (hit && hit.expires > now) {
        return hit.manifest;
      }
      try {
        const manifest = await pacote.manifest(`${packageName}@latest`, { fullMetadata: false });
        store.set(packageName, { manifest, expires: now + ttlMs });
        return manifest;
      } catch {
        return null;
      }
    },
    clear(): void {
      store.clear();
    },
  };
}
