import { gzipSync } from "node:zlib";
import { describe, expect, test } from "vitest";
import { MANIFEST_BUDGET_BYTES } from "../src/estimator.js";
import { spillOversizedZonemaps } from "../src/zonemap-budget.js";
import type { Manifest } from "../src/types.js";

/** A cheap, deterministic hash-mixer — produces high-entropy-looking hex strings that gzip can't compress away, so pair arrays reliably grow the manifest's real gzipped size (plain incrementing strings compress too well to exercise the budget check). */
function pseudoRandomHex(seed: number): string {
  let x = Math.imul(seed, 2654435761) >>> 0;
  x ^= x >>> 15;
  x = Math.imul(x, 2246822519) >>> 0;
  x ^= x >>> 13;
  return x.toString(16).padStart(8, "0");
}

function highEntropyPairs(count: number, offset: number): [string, string][] {
  return Array.from({ length: count }, (_, i) => [pseudoRandomHex(offset + 2 * i), pseudoRandomHex(offset + 2 * i + 1)]);
}

function baseManifest(): Manifest {
  return {
    formatVersion: 0,
    generatorVersion: "0.0.0",
    dataset: { collection: "movies", recordCount: 2, blockCount: 2, sortField: "year" },
    schema: { collection: "movies", sortField: "year", fields: {} },
    blocks: [
      { hash: "aaaa000000000000", bytes: 100, count: 1 },
      { hash: "bbbb000000000000", bytes: 100, count: 1 },
    ],
    zonemap: { year: { splitPoints: [2000, 2010] } },
    indexes: {},
  };
}

describe("spillOversizedZonemaps", () => {
  test("leaves a manifest under budget untouched, with no sidecar files", () => {
    const manifest = baseManifest();
    manifest.zonemap.title = { pairs: [["Alpha", "Zeta"]], truncated: true };

    const result = spillOversizedZonemaps(manifest);

    expect(result.manifest).toEqual(manifest);
    expect(result.sidecarFiles).toEqual([]);
  });

  test("spills the largest secondary zonemap first, replacing it with a sidecar reference, until under budget", () => {
    const manifest = baseManifest();
    // A huge secondary zonemap alone pushes the manifest over the ~1MB gzip budget.
    const hugePairs = highEntropyPairs(100_000, 0);
    manifest.zonemap.director = { pairs: hugePairs, truncated: true };
    manifest.zonemap.title = { pairs: [["A", "Z"]], truncated: true };

    const result = spillOversizedZonemaps(manifest);

    // the huge field was spilled to a sidecar; the small one stayed inline
    expect(result.manifest.zonemap.director).toEqual({ sidecar: expect.stringMatching(/^zonemap\/director-[0-9a-f]+\.json$/) });
    expect(result.manifest.zonemap.title).toEqual({ pairs: [["A", "Z"]], truncated: true });
    // the sort field's own zonemap is never spilled
    expect(result.manifest.zonemap.year).toEqual({ splitPoints: [2000, 2010] });

    expect(result.sidecarFiles).toHaveLength(1);
    expect(result.sidecarFiles[0]!.relPath).toBe((result.manifest.zonemap.director as { sidecar: string }).sidecar);
    expect(JSON.parse(result.sidecarFiles[0]!.content)).toEqual({ pairs: hugePairs, truncated: true });

    const finalBytes = Buffer.byteLength(JSON.stringify(result.manifest), "utf8");
    expect(finalBytes).toBeLessThan(Buffer.byteLength(JSON.stringify(manifest), "utf8"));
  });

  test("spills multiple fields, one at a time, if a single spill isn't enough to get under budget", () => {
    const manifest = baseManifest();
    // Each field alone, combined with the other still inline, keeps the manifest over budget —
    // forces the loop to spill both before it can stop.
    manifest.zonemap.director = { pairs: highEntropyPairs(90_000, 0), truncated: true };
    manifest.zonemap.studio = { pairs: highEntropyPairs(90_000, 1_000_000), truncated: true };

    const result = spillOversizedZonemaps(manifest);

    expect(result.sidecarFiles).toHaveLength(2);
    expect(result.manifest.zonemap.director).toHaveProperty("sidecar");
    expect(result.manifest.zonemap.studio).toHaveProperty("sidecar");

    const finalGzipBytes = gzipSync(JSON.stringify(result.manifest)).length;
    expect(finalGzipBytes).toBeLessThanOrEqual(MANIFEST_BUDGET_BYTES);
  });

  test("under budget → no warning", () => {
    const manifest = baseManifest();
    manifest.zonemap.title = { pairs: [["Alpha", "Zeta"]], truncated: true };

    expect(spillOversizedZonemaps(manifest).warning).toBeUndefined();
  });

  test("still over budget after spilling everything spillable → warns (ADR-0003 §3 'build warns past it')", () => {
    const manifest = baseManifest();
    // Index chunk directories are routing-essential and never spill (ADR-0003 §3), so a manifest
    // whose bulk lives there has no relief valve — the exact case that must not pass silently.
    manifest.indexes.oracle_text = {
      operators: ["equals", "in", "startsWith"],
      chunks: Array.from({ length: 55_000 }, (_, i) => ({
        from: pseudoRandomHex(i * 2),
        to: pseudoRandomHex(i * 2 + 1),
        file: `index/oracle_text/${pseudoRandomHex(i + 5_000_000)}${pseudoRandomHex(i + 9_000_000)}.json`,
      })),
    };
    manifest.zonemap.director = { pairs: highEntropyPairs(20_000, 0), truncated: true };

    const result = spillOversizedZonemaps(manifest);

    // it still spilled what it could — the warning is in addition to, not instead of, spilling
    expect(result.manifest.zonemap.director).toHaveProperty("sidecar");
    expect(gzipSync(JSON.stringify(result.manifest)).length).toBeGreaterThan(MANIFEST_BUDGET_BYTES);

    expect(result.warning).toMatch(/manifest/i);
    // names the real cause (index chunk directories, not zonemaps) and the actionable lever
    expect(result.warning).toContain("oracle_text");
    expect(result.warning).toMatch(/index chunk director/i);
  });
});
