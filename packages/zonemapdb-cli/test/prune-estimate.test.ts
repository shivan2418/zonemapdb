import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { build } from "../src/build.js";
import { init, resolveInitConfig, scanInput } from "../src/init.js";
import { BlockShareEstimator } from "../src/prune-estimate.js";
import { Reservoir } from "../src/reservoir.js";

/**
 * 20,000 records sorted by `id`. Two kinds of field: ones whose values follow `id` (each value in one
 * contiguous run, so an index prunes to a block or two) and ones that cycle (every value in every
 * block, so an index narrows nothing).
 */
const RECORDS = 20_000;
const records = Array.from({ length: RECORDS }, (_, id) => ({
  id,
  batch: `b${Math.floor(id / 200)}`, // 100 values, clustered
  region: `r${Math.floor(id / 400)}`, // 50 values, clustered
  color: `c${id % 20}`, // 20 values, scattered
  size: `s${id % 5}`, // 5 values, scattered
  shelf: `h${Math.floor(id / 5000)}`, // 4 values, clustered
}));
const BLOCK_BYTES = 65_536;

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), "zonemapdb-prune-"));
  writeFileSync(path.join(tmpDir, "items.ndjson"), records.map((r) => JSON.stringify(r)).join("\n") + "\n");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("BlockShareEstimator (#31)", () => {
  test("from the whole input, it reproduces the block counts exactly", () => {
    // 20 blocks of 1,000 records: a batch sits in one, a colour in all of them.
    const estimator = new BlockShareEstimator(records, "id", "number", RECORDS, 20);
    expect(estimator.meanShare("batch", false, 100)).toBeCloseTo(1 / 20);
    expect(estimator.meanShare("color", false, 20)).toBeCloseTo(1);
    expect(estimator.meanShare("shelf", false, 4)).toBeCloseTo(5 / 20);
  });

  test("from a sample, it keeps clustered and scattered fields on the right side of the line", () => {
    const reservoir = new Reservoir<Record<string, unknown>>(2000);
    for (const r of records) reservoir.add(r);
    const estimator = new BlockShareEstimator(reservoir.sample, "id", "number", RECORDS, 20);
    expect(estimator.meanShare("region", false, 50)).toBeLessThan(0.15);
    expect(estimator.meanShare("color", false, 20)).toBeGreaterThan(0.9);
    expect(estimator.meanShare("size", false, 5)).toBeGreaterThan(0.9);
  });

  test("a field the sample never holds has no estimate", () => {
    const estimator = new BlockShareEstimator(records, "id", "number", RECORDS, 20);
    expect(estimator.meanShare("missing", false, 0)).toBeUndefined();
  });
});

describe("init leaves out indexes that wouldn't prune (#31)", () => {
  const readOpts = { format: "ndjson" as const, delimiter: ",", fields: {} };

  test("a scattered field gives its slot to the next field that prunes", () => {
    const { inferred } = scanInput(path.join(tmpDir, "items.ndjson"), readOpts, { blockBytes: BLOCK_BYTES });
    expect(inferred.sortField).toBe("id");
    // By cardinality alone: batch, region, color. color and size would sit in every block.
    expect(inferred.indexedFields).toEqual(["batch", "region", "shelf"]);
    expect(inferred.unselectiveIndexes.map((u) => u.field)).toEqual(["color", "size"]);
    for (const u of inferred.unselectiveIndexes) expect(u.blockShare).toBeGreaterThan(0.9);
  });

  test("with too few blocks to judge, cardinality alone decides", () => {
    // The default 2 MiB block holds the whole input: one block, where every value is "in all of them".
    const { inferred } = scanInput(path.join(tmpDir, "items.ndjson"), readOpts);
    expect(inferred.indexedFields).toEqual(["batch", "region", "color"]);
    expect(inferred.unselectiveIndexes).toEqual([]);
  });

  test("init says why a field was left unindexed, and the build agrees", () => {
    const result = resolveInitConfig({
      cwd: tmpDir,
      configPath: path.join(tmpDir, "zonemapdb.config.json"),
      yes: true,
      inputPath: "items.ndjson",
      blockBytes: BLOCK_BYTES,
    });
    const fields = result.config.schema.fields;
    expect(fields.color!.indexed).toBeUndefined();
    expect(fields.shelf!.indexed).toBe(true);
    const notes = result.warnings.filter((w) => /init left/.test(w));
    expect(notes).toHaveLength(2);
    expect(notes[0]).toMatch(/init left "color" unindexed — sorted by "id", its average value would sit in about 100% of the data files/);
    expect(notes[0]).toMatch(/Add "indexed": true if you need to filter on "color" by itself/);

    // Index every candidate and build: the build warns about exactly the fields init left out.
    const everything = structuredClone(result.config);
    for (const name of ["batch", "region", "color", "size", "shelf"]) everything.schema.fields[name]!.indexed = true;
    const { warnings } = build(everything, { baseDir: tmpDir, generatorVersion: "0.1.0", formatVersion: 0 });
    const barelyPrunes = warnings.flatMap((w) => /index\((\w+)\): this index barely prunes/.exec(w)?.[1] ?? []);
    expect(barelyPrunes.sort()).toEqual(["color", "size"]);
  });

  test("an explicit --indexed choice wins and needs no note", () => {
    const result = resolveInitConfig({
      cwd: tmpDir,
      configPath: path.join(tmpDir, "zonemapdb.config.json"),
      yes: true,
      inputPath: "items.ndjson",
      blockBytes: BLOCK_BYTES,
      indexedFields: ["color"],
    });
    expect(result.config.schema.fields.color!.indexed).toBe(true);
    expect(result.warnings.filter((w) => /init left "color"/.test(w))).toEqual([]);
  });

  test("the check is judged against the sort field the config will use, not the inferred one", () => {
    // Sorted by id, batch clusters and tone scatters; sorted by color it's the other way round.
    const byColor = Array.from({ length: RECORDS }, (_, id) => ({
      id,
      color: `c${id % 20}`,
      tone: `t${Math.floor((id % 20) / 4)}`,
      batch: `b${Math.floor(id / 200)}`,
    }));
    writeFileSync(path.join(tmpDir, "colors.ndjson"), byColor.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const result = resolveInitConfig({
      cwd: tmpDir,
      configPath: path.join(tmpDir, "colors.config.json"),
      yes: true,
      inputPath: "colors.ndjson",
      blockBytes: BLOCK_BYTES,
      sortField: "color",
    });
    const fields = result.config.schema.fields;
    expect(result.config.schema.sortField).toBe("color");
    expect(fields.tone!.indexed).toBe(true);
    expect(fields.batch!.indexed).toBeUndefined();
    expect(result.warnings.filter((w) => /init left/.test(w))).toEqual([expect.stringMatching(/init left "batch" unindexed — sorted by "color"/)]);

    const both = structuredClone(result.config);
    both.schema.fields.batch!.indexed = true;
    const { warnings } = build(both, { baseDir: tmpDir, generatorVersion: "0.1.0", formatVersion: 0 });
    const barelyPrunes = warnings.flatMap((w) => /index\((\w+)\): this index barely prunes/.exec(w)?.[1] ?? []);
    expect(barelyPrunes).toEqual(["batch"]);
  });

  test("a sampled read judges pruning against the whole input's size, not the sample's", () => {
    // The first 5,000 records alone would make too few blocks to judge, and color would be indexed.
    const result = resolveInitConfig({
      cwd: tmpDir,
      configPath: path.join(tmpDir, "zonemapdb.config.json"),
      yes: true,
      inputPath: "items.ndjson",
      blockBytes: BLOCK_BYTES,
      sampleSize: 5000,
    });
    expect(result.config.schema.fields.color!.indexed).toBeUndefined();
    expect(result.config.schema.fields.batch!.indexed).toBe(true);
    expect(result.warnings.some((w) => /init left "color" unindexed/.test(w))).toBe(true);
  });

  test("--reinfer doesn't re-explain a field the existing config already leaves unindexed", () => {
    const configPath = path.join(tmpDir, "zonemapdb.config.json");
    const first = init({ cwd: tmpDir, configPath, yes: true, inputPath: "items.ndjson", blockBytes: BLOCK_BYTES });
    expect(first.warnings.filter((w) => /init left/.test(w))).toHaveLength(2);
    const again = resolveInitConfig({ cwd: tmpDir, configPath, yes: true, reinfer: true });
    expect(again.warnings.filter((w) => /init left/.test(w))).toEqual([]);
  });
});
