/**
 * RuntimeProvisionService interface — the gateway-side seam for installing a
 * pinned, relocatable runtime onto a session volume. The catalog is the gate:
 * callers name only a runtime, never a URL.
 */

export interface RuntimeCatalogEntry {
  version: string;
  url: string;
  sha256: string;
  binSubdir: string;
  format: 'tar.gz' | 'zip';
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
