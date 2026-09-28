import { describe, expect, test } from "vitest";
import { computeMissingTail, computeSplitPoints, buildManifest } from "../src/manifest.js";
import type { ResolvedConfig, BlockDescriptor } from "../src/types.js";

const config: ResolvedConfig = {
  collection: "movies",
  inputPath: "data/movies.ndjson",
  output: "public/zonemapdb",
  clientOut: "src/zonemapdb",
  basePath: "/zonemapdb",
  blockBytes: 2_097_152,
  indexChunkBytes: 45_000,
  sortField: "year",
  fields: {
    year: { kind: "number" },
    title: { kind: "string" },
  },
};

describe("computeSplitPoints", () => {
  test("returns N+1 monotonic boundaries for N blocks", () => {
    const groups = [
      [{ year: 2000 }, { year: 2001 }],
      [{ year: 2002 }, { year: 2002 }],
      [{ year: 2005 }],
    ];
    const points = computeSplitPoints(groups, "year");
    // 3 blocks → 4 boundaries: each block's min, plus the last block's max.
    expect(points).toEqual([2000, 2002, 2005, 2005]);
  });

  test("returns an empty array for no blocks", () => {
    expect(computeSplitPoints([], "year")).toEqual([]);
  });
});

describe("computeMissingTail", () => {
  test("returns undefined when every record has a real sort-field value", () => {
    const groups = [[{ year: 2000 }], [{ year: 2001 }]];
    expect(computeMissingTail(groups, "year")).toBeUndefined();
  });

  test("reports the earliest block containing a missing value and counts null vs absent separately (T13)", () => {
    const groups = [
      [{ year: 2000 }, { year: 2001 }],
      [{ year: 2002 }, { year: null }],
      [{ year: null }, {}],
    ];
    expect(computeMissingTail(groups, "year")).toEqual({ blockFrom: 1, nullCount: 2, absentCount: 1 });
  });
});

describe("buildManifest", () => {
  const blockFiles: BlockDescriptor[] = [
    { hash: "aaaa000000000000", bytes: 100, count: 2 },
    { hash: "bbbb000000000000", bytes: 120, count: 3 },
  ];
  const splitPoints = [2000, 2005];

  test("matches the spec's manifest shape for the sort-field-only case", () => {
    const manifest = buildManifest({
      config,
      blockFiles,
      splitPoints,
      formatVersion: 0,
      generatorVersion: "0.0.0",
    });

    expect(manifest.formatVersion).toBe(0);
    expect(manifest.generatorVersion).toBe("0.0.0");
    expect(manifest.dataset).toEqual({
      collection: "movies",
      recordCount: 5,
      blockCount: 2,
      sortField: "year",
    });
    expect(manifest.blocks).toEqual(blockFiles);
    expect(manifest.zonemap).toEqual({ year: { splitPoints: [2000, 2005] } });
    expect(manifest.schema.sortField).toBe("year");
    expect(manifest.schema.fields.year).toEqual({
      kind: "number",
      isDate: false,
      indexed: true,
      operators: ["equals", "in", "gt", "gte", "lt", "lte", "not"],
      pruning: ["equals", "in", "gt", "gte", "lt", "lte"],
    });
    // Unindexed, but still queryable: every filter on it is a rider (ADR-0013).
    expect(manifest.schema.fields.title).toEqual({
      kind: "string",
      isDate: false,
      indexed: false,
      operators: ["equals", "in", "startsWith", "endsWith", "contains", "not"],
      pruning: [],
    });
  });

  test("per-block counts sum to recordCount", () => {
    const manifest = buildManifest({
      config,
      blockFiles,
      splitPoints,
      formatVersion: 0,
      generatorVersion: "0.0.0",
    });
    const sum = manifest.blocks.reduce((acc, s) => acc + s.count, 0);
    expect(sum).toBe(manifest.dataset.recordCount);
  });

  test("marks a date sort field with isDate: true", () => {
    const dateConfig: ResolvedConfig = {
      ...config,
      sortField: "releaseDate",
      fields: { releaseDate: { kind: "date" } },
    };
    const manifest = buildManifest({
      config: dateConfig,
      blockFiles: [],
      splitPoints: [],
      formatVersion: 0,
      generatorVersion: "0.0.0",
    });
    expect(manifest.schema.fields.releaseDate).toEqual({
      kind: "date",
      isDate: true,
      indexed: true,
      operators: ["equals", "in", "gt", "gte", "lt", "lte", "not"],
      pruning: ["equals", "in", "gt", "gte", "lt", "lte"],
    });
  });

  test("a non-sort field with no `indexed` opt-in accepts its type's operators, none of which prune", () => {
    const manifest = buildManifest({
      config,
      blockFiles,
      splitPoints,
      formatVersion: 0,
      generatorVersion: "0.0.0",
    });
    expect(manifest.schema.fields.title).toEqual({ kind: "string", isDate: false, indexed: false, operators: ["equals", "in", "startsWith", "endsWith", "contains", "not"], pruning: [] });
    expect(manifest.indexes).toEqual({});
  });

  test("an opted-in secondary string field prunes equals/in/startsWith and merges its zonemap + index directory", () => {
    const indexedConfig: ResolvedConfig = {
      ...config,
      fields: { ...config.fields, title: { kind: "string", indexed: true } },
    };
    const manifest = buildManifest({
      config: indexedConfig,
      blockFiles,
      splitPoints,
      secondaryZonemaps: { title: { pairs: [["Alpha", "Zeta"]], truncated: true } },
      indexChunkDirs: { title: [{ from: "Alpha", to: "Zeta", file: "index/title/abc123.json" }] },
      formatVersion: 0,
      generatorVersion: "0.0.0",
    });

    expect(manifest.schema.fields.title).toEqual({
      kind: "string",
      isDate: false,
      indexed: true,
      operators: ["equals", "in", "startsWith", "endsWith", "contains", "not"],
      pruning: ["equals", "in", "startsWith"],
    });
    expect(manifest.zonemap.title).toEqual({ pairs: [["Alpha", "Zeta"]], truncated: true });
    expect(manifest.indexes.title).toEqual({
      operators: ["equals", "in", "startsWith", "endsWith", "contains", "not"],
      chunks: [{ from: "Alpha", to: "Zeta", file: "index/title/abc123.json" }],
    });
    // the sort field's own zonemap entry is untouched
    expect(manifest.zonemap.year).toEqual({ splitPoints: [2000, 2005] });
  });

  test("an opted-in secondary number field gets the range operators, pruned by its [min,max] pairs", () => {
    const indexedConfig: ResolvedConfig = {
      ...config,
      fields: { ...config.fields, rating: { kind: "number", indexed: true } },
    };
    const manifest = buildManifest({
      config: indexedConfig,
      blockFiles,
      splitPoints,
      formatVersion: 0,
      generatorVersion: "0.0.0",
    });
    expect(manifest.schema.fields.rating).toEqual({
      kind: "number",
      isDate: false,
      indexed: true,
      operators: ["equals", "in", "gt", "gte", "lt", "lte", "not"],
      pruning: ["equals", "in", "gt", "gte", "lt", "lte"],
    });
  });

  test("a secondary date field gets ranges too — ISO-8601 pairs are stored untruncated, so they compare chronologically", () => {
    const indexedConfig: ResolvedConfig = {
      ...config,
      fields: { ...config.fields, released: { kind: "date", indexed: true } },
    };
    const manifest = buildManifest({
      config: indexedConfig,
      blockFiles,
      splitPoints,
      formatVersion: 0,
      generatorVersion: "0.0.0",
    });
    expect(manifest.schema.fields.released!.operators).toEqual(["equals", "in", "gt", "gte", "lt", "lte", "not"]);
    expect(manifest.schema.fields.released!.pruning).toEqual(["equals", "in", "gt", "gte", "lt", "lte"]);
  });

  test("a secondary STRING field is deliberately denied ranges — string comparison is lexicographic", () => {
    // Measured on real card data: `power` is a string because 1.6% of values are "*", "1+*", "∞".
    // A lexicographic `gte: "2"` silently drops every double-digit power ("10" < "2"), which is a
    // confidently wrong answer rather than a missing feature. Only the SORT field gets string ranges,
    // where the ordering is the physical one the user chose.
    const indexedConfig: ResolvedConfig = {
      ...config,
      fields: { ...config.fields, title: { kind: "string", indexed: true } },
    };
    const manifest = buildManifest({
      config: indexedConfig,
      blockFiles,
      splitPoints,
      formatVersion: 0,
      generatorVersion: "0.0.0",
    });
    const ops = manifest.schema.fields.title!.operators;
    expect(ops).toEqual(["equals", "in", "startsWith", "endsWith", "contains", "not"]);
    for (const rangeOp of ["gt", "gte", "lt", "lte"]) expect(ops).not.toContain(rangeOp);
  });

  test("T6: endsWith opt-in makes endsWith prune and merges the reversed chunk directory", () => {
    const indexedConfig: ResolvedConfig = {
      ...config,
      fields: { ...config.fields, title: { kind: "string", indexed: true, endsWith: true } },
    };
    const manifest = buildManifest({
      config: indexedConfig,
      blockFiles,
      splitPoints,
      indexChunkDirs: { title: [{ from: "Alpha", to: "Zeta", file: "index/title/abc123.json" }] },
      reversedChunkDirs: { title: [{ from: "a", to: "z", file: "index/title/reversed/def456.json" }] },
      formatVersion: 0,
      generatorVersion: "0.0.0",
    });

    expect(manifest.schema.fields.title!.operators).toEqual(["equals", "in", "startsWith", "endsWith", "contains", "not"]);
    expect(manifest.schema.fields.title!.pruning).toEqual(["equals", "in", "startsWith", "endsWith"]);
    expect(manifest.indexes.title).toEqual({
      operators: ["equals", "in", "startsWith", "endsWith", "contains", "not"],
      chunks: [{ from: "Alpha", to: "Zeta", file: "index/title/abc123.json" }],
      reversed: { chunks: [{ from: "a", to: "z", file: "index/title/reversed/def456.json" }] },
    });
  });

  test("T6: contains opt-in makes contains prune and merges the trigram chunk directory", () => {
    const indexedConfig: ResolvedConfig = {
      ...config,
      fields: { ...config.fields, title: { kind: "string", indexed: true, contains: true } },
    };
    const manifest = buildManifest({
      config: indexedConfig,
      blockFiles,
      splitPoints,
      indexChunkDirs: { title: [{ from: "Alpha", to: "Zeta", file: "index/title/abc123.json" }] },
      trigramChunkDirs: { title: [{ from: "aaa", to: "zzz", file: "index/title/trigram/ghi789.json" }] },
      formatVersion: 0,
      generatorVersion: "0.0.0",
    });

    expect(manifest.schema.fields.title!.operators).toEqual(["equals", "in", "startsWith", "endsWith", "contains", "not"]);
    expect(manifest.schema.fields.title!.pruning).toEqual(["equals", "in", "startsWith", "contains"]);
    expect(manifest.indexes.title).toEqual({
      operators: ["equals", "in", "startsWith", "endsWith", "contains", "not"],
      chunks: [{ from: "Alpha", to: "Zeta", file: "index/title/abc123.json" }],
      trigram: { chunks: [{ from: "aaa", to: "zzz", file: "index/title/trigram/ghi789.json" }] },
    });
  });

  test("T6: reversed/trigram chunk dirs merge safely even without a matching indexChunkDirs entry for that field", () => {
    const indexedConfig: ResolvedConfig = {
      ...config,
      fields: { ...config.fields, title: { kind: "string", indexed: true, endsWith: true } },
    };
    const manifest = buildManifest({
      config: indexedConfig,
      blockFiles,
      splitPoints,
      // Deliberately omit indexChunkDirs.title — buildManifest must not crash on `indexes[field]!`.
      reversedChunkDirs: { title: [{ from: "a", to: "z", file: "index/title/reversed/def456.json" }] },
      formatVersion: 0,
      generatorVersion: "0.0.0",
    });
    expect(manifest.indexes.title).toEqual({
      operators: ["equals", "in", "startsWith", "endsWith", "contains", "not"],
      chunks: [],
      reversed: { chunks: [{ from: "a", to: "z", file: "index/title/reversed/def456.json" }] },
    });
  });

  test("an opted-in secondary boolean field prunes only equals", () => {
    const indexedConfig: ResolvedConfig = {
      ...config,
      fields: { ...config.fields, isClassic: { kind: "boolean", indexed: true } },
    };
    const manifest = buildManifest({
      config: indexedConfig,
      blockFiles,
      splitPoints,
      formatVersion: 0,
      generatorVersion: "0.0.0",
    });
    expect(manifest.schema.fields.isClassic).toEqual({
      kind: "boolean",
      isDate: false,
      indexed: true,
      operators: ["equals", "not"],
      pruning: ["equals"],
    });
  });

  test("T7: a multi-valued field carries multi: true; a non-multi field omits the key entirely", () => {
    const indexedConfig: ResolvedConfig = {
      ...config,
      fields: { ...config.fields, genres: { kind: "string", indexed: true, multi: true } },
    };
    const manifest = buildManifest({
      config: indexedConfig,
      blockFiles,
      splitPoints,
      formatVersion: 0,
      generatorVersion: "0.0.0",
    });
    expect(manifest.schema.fields.genres).toEqual({
      kind: "string",
      isDate: false,
      indexed: true,
      operators: ["equals", "in", "startsWith", "endsWith", "contains", "not"],
      pruning: ["equals", "in", "startsWith"],
      multi: true,
    });
    expect(manifest.schema.fields.title!.multi).toBeUndefined();
  });

  test("absent/nullable are recorded on the field, and unlock exactly the missing-value operators the data allows", () => {
    const missingConfig: ResolvedConfig = {
      ...config,
      fields: {
        ...config.fields,
        year: { kind: "number", absent: true, nullable: true },
        title: { kind: "string", indexed: true, absent: true },
        subtitle: { kind: "string", indexed: true, nullable: true },
        rating: { kind: "number", indexed: true, absent: true, nullable: true },
        tags: { kind: "string", indexed: true, multi: true, absent: true, nullable: true },
        notes: { kind: "string", nullable: true },
      },
    };
    const manifest = buildManifest({
      config: missingConfig,
      blockFiles,
      splitPoints,
      formatVersion: 0,
      generatorVersion: "0.0.0",
    });
    const { fields } = manifest.schema;
    expect(fields.title).toEqual({
      kind: "string",
      isDate: false,
      indexed: true,
      operators: ["equals", "in", "startsWith", "endsWith", "contains", "not", "isAbsent", "exists"],
      pruning: ["equals", "in", "startsWith"],
      absent: true,
    });
    expect(fields.subtitle!.operators).toEqual(["equals", "in", "startsWith", "endsWith", "contains", "not", "isNull", "exists"]);
    expect(fields.subtitle!.nullable).toBe(true);
    expect(fields.rating!.operators).toEqual(["equals", "in", "gt", "gte", "lt", "lte", "not", "isNull", "isAbsent", "exists"]);
    // Missing-value operators are riders: they never prune.
    expect(fields.rating!.pruning).toEqual(["equals", "in", "gt", "gte", "lt", "lte"]);
    // The sort field and list fields record the facts (for the record type) but get no missing-value
    // operators: their missing values have their own rules (ADR-0002 §9, ADR-0010).
    expect(fields.year!.operators).not.toContain("isNull");
    expect(fields.year).toMatchObject({ absent: true, nullable: true });
    expect(fields.tags!.operators).toEqual(["equals", "in", "startsWith", "endsWith", "contains", "not"]);
    expect(fields.tags).toMatchObject({ absent: true, nullable: true });
    // An unindexed field is queryable too — every operator a rider — and records that it can be null.
    expect(fields.notes).toMatchObject({
      indexed: false,
      operators: ["equals", "in", "startsWith", "endsWith", "contains", "not", "isNull", "exists"],
      pruning: [],
      nullable: true,
    });
  });

  test("a field with neither flag omits both keys entirely", () => {
    const manifest = buildManifest({ config, blockFiles, splitPoints, formatVersion: 0, generatorVersion: "0.0.0" });
    expect(manifest.schema.fields.year!.absent).toBeUndefined();
    expect(manifest.schema.fields.year!.nullable).toBeUndefined();
  });

  test("T8: a declared pk on the sort field carries schema.pk + the field's pk: true, no indexed requirement", () => {
    const pkConfig: ResolvedConfig = { ...config, pk: "year" };
    const manifest = buildManifest({
      config: pkConfig,
      blockFiles,
      splitPoints,
      formatVersion: 0,
      generatorVersion: "0.0.0",
    });
    expect(manifest.schema.pk).toBe("year");
    expect(manifest.schema.fields.year!.pk).toBe(true);
    expect(manifest.schema.fields.title!.pk).toBeUndefined();
  });

  test("T8: a declared pk on an indexed non-sort field carries schema.pk + the field's pk: true", () => {
    const pkConfig: ResolvedConfig = {
      ...config,
      pk: "title",
      fields: { ...config.fields, title: { kind: "string", indexed: true } },
    };
    const manifest = buildManifest({
      config: pkConfig,
      blockFiles,
      splitPoints,
      indexChunkDirs: { title: [{ from: "Alpha", to: "Zeta", file: "index/title/abc123.json" }] },
      formatVersion: 0,
      generatorVersion: "0.0.0",
    });
    expect(manifest.schema.pk).toBe("title");
    expect(manifest.schema.fields.title!.pk).toBe(true);
    expect(manifest.schema.fields.year!.pk).toBeUndefined();
  });

  test("T8: no pk configured omits schema.pk entirely", () => {
    const manifest = buildManifest({
      config,
      blockFiles,
      splitPoints,
      formatVersion: 0,
      generatorVersion: "0.0.0",
    });
    expect(manifest.schema.pk).toBeUndefined();
  });

  test("carries dataset.compression when the build compressed, and omits it entirely when it didn't", () => {
    for (const compression of ["gzip", "brotli"] as const) {
      const built = buildManifest({
        config: { ...config, compression },
        blockFiles,
        splitPoints,
        formatVersion: 0,
        generatorVersion: "0.0.0",
      });
      expect(built.dataset.compression).toBe(compression);
      // the pre-`compression` boolean is not emitted alongside it — one field, one source of truth
      expect(built.dataset.gzip).toBeUndefined();
    }

    const plain = buildManifest({ config, blockFiles, splitPoints, formatVersion: 0, generatorVersion: "0.0.0" });
    expect(plain.dataset.compression).toBeUndefined();
    expect(plain.dataset.gzip).toBeUndefined();
  });
});
