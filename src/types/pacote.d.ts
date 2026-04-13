declare module 'pacote' {
  export interface Manifest {
    version: string;
    name?: string;
  }

  export function manifest(
    spec: string,
    opts?: { fullMetadata?: boolean },
  ): Promise<Manifest>;
}
