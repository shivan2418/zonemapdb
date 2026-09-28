import { gzipSync } from "node:zlib";
import { MANIFEST_BUDGET_BYTES } from "./estimator.js";
import { contentHash } from "./hash.js";
import type { Manifest, PairZonemapEntry, ZonemapEntry } from "./types.js";

export interface ZonemapSpillResult {
  manifest: Manifest;
  /** Sidecar files to write alongside blocks/index chunks, content-hashed and referenced from the (now-lighter) root manifest. */
  sidecarFiles: { relPath: string; content: string }[];
  /**
   * Set when spilling every spillable zonemap still left the root over budget — ADR-0003 §3's
   * "build warns past it". Secondary zonemaps are the only relief valve, so once they're all gone
   * the remaining bulk is routing-essential (index chunk directories, block identity) and the only
   * lever left is the config: fewer indexed fields, or fewer `contains`/`endsWith` opt-ins.
   */
  warning?: string;
}

/** The indexed fields whose chunk directories weigh most in the root manifest, heaviest first. */
function heaviestIndexFields(manifest: Manifest, limit: number): string[] {
  return Object.entries(manifest.indexes)
    .map(([field, descriptor]) => ({ field, size: JSON.stringify(descriptor).length }))
    .sort((a, b) => b.size - a.size)
    .slice(0, limit)
    .map(({ field }) => field);
}

function overBudgetWarning(manifest: Manifest, gzipBytes: number, spilledCount: number): string {
  const heaviest = heaviestIndexFields(manifest, 3);
  return (
    `zonedb: the root manifest is ${Math.round(gzipBytes / 1024)} KB gzipped, over the ` +
    `${Math.round(MANIFEST_BUDGET_BYTES / 1024)} KB budget (ADR-0003 §3), and all ${spilledCount} ` +
    `secondary zonemap(s) have already been spilled to sidecars. What's left is routing-essential and ` +
    `cannot spill — mostly index chunk directories` +
    (heaviest.length > 0 ? ` (heaviest: ${heaviest.join(", ")})` : "") +
    `. Every client downloads this file before its first query; reduce it by indexing fewer fields, or ` +
    `by turning off contains/endsWith on the fields above.`
  );
}

function manifestGzipBytes(manifest: Manifest): number {
  return gzipSync(JSON.stringify(manifest)).length;
}

function isPairEntry(entry: ZonemapEntry): entry is PairZonemapEntry {
  return "pairs" in entry;
}

/**
 * Spills the largest secondary-field zonemap to a sidecar file, one field at a time, until the
 * root manifest's gzipped size is back under `MANIFEST_BUDGET_BYTES` or every secondary zonemap
 * has been spilled (ADR-0003 §3) — the `O(blocks × fields)` root-manifest failure mode. The sort
 * field's own zonemap (split-points) is never spilled: it routes every query and must stay in root.
 */
export function spillOversizedZonemaps(manifest: Manifest, servedSuffix = ""): ZonemapSpillResult {
  if (manifestGzipBytes(manifest) <= MANIFEST_BUDGET_BYTES) {
    return { manifest, sidecarFiles: [] };
  }

  let current = manifest;
  const sidecarFiles: { relPath: string; content: string }[] = [];
  let gzipBytes = manifestGzipBytes(current);

  for (;;) {
    const candidates = Object.entries(current.zonemap)
      .filter((entry): entry is [string, PairZonemapEntry] => entry[0] !== current.dataset.sortField && isPairEntry(entry[1]))
      .map(([field, entry]) => ({ field, entry, size: JSON.stringify(entry).length }))
      .sort((a, b) => b.size - a.size);

    if (candidates.length === 0) break;

    const { field, entry } = candidates[0]!;
    const content = JSON.stringify(entry);
    // Hash over the uncompressed content; `servedSuffix` marks how `build` will write it (ADR-0002 §8).
    const relPath = `zonemap/${field}-${contentHash(content)}.json${servedSuffix}`;
    sidecarFiles.push({ relPath, content });

    current = { ...current, zonemap: { ...current.zonemap, [field]: { sidecar: relPath } } };

    gzipBytes = manifestGzipBytes(current);
    if (gzipBytes <= MANIFEST_BUDGET_BYTES) break;
  }

  // Spilling is best-effort: it can run out of spillable zonemaps while still over budget, which
  // must not pass silently (ADR-0003 §3).
  if (gzipBytes > MANIFEST_BUDGET_BYTES) {
    return { manifest: current, sidecarFiles, warning: overBudgetWarning(current, gzipBytes, sidecarFiles.length) };
  }
  return { manifest: current, sidecarFiles };
}
