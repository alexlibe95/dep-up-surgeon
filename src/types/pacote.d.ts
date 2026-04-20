declare module 'pacote' {
  export interface Manifest {
    version: string;
    name?: string;
    dependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
    engines?: Record<string, string>;
  }

  export interface Packument {
    name?: string;
    versions?: Record<string, unknown>;
  }

  export function manifest(
    spec: string,
    opts?: { fullMetadata?: boolean },
  ): Promise<Manifest & { repository?: unknown; homepage?: unknown }>;

  export function packument(spec: string, opts?: Record<string, unknown>): Promise<Packument>;

  export function extract(
    spec: string,
    dest: string,
    opts?: Record<string, unknown>,
  ): Promise<{ from: string; resolved: string; integrity?: string }>;
}
