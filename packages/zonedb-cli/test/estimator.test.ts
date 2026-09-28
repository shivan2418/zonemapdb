import { describe, expect, test } from "vitest";
import {
  GZIP_RATIO,
  MANIFEST_BUDGET_BYTES,
  estimateCosts,
  estimateEqualityQueryCost,
  estimateIndexSize,
  estimateManifestBytes,
  estimateRangeQueryCost,
  estimateBlockCount,
  profileDataset,
  recommendBlockBytes,
  type FieldProfile,
} from "../src/estimator.js";
import type { FieldConfig } from "../src/types.js";

describe("estimateBlockCount", () => {
  test("Axis 1: ceil(datasetBytes / T)", () => {
    expect(estimateBlockCount(10_000_000, 2_097_152)).toBe(Math.ceil(10_000_000 / 2_097_152));
    expect(estimateBlockCount(1, 2_097_152)).toBe(1);
    expect(estimateBlockCount(0, 2_097_152)).toBe(0);
  });
});

describe("recommendBlockBytes", () => {
  test("floors to 2MB when p95 is small", () => {
    expect(recommendBlockBytes(1000)).toBe(2_097_152);
  });

  test("follows p95 when it exceeds the 2MB floor, up to the 8MB clamp", () => {
    expect(recommendBlockBytes(3_000_000)).toBe(3_000_000);
    expect(recommendBlockBytes(50_000_000)).toBe(8_388_608);
  });

  test("never drops below the 512KB clamp (already implied by the 2MB floor, but exercised directly)", () => {
    expect(recommendBlockBytes(0)).toBe(2_097_152);
  });
});

describe("profileDataset", () => {
  const config = {
    sortField: "year",
    fields: {
      year: { kind: "number" } as FieldConfig,
      director: { kind: "string", indexed: true } as FieldConfig,
      tags: { kind: "string", indexed: true, multi: true } as FieldConfig,
      title: { kind: "string" } as FieldConfig, // not indexed — should not be profiled
    },
  };

  const records = [
    { year: 2000, director: "Nolan", tags: ["scifi", "thriller"], title: "A" },
    { year: 2001, director: "Nolan", tags: ["scifi"], title: "B" },
    { year: 2002, director: "Coppola", tags: ["drama"], title: "C" },
  ];

  test("profiles only non-sort, indexed fields", () => {
    const profile = profileDataset(records, config);
    expect(Object.keys(profile.fields).sort()).toEqual(["director", "tags"]);
  });

  test("computes recordCount, datasetBytes, sortField stats", () => {
    const profile = profileDataset(records, config);
    expect(profile.recordCount).toBe(3);
    expect(profile.datasetBytes).toBe(records.reduce((s, r) => s + Buffer.byteLength(JSON.stringify(r)), 0));
    expect(profile.sortFieldCardinality).toBe(3);
    expect(profile.sortValueBytes).toBeCloseTo((2000 .toString().length + 2001 .toString().length + 2002 .toString().length) / 3);
  });

  test("cardinality counts distinct values, occurrence counts tally repeats", () => {
    const profile = profileDataset(records, config);
    expect(profile.fields["director"]!.cardinality).toBe(2); // Nolan, Coppola
    expect(profile.fields["director"]!.occurrencesByValue.sort()).toEqual([1, 2]); // Coppola once, Nolan twice
  });

  test("multi-valued fields count distinct elements across all arrays", () => {
    const profile = profileDataset(records, config);
    expect(profile.fields["tags"]!.cardinality).toBe(3); // scifi, thriller, drama
  });

  test("totalValueBytes matches the sum of raw UTF-8 string bytes (the contains-warning column-size input)", () => {
    const profile = profileDataset(records, config);
    const expected = Buffer.byteLength("Nolan") * 2 + Buffer.byteLength("Coppola");
    expect(profile.fields["director"]!.totalValueBytes).toBe(expected);
  });

  test("maxRecordBytes is the single largest record's JSON size", () => {
    const profile = profileDataset(records, config);
    const expectedMax = Math.max(...records.map((r) => Buffer.byteLength(JSON.stringify(r))));
    expect(profile.maxRecordBytes).toBe(expectedMax);
  });

  test("ignores null/undefined values", () => {
    const withNulls = [...records, { year: 2003, director: null, tags: [], title: "D" }];
    const profile = profileDataset(withNulls, config);
    expect(profile.fields["director"]!.cardinality).toBe(2);
  });
});

describe("estimateIndexSize", () => {
  // A field profile hand-computed to make the ADR-0003 §11 formula arithmetic easy to check by hand.
  const field: FieldProfile = {
    kind: "string",
    cardinality: 2,
    avgValueBytes: 10,
    truncValueBytes: 10,
    occurrencesByValue: [3, 7], // one value in 3 records, the other in 7
    trigramWeightedLength: 40,
    distinctTrigramCount: 5,
    totalValueBytes: 100,
  };

  test("baseIndex_f = cardinality * avgTermBytes + postings_f * 2B, postings_f = Σ min(occ, blockCount)", () => {
    const blockCount = 5;
    const result = estimateIndexSize(field, blockCount, { indexChunkBytes: 45_000 });
    // postings_f = min(3,5) + min(7,5) = 3 + 5 = 8
    const expectedPostings = 8;
    const expectedBaseBytes = field.cardinality * field.avgValueBytes + expectedPostings * 2;
    expect(result.baseBytes).toBe(Math.round(expectedBaseBytes));
    expect(result.baseChunks).toBe(Math.ceil(expectedBaseBytes / 45_000));
    expect(result.reversedBytes).toBeUndefined();
    expect(result.trigramBytes).toBeUndefined();
  });

  test("postings_f caps occurrences at blockCount when occurrences exceed it", () => {
    const blockCount = 4; // both 3 and 7 would be capped: min(3,4)=3, min(7,4)=4
    const result = estimateIndexSize(field, blockCount, { indexChunkBytes: 45_000 });
    const expectedBaseBytes = field.cardinality * field.avgValueBytes + (3 + 4) * 2;
    expect(result.baseBytes).toBe(Math.round(expectedBaseBytes));
  });

  test("endsWith_f: reversed index is an additional same-shape structure (~baseIndex_f)", () => {
    const result = estimateIndexSize(field, 5, { indexChunkBytes: 45_000, endsWith: true });
    expect(result.reversedBytes).toBe(result.baseBytes);
    expect(result.reversedChunks).toBe(result.baseChunks);
  });

  test("contains_f = min(Σ(len-2)*occ, trigramCount*blockCount) * 2B", () => {
    const blockCount = 5;
    const result = estimateIndexSize(field, blockCount, { indexChunkBytes: 45_000, contains: true });
    // min(40, 5*5=25) = 25 → 25*2 = 50
    expect(result.trigramBytes).toBe(50);
    expect(result.trigramChunks).toBe(Math.ceil(50 / 45_000));
  });

  test("flags containsExceedsColumn when the trigram index estimate exceeds the raw column size", () => {
    const tinyColumn: FieldProfile = { ...field, totalValueBytes: 10 };
    const result = estimateIndexSize(tinyColumn, 5, { indexChunkBytes: 45_000, contains: true });
    expect(result.trigramBytes!).toBeGreaterThan(10);
    expect(result.containsExceedsColumn).toBe(true);
  });

  test("chunk count is 0 for an empty index rather than a phantom chunk", () => {
    const empty: FieldProfile = { ...field, cardinality: 0, avgValueBytes: 0, occurrencesByValue: [] };
    const result = estimateIndexSize(empty, 5, { indexChunkBytes: 45_000 });
    expect(result.baseBytes).toBe(0);
    expect(result.baseChunks).toBe(0);
  });
});

describe("estimateManifestBytes", () => {
  test("grows with blockCount and crosses the ~1MB gzip budget for enough blocks", () => {
    const profile = {
      recordCount: 1,
      datasetBytes: 1,
      p95RecordBytes: 1,
      maxRecordBytes: 1,
      sortField: "year",
      sortValueBytes: 4,
      sortFieldCardinality: 1,
      fields: {
        director: {
          kind: "string" as const,
          cardinality: 100,
          avgValueBytes: 10,
          truncValueBytes: 10,
          occurrencesByValue: Array(100).fill(1),
          trigramWeightedLength: 0,
          distinctTrigramCount: 0,
          totalValueBytes: 1000,
        },
      },
    };

    const small = estimateManifestBytes(profile, 10, { director: estimateIndexSize(profile.fields.director, 10, { indexChunkBytes: 45_000 }) });
    const huge = estimateManifestBytes(profile, 1_000_000, {
      director: estimateIndexSize(profile.fields.director, 1_000_000, { indexChunkBytes: 45_000 }),
    });

    expect(huge.bytes).toBeGreaterThan(small.bytes);
    expect(huge.gzipBytes).toBe(Math.round(huge.bytes * GZIP_RATIO));
    expect(small.overBudget).toBe(false);
    expect(huge.overBudget).toBe(true);
    expect(huge.gzipBytes).toBeGreaterThan(MANIFEST_BUDGET_BYTES);
  });
});

describe("estimateEqualityQueryCost / estimateRangeQueryCost", () => {
  const field: FieldProfile = {
    kind: "string",
    cardinality: 10,
    avgValueBytes: 10,
    truncValueBytes: 10,
    occurrencesByValue: Array(10).fill(10),
    trigramWeightedLength: 0,
    distinctTrigramCount: 0,
    totalValueBytes: 0,
  };

  test("equality query fetches one index chunk plus the candidate blocks its value scatters across", () => {
    const result = estimateEqualityQueryCost(field.cardinality, 100, 20, 2_097_152, 45_000);
    expect(result.requests).toBeGreaterThanOrEqual(1);
    expect(result.bytes).toBeGreaterThanOrEqual(45_000);
  });

  test("range query fetches only blocks (zonemap-only, no index chunk)", () => {
    const result = estimateRangeQueryCost(20, 2_097_152, 0.1);
    expect(result.requests).toBe(2); // ceil(20 * 0.1)
    expect(result.bytes).toBe(2 * 2_097_152);
  });

  test("both return zero cost against zero blocks", () => {
    expect(estimateRangeQueryCost(0, 2_097_152)).toEqual({ bytes: 0, requests: 0 });
  });
});

describe("estimateCosts", () => {
  test("orchestrates all axes off a profile + resolved knobs", () => {
    const config = {
      sortField: "year",
      fields: {
        year: { kind: "number" } as FieldConfig,
        director: { kind: "string", indexed: true } as FieldConfig,
      },
    };
    const records = Array.from({ length: 50 }, (_, i) => ({
      year: 2000 + (i % 20),
      director: i % 2 === 0 ? "Nolan" : "Coppola",
    }));
    const profile = profileDataset(records, config);
    const result = estimateCosts(profile, config.fields, { blockBytes: 2_097_152, indexChunkBytes: 45_000 });

    expect(result.blockCount).toBeGreaterThan(0);
    expect(result.indexes["director"]).toBeDefined();
    expect(result.perQuery.equality).toBeDefined();
    expect(result.perQuery.range.requests).toBeGreaterThan(0);
    expect(result.manifest.bytes).toBeGreaterThan(0);
  });

  test("omits the representative equality query when no field is indexed", () => {
    const config = { sortField: "year", fields: { year: { kind: "number" } as FieldConfig } };
    const profile = profileDataset([{ year: 2000 }], config);
    const result = estimateCosts(profile, config.fields, { blockBytes: 2_097_152, indexChunkBytes: 45_000 });
    expect(result.perQuery.equality).toBeUndefined();
  });
});

describe("profileDataset — sampled population override", () => {
  const sample = [
    { year: 1999, title: "The Matrix" },
    { year: 2000, title: "Gladiator" },
  ];

  test("takes recordCount and datasetBytes from the population, not the sample, when provided", () => {
    const profile = profileDataset(sample, { sortField: "year", fields: {} }, { recordCount: 500_000, datasetBytes: 250_000_000 });
    expect(profile.recordCount).toBe(500_000);
    expect(profile.datasetBytes).toBe(250_000_000);
  });

  test("without a population, the sample is its own population (full-scan / inspect)", () => {
    const profile = profileDataset(sample, { sortField: "year", fields: {} });
    expect(profile.recordCount).toBe(2);
  });

  test("a large population drives blockCount up even from a tiny sample", () => {
    const sampled = profileDataset(sample, { sortField: "year", fields: {} }, { recordCount: 500_000, datasetBytes: 250_000_000 });
    const costs = estimateCosts(sampled, [{ name: "year", kind: "number", indexed: true, absent: false, multi: false }], {
      blockBytes: 2_097_152,
      indexChunkBytes: 46_080,
    });
    expect(costs.blockCount).toBe(estimateBlockCount(250_000_000, 2_097_152));
    expect(costs.blockCount).toBeGreaterThan(1);
  });
});
