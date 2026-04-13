declare module 'pacote' {
  export interface Manifest {
    version: string;
    name?: string;
    dependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
  }

  export interface Packument {
    name?: string;
    versions?: Record<string, unknown>;
  }

  export function manifest(
    spec: string,
    opts?: { fullMetadata?: boolean },
  ): Promise<Manifest>;

  export function packument(spec: string, opts?: Record<string, unknown>): Promise<Packument>;
}
