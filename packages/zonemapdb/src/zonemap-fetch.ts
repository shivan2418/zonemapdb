import { fetchReferencedJson } from "./fetch-file.js";
import type { PairZonemapEntry } from "./manifest.js";

/**
 * Lazily fetches a secondary field's zonemap sidecar (ADR-0003 §3) — only reached once a query
 * actually needs that field's zonemap and finds a `{ sidecar }` reference in root instead of
 * inline pairs. A missing sidecar 404s as DEPLOY_INTEGRITY, same as any other manifest-referenced
 * file (`fetch-file.ts`'s shared "referenced" mapping) — the deploy is incomplete, not the caller's fault.
 */
export async function fetchZonemapSidecar(
  basePath: string,
  file: string,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<PairZonemapEntry> {
  return (await fetchReferencedJson(`${basePath}/${file}`, fetchImpl, signal)) as PairZonemapEntry;
}
