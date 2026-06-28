/**
 * RuntimeProvisionService interface — the gateway-side seam for installing a
 * pinned, relocatable runtime onto a session volume. The catalog is the gate:
 * callers name only a runtime, never a URL.
 */

export type RuntimeArch = 'amd64' | 'arm64';

export interface RuntimeArchArtifact {
  url: string;       // https only
  sha256: string;    // 64 hex, stored lowercased
  binSubdir: string; // safe relative path (no '..', no leading '/')
}

export interface RuntimeCatalogEntry {
  version: string;
  format: 'tar.gz' | 'zip';
  /** At least one arch must be present. Keys constrained to RuntimeArch. */
  arch: { readonly [A in RuntimeArch]?: RuntimeArchArtifact };
}

export interface RuntimeProvisionRequest {
  name: string;
  volume: string;
}

export type ProvisionOutcome =
  | { ok: true }
  | { ok: false; error: string };

export interface RuntimeProvisionService {
  provision(req: RuntimeProvisionRequest): Promise<ProvisionOutcome>;
}
