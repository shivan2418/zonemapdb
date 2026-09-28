import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { build } from "../src/build.js";
import { estimateCosts, profileDataset } from "../src/estimator.js";
import { inspect } from "../src/inspect.js";
import type { ZoneDbConfig } from "../src/types.js";

const MOVIES = [
  { year: 1999, title: "The Matrix", director: "Wachowski" },
  { year: 2000, title: "Gladiator", director: "Scott" },
  { year: 2000, title: "Snatch", director: "Ritchie" },
  { year: 2000, title: "Memento", director: "Nolan" },
  { year: 2003, title: "The Matrix Reloaded", director: "Wachowski" },
  { year: 2008, title: "The Dark Knight", director: "Nolan" },
  { year: 2010, title: "Inception", director: "Nolan" },
  { year: 2010, title: "Toy Story 3", director: "Unkrich" },
  { year: 2014, title: "Interstellar", director: "Nolan" },
  { year: 2019, title: "Parasite", director: "Bong" },
];

const config: ZoneDbConfig = {
  collection: "movies",
  input: { path: "movies.ndjson" },
  schema: {
    sortField: "year",
    fields: {
      year: { kind: "number" },
      title: { kind: "string", indexed: true, contains: true },
      director: { kind: "string", indexed: true, endsWith: true },
    },
  },
};

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), "zonedb-inspect-"));
  writeFileSync(path.join(tmpDir, "movies.ndjson"), MOVIES.map((m) => JSON.stringify(m)).join("\n") + "\n");
  writeFileSync(path.join(tmpDir, "zonedb.config.json"), JSON.stringify(config, null, 2));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("inspect --config", () => {
  test("estimates costs from the unbuilt input without writing any output", () => {
    const report = inspect({ configPath: path.join(tmpDir, "zonedb.config.json") });

    expect(report.mode).toBe("config");
    expect(report.collection).toBe("movies");
    expect(report.recordCount).toBe(MOVIES.length);
    expect(report.blockCount).toBeGreaterThan(0);
    expect(report.manifestBytes).toBeGreaterThan(0);
    expect(report.indexes["title"]).toBeDefined();
    expect(report.indexes["director"]).toBeDefined();
    expect(report.indexes["title"]!.trigramBytes).toBeGreaterThan(0);
    expect(report.indexes["director"]!.reversedBytes).toBe(report.indexes["director"]!.baseBytes);
    expect(report.perQuery.range.requests).toBeGreaterThan(0);

    // no build side effects
    expect(existsSync(path.join(tmpDir, "public"))).toBe(false);
  });

  test("requires exactly one of --config/--dir", () => {
    expect(() => inspect({})).toThrow(/needs/);
    expect(() =>
      inspect({ configPath: path.join(tmpDir, "zonedb.config.json"), dir: path.join(tmpDir, "public") }),
    ).toThrow(/exactly one/);
  });
});

describe("inspect --dir", () => {
  function builtDir(): string {
    build(config, { baseDir: tmpDir, generatorVersion: "0.1.0", formatVersion: 0 });
    return path.join(tmpDir, "public", "zonedb");
  }

  test("reports real block/manifest/index sizes read from the built output", () => {
    const outputDir = builtDir();
    const report = inspect({ dir: outputDir });

    expect(report.mode).toBe("dir");
    expect(report.collection).toBe("movies");
    expect(report.recordCount).toBe(MOVIES.length);
    expect(report.blocks.count).toBe(report.blockCount);
    expect(report.blocks.totalBytes).toBeGreaterThan(0);
    expect(report.manifestBytes).toBeGreaterThan(0);
    expect(report.manifestGzipBytes).toBeGreaterThan(0);
    expect(report.manifestGzipBytes).toBeLessThan(report.manifestBytes);

    expect(report.indexes["title"]!.baseBytes).toBeGreaterThan(0);
    expect(report.indexes["title"]!.trigramBytes).toBeGreaterThan(0);
    expect(report.indexes["director"]!.reversedBytes).toBeGreaterThan(0);
  });

  test("throws a clear error when the directory has no manifest.json", () => {
    const emptyDir = mkdtempSync(path.join(tmpdir(), "zonedb-empty-"));
    expect(() => inspect({ dir: emptyDir })).toThrow(/manifest\.json/);
    rmSync(emptyDir, { recursive: true, force: true });
  });

  test("flags a field whose trigram index is bigger than its raw column", () => {
    // Tiny director values with `contains` opted in — trigram postings dwarf the handful of raw string bytes.
    const tinyConfig: ZoneDbConfig = {
      ...config,
      schema: {
        sortField: "year",
        fields: {
          year: { kind: "number" },
          title: { kind: "string" },
          director: { kind: "string", indexed: true, contains: true },
        },
      },
    };
    build(tinyConfig, { baseDir: tmpDir, generatorVersion: "0.1.0", formatVersion: 0 });
    const report = inspect({ dir: path.join(tmpDir, "public", "zonedb") });
    expect(report.warnings.some((w) => w.includes("contains(director)"))).toBe(true);
  });
});

describe("warnings (ADR-0005 §4: skew / oversized-record / low-card-sort)", () => {
  test("config mode: flags a low-cardinality sort field", () => {
    const lowCardConfig: ZoneDbConfig = {
      collection: "events",
      input: { path: "events.ndjson" },
      schema: { sortField: "year", fields: { year: { kind: "number" }, name: { kind: "string" } } },
    };
    const records = Array.from({ length: 30 }, (_, i) => ({ year: 2000, name: `event-${i}` }));
    writeFileSync(path.join(tmpDir, "events.ndjson"), records.map((r) => JSON.stringify(r)).join("\n") + "\n");
    writeFileSync(path.join(tmpDir, "lowcard.config.json"), JSON.stringify(lowCardConfig, null, 2));

    const report = inspect({ configPath: path.join(tmpDir, "lowcard.config.json") });
    expect(report.warnings.some((w) => w.includes("distinct value"))).toBe(true);
  });

  test("config mode: flags a record bigger than the block-byte target", () => {
    const oversizedConfig: ZoneDbConfig = {
      collection: "blobs",
      input: { path: "blobs.ndjson" },
      schema: { sortField: "id", fields: { id: { kind: "number" }, blob: { kind: "string" } } },
      blockBytes: 100,
    };
    const records = [
      { id: 1, blob: "x".repeat(500) },
      { id: 2, blob: "y" },
    ];
    writeFileSync(path.join(tmpDir, "blobs.ndjson"), records.map((r) => JSON.stringify(r)).join("\n") + "\n");
    writeFileSync(path.join(tmpDir, "oversized.config.json"), JSON.stringify(oversizedConfig, null, 2));

    const report = inspect({ configPath: path.join(tmpDir, "oversized.config.json") });
    expect(report.warnings.some((w) => w.includes("oversized"))).toBe(true);
  });

  test("dir mode: flags a block holding one oversized record", () => {
    const oversizedConfig: ZoneDbConfig = {
      collection: "blobs",
      input: { path: "blobs.ndjson" },
      schema: { sortField: "id", fields: { id: { kind: "number" }, blob: { kind: "string" } } },
      blockBytes: 100,
    };
    const records = [
      { id: 1, blob: "a" },
      { id: 2, blob: "b" },
      { id: 3, blob: "x".repeat(2000) },
    ];
    writeFileSync(path.join(tmpDir, "blobs.ndjson"), records.map((r) => JSON.stringify(r)).join("\n") + "\n");
    build(oversizedConfig, { baseDir: tmpDir, generatorVersion: "0.1.0", formatVersion: 0 });

    const report = inspect({ dir: path.join(tmpDir, "public", "zonedb") });
    expect(report.warnings.some((w) => w.includes("single record"))).toBe(true);
  });
});

describe("reconciliation: inspect --config vs a real build for the same config (acceptance criterion #4)", () => {
  test("inspect --config reports byte-exact manifest/index sizes matching what build actually writes", () => {
    const configReport = inspect({ configPath: path.join(tmpDir, "zonedb.config.json") });
    const { manifest, outputDir } = build(config, { baseDir: tmpDir, generatorVersion: "0.1.0", formatVersion: 0 });

    const realManifestJson = readFileSync(path.join(outputDir, "manifest.json"), "utf8");
    expect(configReport.manifestBytes).toBe(Buffer.byteLength(realManifestJson, "utf8"));
    expect(configReport.blockCount).toBe(manifest.dataset.blockCount);
    expect(configReport.blocks.totalBytes).toBe(manifest.blocks.reduce((s, sh) => s + sh.bytes, 0));
    expect(configReport.indexes["title"]!.trigramBytes).toBeGreaterThan(0);

    // Cross-check against the real on-disk index chunk bytes for "director" (base + reversed).
    const dirDescriptor = manifest.indexes["director"]!;
    const realBaseBytes = dirDescriptor.chunks.reduce((sum, c) => sum + statSync(path.join(outputDir, c.file)).size, 0);
    expect(configReport.indexes["director"]!.baseBytes).toBe(realBaseBytes);
  });
});

describe("estimator.ts (pure, sampled): stays a reasonable order-of-magnitude estimate", () => {
  test("estimated block count and index-field cardinality track a real build's output", () => {
    const records = MOVIES;
    const resolvedFields = config.schema.fields;
    const profile = profileDataset(records, { sortField: "year", fields: resolvedFields });
    const cost = estimateCosts(profile, resolvedFields, { blockBytes: 2_097_152, indexChunkBytes: 45_000 });

    const { manifest } = build(config, { baseDir: tmpDir, generatorVersion: "0.1.0", formatVersion: 0 });

    // Same tiny dataset easily fits in one block either way (no equal-key-run divergence at this scale).
    expect(cost.blockCount).toBe(manifest.dataset.blockCount);

    // Cardinality reconciles exactly: both count the same distinct raw values off the same records.
    expect(profile.fields["director"]!.cardinality).toBe(new Set(records.map((r) => r.director)).size);
    expect(profile.fields["title"]!.cardinality).toBe(new Set(records.map((r) => r.title)).size);
  });
});

describe("inspect --dir over a gzipped deploy (ADR-0002 §8)", () => {
  test("reads the relocated manifest and the compressed chunks, reporting logical bytes", () => {
    // Logical, not on-disk, bytes: the report compares an index against its own column
    // (`containsExceedsColumn`) and must agree with `inspect --config`, which only ever sees
    // uncompressed content. Measuring compressed bytes here would break both.
    const plain = build(config, { baseDir: tmpDir, generatorVersion: "0.1.0", formatVersion: 0 });
    const plainReport = inspect({ dir: plain.outputDir });

    const gz = build(
      { ...config, gzip: true, output: "out-gz" },
      { baseDir: tmpDir, generatorVersion: "0.1.0", formatVersion: 0 },
    );
    const gzReport = inspect({ dir: gz.outputDir });

    // Logical bytes = the decompressed manifest, NOT the file on disk. (It isn't equal to the plain
    // build's either: every chunk path in it gained a `.gz` suffix, so it is genuinely a bit longer.)
    const onDisk = readFileSync(path.join(gz.outputDir, "manifest.json.gz"));
    const logical = gunzipSync(onDisk).toString("utf8");
    expect(gzReport.manifestBytes).toBe(Buffer.byteLength(logical, "utf8"));
    expect(onDisk.length).toBeLessThan(gzReport.manifestBytes);

    // Chunk CONTENTS are byte-identical across the two builds, so these must match exactly.
    expect(gzReport.indexes["title"]!.trigramBytes).toBe(plainReport.indexes["title"]!.trigramBytes);
    expect(gzReport.indexes["director"]!.reversedBytes).toBe(plainReport.indexes["director"]!.reversedBytes);
    expect(gzReport.blocks.totalBytes).toBe(plainReport.blocks.totalBytes);
  });

  test("an empty directory still reports the actionable 'has it been built yet?' error", () => {
    const empty = path.join(tmpDir, "nothing-here");
    writeFileSync(path.join(tmpDir, "placeholder"), "");
    expect(() => inspect({ dir: empty })).toThrow(/built yet/);
  });
});
