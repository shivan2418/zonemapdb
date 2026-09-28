import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { build } from "../src/build.js";
import { loadConfigFile } from "../src/config.js";
import { contentHash } from "../src/hash.js";
import { init, resolveInitConfig } from "../src/init.js";
import type { ZonemapDbConfig } from "../src/types.js";
import { getFormatVersion } from "../src/version.js";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, "../../..");

const MOVIES = [
  { year: 1999, title: "The Matrix", rating: 8.7 },
  { year: 2000, title: "Gladiator", rating: 8.5 },
  { year: 2000, title: "Snatch", rating: 8.3 },
  { year: 2000, title: "Memento", rating: 8.4 },
  { year: 2003, title: "The Matrix Reloaded", rating: 7.2 },
  { year: 2008, title: "The Dark Knight", rating: 9.0 },
  { year: 2010, title: "Inception", rating: 8.8 },
  { year: 2010, title: "Toy Story 3", rating: 8.3 },
  { year: 2014, title: "Interstellar", rating: 8.6 },
  { year: 2019, title: "Parasite", rating: 8.6 },
];

const config: ZonemapDbConfig = {
  collection: "movies",
  input: { path: "movies.ndjson" },
  schema: {
    sortField: "year",
    fields: {
      year: { kind: "number" },
      title: { kind: "string" },
      rating: { kind: "number" },
    },
  },
};

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), "zonemapdb-seam1-"));
  writeFileSync(path.join(tmpDir, "movies.ndjson"), MOVIES.map((m) => JSON.stringify(m)).join("\n") + "\n");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/** T3/T4 shared fixture: same movies, with title secondary-indexed. */
const indexedConfig: ZonemapDbConfig = {
  ...config,
  schema: {
    sortField: "year",
    fields: {
      year: { kind: "number" },
      title: { kind: "string", indexed: true },
      rating: { kind: "number" },
    },
  },
};

/**
 * Seam #3 harness: write a consumer against the generated client in
 * `clientOutDir` and assert `tsc -p` over it exits 0 — so every
 * `@ts-expect-error` inside `consumerSource` must genuinely error.
 */
function assertConsumerCompiles(clientOutDir: string, consumerSource: string): void {
  writeFileSync(path.join(clientOutDir, "consumer.ts"), consumerSource);
  // Real consumers are ESM projects; declare it here so NodeNext treats these .ts files as modules.
  writeFileSync(path.join(clientOutDir, "package.json"), JSON.stringify({ type: "module" }));

  const tsconfigContent = {
    extends: path.join(repoRoot, "tsconfig.base.json"),
    compilerOptions: {
      paths: { "zonemapdb": [path.join(repoRoot, "packages/zonemapdb/src/index.ts")] },
      noEmit: true,
    },
    include: ["*.ts"],
  };
  writeFileSync(path.join(clientOutDir, "tsconfig.json"), JSON.stringify(tsconfigContent, null, 2));

  const tscBin = path.join(repoRoot, "node_modules", ".bin", "tsc");
  let output = "";
  let status = 0;
  try {
    output = execFileSync(tscBin, ["-p", path.join(clientOutDir, "tsconfig.json")], { encoding: "utf8" });
  } catch (err) {
    const e = err as { status?: number; stdout?: string; message: string };
    status = e.status ?? 1;
    output = e.stdout ?? e.message;
  }
  expect(output + `\n(exit ${status})`).toBe(`\n(exit 0)`);
}

describe("seam #1 — config + NDJSON → build artifacts", () => {
  test("produces a manifest matching the spec's shape for the sort-field-only case", () => {
    const { manifest, outputDir, clientOutDir } = build(config, {
      baseDir: tmpDir,
      generatorVersion: "0.1.0",
      formatVersion: 0,
    });

    expect(manifest.formatVersion).toBe(0);
    expect(manifest.generatorVersion).toBe("0.1.0");
    expect(manifest.dataset.collection).toBe("movies");
    expect(manifest.dataset.recordCount).toBe(MOVIES.length);
    expect(manifest.dataset.sortField).toBe("year");

    // per-block counts sum to recordCount
    const summedCount = manifest.blocks.reduce((sum, s) => sum + s.count, 0);
    expect(summedCount).toBe(manifest.dataset.recordCount);
    expect(manifest.dataset.blockCount).toBe(manifest.blocks.length);

    // splitPoints: N+1 boundaries, monotonic
    const splitPoints = manifest.zonemap.year!.splitPoints as number[];
    expect(splitPoints).toHaveLength(manifest.blocks.length + 1);
    for (let i = 1; i < splitPoints.length; i++) {
      expect(splitPoints[i]!).toBeGreaterThanOrEqual(splitPoints[i - 1]!);
    }

    // only the sort field is indexed
    expect(manifest.schema.fields.year!.indexed).toBe(true);
    expect(manifest.schema.fields.title!.indexed).toBe(false);
    expect(manifest.schema.fields.rating!.indexed).toBe(false);

    expect(existsSync(path.join(outputDir, "manifest.json"))).toBe(true);
    expect(existsSync(clientOutDir)).toBe(true);
  });

  test("gzip: true compresses index chunks and zonemap sidecars, and the manifest paths say so", () => {
    // Separate output dirs: `build` clears its output, so a shared one would wipe the first result.
    const gz = build(
      { ...indexedConfig, gzip: true, blockBytes: 60, output: "out-gz", clientOut: "client-gz" },
      { baseDir: tmpDir, generatorVersion: "0.1.0", formatVersion: 0 },
    );
    const plain = build(
      { ...indexedConfig, blockBytes: 60, output: "out-plain", clientOut: "client-plain" },
      { baseDir: tmpDir, generatorVersion: "0.1.0", formatVersion: 0 },
    );

    const chunks = gz.manifest.indexes.title!.chunks;
    expect(chunks.length).toBeGreaterThan(0);
    for (const chunk of chunks) {
      // the path carries the encoding — that is what lets the client route without a manifest flag
      expect(chunk.file).toMatch(/\.json\.gz$/);
      const onDisk = readFileSync(path.join(gz.outputDir, chunk.file));
      // really gzip, and it round-trips to the chunk the client expects
      const decoded = JSON.parse(gunzipSync(onDisk).toString("utf8")) as { entries: unknown[] };
      expect(Array.isArray(decoded.entries)).toBe(true);
      expect(onDisk.length).toBeLessThan(gunzipSync(onDisk).length);
    }

    // Content hashes stay over the LOGICAL uncompressed bytes, so toggling gzip between rebuilds
    // never perturbs filenames — the same rule blocks already follow (ADR-0002 §8).
    const hashOf = (file: string) => path.basename(file).replace(/\.json(\.gz)?$/, "");
    expect(chunks.map((c) => hashOf(c.file))).toEqual(plain.manifest.indexes.title!.chunks.map((c) => hashOf(c.file)));
  });

  test("gzip: true ships manifest.json.gz and stamps the generated client to fetch it", () => {
    const { manifest, outputDir, clientOutDir } = build(
      { ...indexedConfig, gzip: true, output: "out-mgz", clientOut: "client-mgz" },
      { baseDir: tmpDir, generatorVersion: "0.1.0", formatVersion: 0 },
    );

    // The name changes, not just the encoding — a stale plain manifest.json can never be served as
    // if it were current.
    expect(existsSync(path.join(outputDir, "manifest.json"))).toBe(false);
    const onDisk = readFileSync(path.join(outputDir, "manifest.json.gz"));
    expect(JSON.parse(gunzipSync(onDisk).toString("utf8"))).toEqual(manifest);

    // The manifest is the bootstrap fetch, so the encoding has to be baked into the client.
    const clientTs = readFileSync(path.join(clientOutDir, "client.ts"), "utf8");
    expect(clientTs).toMatch(/manifestCompression:/);

    // ...and not baked when it doesn't apply
    const plain = build(
      { ...indexedConfig, output: "out-mplain", clientOut: "client-mplain" },
      { baseDir: tmpDir, generatorVersion: "0.1.0", formatVersion: 0 },
    );
    expect(existsSync(path.join(plain.outputDir, "manifest.json"))).toBe(true);
    expect(readFileSync(path.join(plain.clientOutDir, "client.ts"), "utf8")).not.toMatch(/manifestCompression/);
  });

  test("a string sort field range-partitions lexicographically and prunes like any other sort field", () => {
    // ADR-0002 §2 makes the number/date preference a *heuristic for the default*, "never a hidden
    // decision" — and locality on the field users actually search is the whole point of the choice.
    const stringSorted: ZonemapDbConfig = {
      ...config,
      blockBytes: 60,
      schema: {
        sortField: "title",
        fields: { year: { kind: "number" }, title: { kind: "string" }, rating: { kind: "number" } },
      },
    };

    const { manifest, outputDir } = build(stringSorted, {
      baseDir: tmpDir,
      generatorVersion: "0.1.0",
      formatVersion: 0,
    });

    expect(manifest.dataset.sortField).toBe("title");
    // sorting a field implicitly makes it queryable, with the free zonemap operator set (ADR-0002 §2)
    // — plus startsWith, which a sorted string field gets for free as a split-point range.
    expect(manifest.schema.fields.title!.indexed).toBe(true);
    expect(manifest.schema.fields.title!.operators).toEqual([
      "equals",
      "in",
      "gt",
      "gte",
      "lt",
      "lte",
      "startsWith",
      "endsWith",
      "contains",
      "not",
    ]);
    // endsWith/contains ride; everything the split-points answer prunes (ADR-0013).
    expect(manifest.schema.fields.title!.pruning).toEqual(["equals", "in", "gt", "gte", "lt", "lte", "startsWith"]);
    // ...and it prunes via split-points, not an inverted index
    expect(manifest.indexes.title).toBeUndefined();

    const splitPoints = manifest.zonemap.title!.splitPoints as string[];
    expect(splitPoints).toHaveLength(manifest.blocks.length + 1);
    expect(manifest.blocks.length).toBeGreaterThan(1);
    for (let i = 1; i < splitPoints.length; i++) {
      expect(splitPoints[i]! >= splitPoints[i - 1]!).toBe(true);
    }

    // Records are globally ordered by title across blocks, and block ranges don't overlap —
    // the invariant that makes zonemap pruning exact.
    const titlesInBlockOrder = manifest.blocks.flatMap((block) =>
      readFileSync(path.join(outputDir, "blocks", `${block.hash}.ndjson`), "utf8")
        .split("\n")
        .filter((l) => l.length > 0)
        .map((l) => (JSON.parse(l) as { title: string }).title),
    );
    expect(titlesInBlockOrder).toEqual([...MOVIES.map((m) => m.title)].sort());
  });

  test("manifest.json is written minified — every client downloads it, so indentation is pure wire cost", () => {
    const { manifest, outputDir } = build(config, { baseDir: tmpDir, generatorVersion: "0.1.0", formatVersion: 0 });

    const onDisk = readFileSync(path.join(outputDir, "manifest.json"), "utf8");
    // The budget in `spillOversizedZonemaps` is measured on gzip(minified), so shipping a
    // pretty-printed file would mean the check governs bytes nobody ever downloads.
    expect(onDisk).toBe(JSON.stringify(manifest));
    expect(onDisk).not.toContain("\n");
    // Still parses back to exactly the returned manifest — minifying changes bytes, never content.
    expect(JSON.parse(onDisk)).toEqual(manifest);
  });

  test("block files are content-hash-named and their bytes/count match the manifest", () => {
    const { manifest, outputDir } = build(config, { baseDir: tmpDir, generatorVersion: "0.1.0", formatVersion: 0 });

    for (const block of manifest.blocks) {
      const filePath = path.join(outputDir, "blocks", `${block.hash}.ndjson`);
      expect(existsSync(filePath)).toBe(true);
      const content = readFileSync(filePath, "utf8");
      expect(contentHash(content)).toBe(block.hash);
      expect(Buffer.byteLength(content, "utf8")).toBe(block.bytes);
      const lineCount = content.split("\n").filter((l) => l.length > 0).length;
      expect(lineCount).toBe(block.count);
    }
  });

  test("cutting into small blocks keeps equal sort-field years contiguous within one block", () => {
    // A tiny byte target forces many cuts; the three year:2000 records must still land together.
    const tinyResult = build(
      { ...config, blockBytes: 40 },
      { baseDir: tmpDir, generatorVersion: "0.1.0", formatVersion: 0 },
    );
    expect(tinyResult.manifest.blocks.length).toBeGreaterThan(1);

    const tinyBlocksDir = path.join(tinyResult.outputDir, "blocks");
    const blocksWith2000 = tinyResult.manifest.blocks.filter((s) => {
      const content = readFileSync(path.join(tinyBlocksDir, `${s.hash}.ndjson`), "utf8");
      return content.includes('"year":2000');
    });
    expect(blocksWith2000).toHaveLength(1);
  });

  test("generates schema.ts and client.ts with the generated-header stamp", () => {
    const { clientOutDir } = build(config, { baseDir: tmpDir, generatorVersion: "0.1.0", formatVersion: 0 });
    const schemaTs = readFileSync(path.join(clientOutDir, "schema.ts"), "utf8");
    const clientTs = readFileSync(path.join(clientOutDir, "client.ts"), "utf8");
    expect(schemaTs).toContain("generated by zonemapdb@0.1.0 — do not edit");
    expect(clientTs).toContain("generated by zonemapdb@0.1.0 — do not edit");
    expect(schemaTs).toContain("export interface Movies");
    expect(clientTs).toContain("export function connect(");
  });

  test("identical input produces identical block hashes and manifest (determinism)", () => {
    const first = build(config, { baseDir: tmpDir, generatorVersion: "0.1.0", formatVersion: 0 });
    const secondDir = mkdtempSync(path.join(tmpdir(), "zonemapdb-seam1-again-"));
    writeFileSync(path.join(secondDir, "movies.ndjson"), MOVIES.map((m) => JSON.stringify(m)).join("\n") + "\n");
    const second = build(config, { baseDir: secondDir, generatorVersion: "0.1.0", formatVersion: 0 });

    expect(second.manifest.blocks.map((s) => s.hash)).toEqual(first.manifest.blocks.map((s) => s.hash));
    expect(second.manifest.zonemap).toEqual(first.manifest.zonemap);
    rmSync(secondDir, { recursive: true, force: true });
  });
});

describe("seam #1 — secondary inverted index & zonemap (T3)", () => {
  const indexedConfig: ZonemapDbConfig = {
    ...config,
    blockBytes: 60, // tiny — forces multiple blocks so the index has real cross-block postings to prove
    schema: {
      sortField: "year",
      fields: {
        year: { kind: "number" },
        title: { kind: "string", indexed: true },
        rating: { kind: "number", indexed: true },
      },
    },
  };

  test("writes a chunk directory in manifest.json + content-hash-named chunk files on disk covering the full value range", () => {
    const { manifest, outputDir } = build(indexedConfig, { baseDir: tmpDir, generatorVersion: "0.1.0", formatVersion: 0 });

    expect(manifest.schema.fields.title!.indexed).toBe(true);
    expect(manifest.schema.fields.title!.operators).toEqual(["equals", "in", "startsWith", "endsWith", "contains", "not"]);
    expect(manifest.schema.fields.title!.pruning).toEqual(["equals", "in", "startsWith"]);
    expect(manifest.indexes.title!.chunks.length).toBeGreaterThan(0);

    for (const chunk of manifest.indexes.title!.chunks) {
      const filePath = path.join(outputDir, chunk.file);
      expect(existsSync(filePath)).toBe(true);
      const content = readFileSync(filePath, "utf8");
      expect(contentHash(content)).toBe(path.basename(chunk.file, ".json"));
      expect((chunk.from as string) <= (chunk.to as string)).toBe(true);
    }

    // Chunks partition the distinct-value range in order, with no overlap between consecutive chunks.
    const chunks = manifest.indexes.title!.chunks;
    for (let i = 1; i < chunks.length; i++) {
      expect((chunks[i]!.from as string) > (chunks[i - 1]!.to as string)).toBe(true);
    }

    const expectedTitles = [...new Set(MOVIES.map((m) => m.title))].sort();
    expect(expectedTitles[0]! >= (chunks[0]!.from as string)).toBe(true);
    expect(expectedTitles[expectedTitles.length - 1]! <= (chunks[chunks.length - 1]!.to as string)).toBe(true);
  });

  test("secondary number field gets equals/in plus the range operators, and its own chunk directory", () => {
    const { manifest } = build(indexedConfig, { baseDir: tmpDir, generatorVersion: "0.1.0", formatVersion: 0 });
    expect(manifest.schema.fields.rating!.operators).toEqual(["equals", "in", "gt", "gte", "lt", "lte", "not"]);
    expect(manifest.indexes.rating!.chunks.length).toBeGreaterThan(0);
    // The ranges are answered off the untruncated pairs below, not off these chunks.
    expect(manifest.zonemap.rating).toHaveProperty("pairs");
  });

  test("secondary zonemap pairs are present and ordinal-aligned with blocks[], string pairs marked truncated", () => {
    const { manifest } = build(indexedConfig, { baseDir: tmpDir, generatorVersion: "0.1.0", formatVersion: 0 });

    expect(manifest.zonemap.title).toBeDefined();
    const titleZonemap = manifest.zonemap.title as { pairs: [unknown, unknown][]; truncated?: boolean };
    expect(titleZonemap.truncated).toBe(true);
    expect(titleZonemap.pairs).toHaveLength(manifest.blocks.length);

    expect(manifest.zonemap.rating).toBeDefined();
    const ratingZonemap = manifest.zonemap.rating as { pairs: [unknown, unknown][]; truncated?: boolean };
    expect(ratingZonemap.truncated).toBeUndefined();
    expect(ratingZonemap.pairs).toHaveLength(manifest.blocks.length);

    // the sort field's own zonemap is untouched (still split-points, not pairs)
    expect(manifest.zonemap.year).toHaveProperty("splitPoints");
  });

  test("a non-opted-in field stays unindexed and absent from manifest.indexes", () => {
    const { manifest } = build(config, { baseDir: tmpDir, generatorVersion: "0.1.0", formatVersion: 0 });
    expect(manifest.schema.fields.title!.indexed).toBe(false);
    expect(manifest.indexes).toEqual({});
  });
});

describe("seam #1 — endsWith (reversed index) & contains (trigram index) opt-ins (T6)", () => {
  const t6Config: ZonemapDbConfig = {
    ...config,
    blockBytes: 60, // tiny — forces multiple blocks, same rationale as T3's fixture
    schema: {
      sortField: "year",
      fields: {
        year: { kind: "number" },
        title: { kind: "string", indexed: true, endsWith: true, contains: true },
        rating: { kind: "number" },
      },
    },
  };

  test("operators/manifest.indexes gain reversed+trigram structures only for the opted-in field", () => {
    const { manifest } = build(t6Config, { baseDir: tmpDir, generatorVersion: "0.1.0", formatVersion: 0 });

    expect(manifest.schema.fields.title!.operators).toEqual(["equals", "in", "startsWith", "endsWith", "contains", "not"]);
    expect(manifest.indexes.title!.reversed).toBeDefined();
    expect(manifest.indexes.title!.trigram).toBeDefined();
    // rating never opted into endsWith/contains — no reversed/trigram structures for it, even though it's indexed.
    expect(manifest.indexes.rating).toBeUndefined();
  });

  test("reversed + trigram chunk files are written to disk, content-hash-named, matching the manifest directory", () => {
    const { manifest, outputDir } = build(t6Config, { baseDir: tmpDir, generatorVersion: "0.1.0", formatVersion: 0 });

    const reversedChunks = manifest.indexes.title!.reversed!.chunks;
    expect(reversedChunks.length).toBeGreaterThan(0);
    for (const chunk of reversedChunks) {
      expect(chunk.file).toMatch(/^index\/title\/reversed\//);
      const filePath = path.join(outputDir, chunk.file);
      expect(existsSync(filePath)).toBe(true);
      expect(contentHash(readFileSync(filePath, "utf8"))).toBe(path.basename(chunk.file, ".json"));
    }

    const trigramChunks = manifest.indexes.title!.trigram!.chunks;
    expect(trigramChunks.length).toBeGreaterThan(0);
    for (const chunk of trigramChunks) {
      expect(chunk.file).toMatch(/^index\/title\/trigram\//);
      const filePath = path.join(outputDir, chunk.file);
      expect(existsSync(filePath)).toBe(true);
      expect(contentHash(readFileSync(filePath, "utf8"))).toBe(path.basename(chunk.file, ".json"));
    }
  });

  test("endsWith(suffix) over the built reversed index resolves correctly against real titles", () => {
    // Cross-checks the build output against ADR-0003's stated equivalence: endsWith(s) = startsWith(reverse(s))
    // on the reversed index — sanity-checked here structurally; seam #2 proves it end-to-end through the runtime.
    const { manifest } = build(t6Config, { baseDir: tmpDir, generatorVersion: "0.1.0", formatVersion: 0 });
    const reversedValues = manifest.indexes.title!.reversed!.chunks.map((c) => c.from as string);
    expect(reversedValues.length).toBeGreaterThan(0);
  });

  test("a contains opt-in whose trigram index exceeds its column emits a loud 'bigger than the data' warning", () => {
    // A handful of short movie titles: trigram-postings overhead trivially dwarfs the raw column bytes.
    const { warnings } = build(t6Config, { baseDir: tmpDir, generatorVersion: "0.1.0", formatVersion: 0 });
    expect(warnings.some((w) => /contains\(title\)/.test(w) && /bigger than the data/i.test(w))).toBe(true);
  });

  test("an unselective contains/endsWith index warns, while a selective one on the same build stays quiet", () => {
    // 400 records over a tiny byte target => many blocks, so mean-postings-per-entry is meaningful.
    // `code` is drawn from a 4-symbol alphabet, so its ~64 distinct trigrams each recur far more
    // often than there are blocks and scatter across nearly all of them — the `id`/`uri` shape,
    // where an index buys no pruning. (The alphabet has to be small for the same reason it is on
    // real data: 116k UUIDs over 16 hex digits give ~800 occurrences per trigram.)
    // `region` values run in contiguous runs of the sort field, so each clusters into a few blocks.
    const REGIONS = ["north", "south", "east", "west", "central", "coastal", "inland", "border"];
    const rows = Array.from({ length: 400 }, (_, i) => {
      let x = Math.imul(i + 1, 2654435761) >>> 0;
      x ^= x >>> 15;
      x = Math.imul(x, 2246822519) >>> 0;
      let code = "";
      for (let k = 0; k < 12; k++) code += "abcd"[(x >>> (k * 2)) & 0b11];
      return { rank: i, code, region: REGIONS[Math.floor(i / 50)]! };
    });
    writeFileSync(path.join(tmpDir, "rows.ndjson"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");

    const { manifest, warnings } = build(
      {
        collection: "rows",
        input: { path: "rows.ndjson" },
        blockBytes: 400,
        schema: {
          sortField: "rank",
          fields: {
            rank: { kind: "number" },
            code: { kind: "string", indexed: true, contains: true },
            region: { kind: "string", indexed: true, contains: true },
          },
        },
      },
      { baseDir: tmpDir, generatorVersion: "0.1.0", formatVersion: 0 },
    );

    expect(manifest.blocks.length).toBeGreaterThan(8);
    const joined = warnings.join("\n");
    expect(joined).toMatch(/contains\(code\)/);
    expect(joined).toMatch(/prun/i);
    // the selective field on the very same build must not be flagged
    expect(joined).not.toMatch(/contains\(region\)/);
  });

  test("a field with only endsWith opted in has no trigram structure, and vice versa", () => {
    const endsWithOnly: ZonemapDbConfig = {
      ...t6Config,
      schema: {
        ...t6Config.schema,
        fields: { ...t6Config.schema.fields, title: { kind: "string", indexed: true, endsWith: true } },
      },
    };
    const { manifest, warnings } = build(endsWithOnly, { baseDir: tmpDir, generatorVersion: "0.1.0", formatVersion: 0 });
    expect(manifest.schema.fields.title!.operators).toEqual(["equals", "in", "startsWith", "endsWith", "contains", "not"]);
    expect(manifest.schema.fields.title!.pruning).toEqual(["equals", "in", "startsWith", "endsWith"]);
    expect(manifest.indexes.title!.reversed).toBeDefined();
    expect(manifest.indexes.title!.trigram).toBeUndefined();
    expect(warnings).toEqual([]);
  });
});

describe("seam #1 — unindexed fields and useless indexes (ADR-0013)", () => {
  const flags = Array.from({ length: 200 }, (_, i) => ({ id: i, even: i % 2 === 0, bucket: `b${Math.floor(i / 10)}`, parity: [i % 2 === 0 ? "even" : "odd"] }));
  const flagConfig: ZonemapDbConfig = {
    collection: "flags",
    input: { path: "flags.ndjson" },
    blockBytes: 300, // many small blocks
    schema: {
      sortField: "id",
      fields: {
        id: { kind: "number" },
        even: { kind: "boolean", indexed: true }, // both values in every block: prunes nothing
        bucket: { kind: "string", indexed: true }, // each value in one or two blocks: prunes well
        parity: { kind: "string", indexed: true, multi: true }, // in every block, but a list can't be unindexed
      },
    },
  };

  test("warns about an index whose average value sits in most blocks, and not about one that prunes", () => {
    writeFileSync(path.join(tmpDir, "flags.ndjson"), flags.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const { manifest, warnings } = build(flagConfig, { baseDir: tmpDir, generatorVersion: "0.1.0", formatVersion: 0 });
    expect(manifest.blocks.length).toBeGreaterThanOrEqual(8);
    expect(warnings.filter((w) => /index\(even\): this index barely prunes/.test(w))).toHaveLength(1);
    expect(warnings.some((w) => /index\(bucket\)/.test(w))).toBe(false);
    expect(warnings.some((w) => /index\(parity\)/.test(w))).toBe(false);
    expect(warnings.find((w) => /index\(even\)/.test(w))).toMatch(/stays filterable as a rider/);
  });

  test("following the barely-prunes advice builds: a value union stays, and the advice names text opt-ins that go with the index", () => {
    const tones = flags.map((r) => ({ ...r, tone: r.even ? "light" : "dark" }));
    writeFileSync(path.join(tmpDir, "flags.ndjson"), tones.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const withTone = (tone: ZonemapDbConfig["schema"]["fields"][string]): ZonemapDbConfig => ({
      ...flagConfig,
      schema: { ...flagConfig.schema, fields: { ...flagConfig.schema.fields, tone } },
    });

    const valued = build(withTone({ kind: "string", indexed: true, values: ["dark", "light"] }), { baseDir: tmpDir, generatorVersion: "0.1.0", formatVersion: 0 });
    expect(valued.warnings.find((w) => /index\(tone\)/.test(w))).toMatch(/Consider removing "indexed": true: /);
    const unindexed = build(withTone({ kind: "string", values: ["dark", "light"] }), { baseDir: tmpDir, generatorVersion: "0.1.0", formatVersion: 0 });
    expect(readFileSync(path.join(unindexed.clientOutDir, "schema.ts"), "utf8")).toMatch(/tone: \{ kind: "string", operators: \[[^\]]*\], pruning: \[\], values: \["dark", "light"\]/);

    const searchable = build(withTone({ kind: "string", indexed: true, contains: true }), { baseDir: tmpDir, generatorVersion: "0.1.0", formatVersion: 0 });
    expect(searchable.warnings.find((w) => /index\(tone\)/.test(w))).toMatch(/Consider removing "indexed": true \(and its "contains", which needs the index\)/);
  });

  test("an unindexed field is in the generated schema, queryable, with nothing that prunes", () => {
    writeFileSync(path.join(tmpDir, "flags.ndjson"), flags.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const unindexed: ZonemapDbConfig = {
      ...flagConfig,
      schema: { ...flagConfig.schema, fields: { ...flagConfig.schema.fields, even: { kind: "boolean" } } },
    };
    const { clientOutDir, warnings } = build(unindexed, { baseDir: tmpDir, generatorVersion: "0.1.0", formatVersion: 0 });
    const schemaTs = readFileSync(path.join(clientOutDir, "schema.ts"), "utf8");
    expect(schemaTs).toContain('even: { kind: "boolean", operators: ["equals", "not"], pruning: [] }');
    expect(warnings.some((w) => /index\(even\)/.test(w))).toBe(false);

    // An empty `pruning` list means nothing on the field prunes: a filter on it rides, never stands alone.
    assertConsumerCompiles(
      clientOutDir,
      `
import { connect } from "./client.js";
const db = connect();

async function check() {
  await db.flags.findMany({ where: { id: { lt: 50 }, even: { equals: true } } });
  // @ts-expect-error — a rider alone
  await db.flags.findMany({ where: { even: { equals: true } } });
  // A rider alone is fine as an explicit block-order scan, which needs a limit.
  await db.flags.findMany({ where: { even: { equals: true } }, scan: "block-order", limit: 20 });
  // @ts-expect-error — a scan without a limit can't stop early
  await db.flags.findMany({ where: { even: { equals: true } }, scan: "block-order" });

  // A filter set to undefined is no filter, in findMany and count alike.
  const chosen = Math.random() > 0.5 ? true : undefined;
  await db.flags.findMany({ where: { id: { lt: 50 }, even: chosen === undefined ? undefined : { equals: chosen } } });
  await db.flags.findMany({ where: { id: { lt: 50 }, even: undefined } });
  await db.flags.count({ even: chosen === undefined ? undefined : { equals: chosen } });
  // A where of only undefined filters is the empty where, which is allowed.
  await db.flags.findMany({ where: { even: undefined }, limit: 20 });
  // @ts-expect-error — undefined doesn't make a rider prune
  await db.flags.findMany({ where: { id: undefined, even: { equals: true } } });
  // @ts-expect-error — an unknown field is still rejected when undefined
  await db.flags.findMany({ where: { id: { lt: 50 }, nope: undefined } });
  // @ts-expect-error — so is a bad operator next to undefined
  await db.flags.findMany({ where: { id: { lt: 50 }, even: Math.random() > 0.5 ? undefined : { gt: true } } });
}
void check;
`,
    );
  });
});

describe("seam #1 — json fields in the generated schema (0.3.0 regression)", () => {
  test("an absent json field type-checks: missing-value operators only, never orderable", () => {
    const records = Array.from({ length: 20 }, (_, i) => ({
      id: i,
      name: `n${i}`,
      ...(i % 2 === 0 ? { images: { small: `s${i}.png` } } : {}),
    }));
    writeFileSync(path.join(tmpDir, "things.ndjson"), records.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const jsonConfig: ZonemapDbConfig = {
      collection: "things",
      input: { path: "things.ndjson" },
      schema: {
        sortField: "id",
        fields: { id: { kind: "number" }, name: { kind: "string" }, images: { kind: "json", absent: true } },
      },
    };
    const { clientOutDir } = build(jsonConfig, { baseDir: tmpDir, generatorVersion: "0.1.0", formatVersion: 0 });
    const schemaTs = readFileSync(path.join(clientOutDir, "schema.ts"), "utf8");
    expect(schemaTs).toContain('images: { kind: "json", operators: ["isAbsent", "exists"], pruning: [], absent: true }');

    assertConsumerCompiles(
      clientOutDir,
      `
import type { OrderByOf, WhereOf } from "zonemapdb";
import { connect } from "./client.js";
import type { Schema } from "./schema.js";
const db = connect();

const where: WhereOf<Schema["things"]> = { images: { exists: true } };
const order: OrderByOf<Schema["things"]> = { name: "asc" };
void where;
void order;

async function check() {
  await db.things.findMany({ where: { id: { lt: 10 }, images: { isAbsent: true } } });
  // @ts-expect-error — a json field has no value operators
  await db.things.findMany({ where: { id: { lt: 10 }, images: { equals: {} } } });
  // @ts-expect-error — an object has no order
  await db.things.findMany({ where: { id: { lt: 10 } }, orderBy: { images: "asc" } });
  // @ts-expect-error — a rider alone
  await db.things.findMany({ where: { images: { exists: true } } });
}
void check;
`,
    );
  });
});

describe("seam #1 — input formats & record selectors (T9)", () => {
  let baseline: ReturnType<typeof build>;

  beforeEach(() => {
    baseline = build(config, { baseDir: tmpDir, generatorVersion: "0.1.0", formatVersion: 0 });
  });

  test("JSON array-element selector produces artifacts identical to the NDJSON baseline", () => {
    writeFileSync(path.join(tmpDir, "movies.json"), JSON.stringify(MOVIES));
    const result = build(
      { ...config, input: { path: "movies.json", format: "json" } },
      { baseDir: tmpDir, generatorVersion: "0.1.0", formatVersion: 0 },
    );
    expect(result.manifest.blocks.map((s) => s.hash)).toEqual(baseline.manifest.blocks.map((s) => s.hash));
    expect(result.manifest.dataset.recordCount).toBe(baseline.manifest.dataset.recordCount);
    expect(result.manifest.zonemap).toEqual(baseline.manifest.zonemap);
  });

  test("JSON map-value selector (keys discarded) produces artifacts identical to the NDJSON baseline", () => {
    const asMap: Record<string, (typeof MOVIES)[number]> = {};
    MOVIES.forEach((m, i) => {
      asMap[`m${i}`] = m;
    });
    writeFileSync(path.join(tmpDir, "movies.json"), JSON.stringify(asMap));
    const result = build(
      { ...config, input: { path: "movies.json", format: "json" } },
      { baseDir: tmpDir, generatorVersion: "0.1.0", formatVersion: 0 },
    );
    expect(result.manifest.blocks.map((s) => s.hash)).toEqual(baseline.manifest.blocks.map((s) => s.hash));
    expect(result.manifest.dataset.recordCount).toBe(baseline.manifest.dataset.recordCount);
  });

  test("nested JSON `records` path selector lands on one node per record, no array-flattening", () => {
    writeFileSync(
      path.join(tmpDir, "movies-nested.json"),
      JSON.stringify({ meta: { generatedAt: "2026-01-01" }, data: { records: MOVIES } }),
    );
    const result = build(
      { ...config, input: { path: "movies-nested.json", format: "json", records: "data.records" } },
      { baseDir: tmpDir, generatorVersion: "0.1.0", formatVersion: 0 },
    );
    expect(result.manifest.dataset.recordCount).toBe(MOVIES.length);
    expect(result.manifest.blocks.map((s) => s.hash)).toEqual(baseline.manifest.blocks.map((s) => s.hash));
  });

  test("CSV row selector produces artifacts identical to the NDJSON baseline", () => {
    const csv = ["year,title,rating", ...MOVIES.map((m) => `${m.year},${m.title},${m.rating}`)].join("\n") + "\n";
    writeFileSync(path.join(tmpDir, "movies.csv"), csv);
    const result = build(
      { ...config, input: { path: "movies.csv", format: "csv" } },
      { baseDir: tmpDir, generatorVersion: "0.1.0", formatVersion: 0 },
    );
    expect(result.manifest.blocks.map((s) => s.hash)).toEqual(baseline.manifest.blocks.map((s) => s.hash));
    expect(result.manifest.dataset.recordCount).toBe(baseline.manifest.dataset.recordCount);
  });

  test("TSV row selector produces artifacts identical to the NDJSON baseline", () => {
    const tsv = ["year\ttitle\trating", ...MOVIES.map((m) => `${m.year}\t${m.title}\t${m.rating}`)].join("\n") + "\n";
    writeFileSync(path.join(tmpDir, "movies.tsv"), tsv);
    const result = build(
      { ...config, input: { path: "movies.tsv", format: "tsv" } },
      { baseDir: tmpDir, generatorVersion: "0.1.0", formatVersion: 0 },
    );
    expect(result.manifest.blocks.map((s) => s.hash)).toEqual(baseline.manifest.blocks.map((s) => s.hash));
    expect(result.manifest.dataset.recordCount).toBe(baseline.manifest.dataset.recordCount);
  });

  test("a glob of same-format NDJSON files merges then blocks as one dataset", () => {
    writeFileSync(path.join(tmpDir, "movies-a.ndjson"), MOVIES.slice(0, 5).map((m) => JSON.stringify(m)).join("\n") + "\n");
    writeFileSync(path.join(tmpDir, "movies-b.ndjson"), MOVIES.slice(5).map((m) => JSON.stringify(m)).join("\n") + "\n");
    const result = build(
      { ...config, input: { path: "movies-*.ndjson" } },
      { baseDir: tmpDir, generatorVersion: "0.1.0", formatVersion: 0 },
    );
    expect(result.manifest.dataset.recordCount).toBe(MOVIES.length);
    expect(result.manifest.blocks.map((s) => s.hash)).toEqual(baseline.manifest.blocks.map((s) => s.hash));
  });
});

describe("seam #3 (type-level, over seam #1's own output) — generated types reject bad queries", () => {
  test("tsc exits 0 over a consumer that exercises valid queries and @ts-expect-error cases", () => {
    const { clientOutDir } = build(config, { baseDir: tmpDir, generatorVersion: "0.1.0", formatVersion: 0 });

    const consumerSource = `
import { connect } from "./client.js";

const db = connect();

async function valid() {
  await db.movies.findMany({ where: { year: { gte: 2000, lt: 2010 } }, orderBy: { year: "desc" }, limit: 5, offset: 1 });
  await db.movies.findMany({ where: { year: { in: [1999, 2003] } } });
  await db.movies.findMany();
  db.movies.getSchema();

  // title and rating are unindexed, so every filter on them is a rider (ADR-0013): valid alongside a
  // pruning constraint, with every operator their type allows.
  await db.movies.findMany({ where: { year: { gte: 2000 }, title: { contains: "at", not: "Snatch" }, rating: { gte: 8 } } });
  await db.movies.findMany({ where: { year: { gte: 2000 } }, orderBy: { rating: "desc" } });
}

async function invalid() {
  // a rider alone — title is unindexed, so this would read every block.
  // @ts-expect-error
  await db.movies.findMany({ where: { title: { equals: "Gladiator" } } });

  // two riders are still no pruning constraint.
  // @ts-expect-error
  await db.movies.findMany({ where: { title: { equals: "Gladiator" }, rating: { gt: 8 } } });

  // wrong value type: year is a number.
  // @ts-expect-error
  await db.movies.findMany({ where: { year: { gt: "2000" } } });

  // an unindexed string field still withholds ranges (ADR-0003 §7).
  // @ts-expect-error
  await db.movies.findMany({ where: { year: { gte: 2000 }, title: { gte: "M" } } });
}

void valid;
void invalid;
`;
    assertConsumerCompiles(clientOutDir, consumerSource);
  });

  test("a string sort field's range operators are usable in the typed where, and secondary strings still reject them", () => {
    // The manifest has always offered gt/gte/lt/lte on a string sort field; the where type must too,
    // or the operators the build advertises are unreachable from a typed client.
    writeFileSync(
      path.join(tmpDir, "movies.ndjson"),
      MOVIES.map((m) => JSON.stringify({ ...m, certification: "PG" })).join("\n") + "\n",
    );
    const { clientOutDir } = build(
      {
        ...config,
        schema: {
          sortField: "title",
          fields: {
            year: { kind: "number" },
            title: { kind: "string" },
            rating: { kind: "number" },
            certification: { kind: "string", indexed: true },
          },
        },
      },
      { baseDir: tmpDir, generatorVersion: "0.1.0", formatVersion: 0 },
    );

    const consumerSource = `
import { connect } from "./client.js";

const db = connect();

async function valid() {
  await db.movies.findMany({ where: { title: { gte: "G", lt: "M" } } });
  await db.movies.findMany({ where: { title: { gt: "", lte: "Z" } } });
  await db.movies.findMany({ where: { title: { startsWith: "Gla" } } });
}

async function invalid() {
  // a string sort field compares strings, not numbers.
  // @ts-expect-error
  await db.movies.findMany({ where: { title: { gte: 5 } } });

  // secondary string fields withhold ranges on purpose (ADR-0003 §7).
  // @ts-expect-error
  await db.movies.findMany({ where: { certification: { gte: "P" } } });
}

void valid;
void invalid;
`;
    assertConsumerCompiles(clientOutDir, consumerSource);
  });

  test("T3: tsc exits 0 for a consumer exercising secondary-field equals/in/startsWith and rejecting disabled operators", () => {
    const { clientOutDir } = build(indexedConfig, { baseDir: tmpDir, generatorVersion: "0.1.0", formatVersion: 0 });

    const consumerSource = `
import { connect } from "./client.js";

const db = connect();

async function valid() {
  await db.movies.findMany({ where: { title: { equals: "Gladiator" } } });
  await db.movies.findMany({ where: { title: { in: ["Gladiator", "Snatch"] } } });
  await db.movies.findMany({ where: { title: { startsWith: "Gla" } } });
  await db.movies.findMany({ where: { year: { gte: 2000 }, title: { equals: "Gladiator" } } });
}

async function invalid() {
  // wrong value type: title is a string.
  // @ts-expect-error
  await db.movies.findMany({ where: { title: { equals: 5 } } });

  // rating is unindexed in this config: a rider, so not allowed alone.
  // @ts-expect-error
  await db.movies.findMany({ where: { rating: { equals: 8.5 } } });

  // contains was never opted in for title, so it's a rider there too — not allowed alone...
  // @ts-expect-error
  await db.movies.findMany({ where: { title: { contains: "lad" } } });
}

async function riders() {
  // ...but fine next to a constraint that prunes.
  await db.movies.findMany({ where: { title: { startsWith: "G", contains: "lad" } } });
  await db.movies.findMany({ where: { title: { equals: "Gladiator" }, rating: { gte: 8.5 } } });
}
void riders;

void valid;
void invalid;
`;
    assertConsumerCompiles(clientOutDir, consumerSource);
  });

  test("range operators are offered on a secondary NUMBER field and withheld from a secondary STRING field", () => {
    // indexedConfig indexes `title` (string) and `rating` (number); `year` is the sort field.
    const rangeConfig: ZonemapDbConfig = {
      ...indexedConfig,
      schema: {
        ...indexedConfig.schema,
        fields: { ...indexedConfig.schema.fields, rating: { kind: "number", indexed: true } },
      },
    };
    const { clientOutDir } = build(rangeConfig, { baseDir: tmpDir, generatorVersion: "0.1.0", formatVersion: 0 });

    const consumerSource = `
import { connect } from "./client.js";

const db = connect();

async function valid() {
  // rating is a secondary number field — ranges are pruned by its [min,max] zonemap pairs.
  await db.movies.findMany({ where: { rating: { gte: 8.5 } } });
  await db.movies.findMany({ where: { rating: { gt: 8.0, lte: 9.0 } } });
  // composes with a range on the sort field.
  await db.movies.findMany({ where: { year: { gte: 2000 }, rating: { lt: 8.5 } } });
}

async function invalid() {
  // title is a secondary STRING field: lexicographic ranges are a footgun, so they stay off.
  // @ts-expect-error
  await db.movies.findMany({ where: { title: { gte: "M" } } });

  // @ts-expect-error
  await db.movies.findMany({ where: { title: { lt: "M" } } });

  // still type-checked against the field's kind.
  // @ts-expect-error
  await db.movies.findMany({ where: { rating: { gte: "8.5" } } });
}

void valid;
void invalid;
`;
    assertConsumerCompiles(clientOutDir, consumerSource);
  });

  test("T4: tsc exits 0 for a consumer exercising count() and rejecting exact: true (ADR-0008 §4)", () => {
    const { clientOutDir } = build(indexedConfig, { baseDir: tmpDir, generatorVersion: "0.1.0", formatVersion: 0 });

    const consumerSource = `
import { connect } from "./client.js";

const db = connect();

async function valid() {
  const all = await db.movies.count();
  const constrained = await db.movies.count({ year: { gte: 2000 } });
  const secondary = await db.movies.count({ title: { equals: "Gladiator" } });
  // count downloads nothing, so a rider-only where is fine: it just widens the bound (ADR-0013).
  const riderOnly = await db.movies.count({ rating: { equals: 9.0 } });
  void riderOnly;
  const explicitFalse = await db.movies.count({ year: { gte: 2000 } }, { exact: false });

  // The return shape: { count: number; exact: boolean }.
  const n: number = all.count;
  const e: boolean = all.exact;
  void n; void e; void constrained; void secondary; void explicitFalse;
}

async function invalid() {
  // the exact mode is deferred to v2 — 1.0 locks opts.exact to false (ADR-0008 §4).
  // @ts-expect-error
  await db.movies.count({ year: { gte: 2000 } }, { exact: true });

  // \`{ exact: true }\` is not a where either — the option lives in the second argument.
  // @ts-expect-error
  await db.movies.count({ exact: true });

  // not a field of this collection at all.
  // @ts-expect-error
  await db.movies.count({ director: { equals: "Nolan" } });
}

void valid;
void invalid;
`;
    assertConsumerCompiles(clientOutDir, consumerSource);
  });

  test("value unions: tsc exits 0 for a consumer using the exported union and rejecting non-members", () => {
    const enumConfig: ZonemapDbConfig = {
      ...indexedConfig,
      schema: {
        sortField: "year",
        fields: {
          year: { kind: "number" },
          // An enum-like field: a closed set, so equals/in narrow to it.
          rating: { kind: "number", indexed: true },
          certification: { kind: "string", indexed: true, values: ["G", "PG", "R"] },
          // Same but multi-valued, so the narrowing has to reach `some` too. `contains` is opted in
          // to prove fragment operators stay wide even on a valued field.
          genres: { kind: "string", indexed: true, multi: true, values: ["Drama", "SciFi"] },
          director: { kind: "string", indexed: true, contains: true, values: ["Nolan", "Villeneuve"] },
        },
      },
    };
    writeFileSync(
      path.join(tmpDir, "movies.ndjson"),
      MOVIES.map((m, i) => JSON.stringify({ ...m, certification: "PG", genres: ["Drama"], director: i ? "Nolan" : "Villeneuve" })).join("\n") + "\n",
    );
    const { clientOutDir, manifest } = build(enumConfig, { baseDir: tmpDir, generatorVersion: "0.1.0", formatVersion: 0 });

    // the values reach the manifest, so a rebuild replays them without re-inferring
    expect(manifest.schema.fields.certification?.values).toEqual(["G", "PG", "R"]);
    expect(manifest.schema.fields.rating?.values).toBeUndefined();

    const consumerSource = `
import { connect } from "./client.js";
import type { MoviesCertification, MoviesGenres } from "./schema.js";

const db = connect();

async function valid() {
  // The exported unions are importable app-side — the DX this exists for.
  const cert: MoviesCertification = "PG";
  const genre: MoviesGenres = "Drama";

  await db.movies.findMany({ where: { certification: { equals: "R" } } });
  await db.movies.findMany({ where: { certification: { in: ["G", "PG"] } } });
  await db.movies.findMany({ where: { certification: { equals: cert } } });
  await db.movies.findMany({ where: { genres: { some: genre } } });
  await db.movies.findMany({ where: { genres: { some: { equals: "SciFi" } } } });

  // Fragment operators must stay wide: a substring of an enum member isn't a member.
  await db.movies.findMany({ where: { director: { contains: "olan" } } });
  await db.movies.findMany({ where: { certification: { startsWith: "P" } } });

  // A field with no baked values keeps accepting any number/string.
  await db.movies.findMany({ where: { rating: { equals: 9.5 } } });

  // The RECORD stays wide — a value outside the union is still legal data.
  const { records } = await db.movies.findMany();
  const raw: string = records[0]!.certification;
  void raw;
}

async function invalid() {
  // not a member of the certification union
  // @ts-expect-error
  await db.movies.findMany({ where: { certification: { equals: "NC-17" } } });

  // not a member, inside \`in\`
  // @ts-expect-error
  await db.movies.findMany({ where: { certification: { in: ["G", "NC-17"] } } });

  // not a member, via a multi field's \`some\` shorthand
  // @ts-expect-error
  await db.movies.findMany({ where: { genres: { some: "Horror" } } });

  // not a member, via \`some: { equals }\`
  // @ts-expect-error
  await db.movies.findMany({ where: { genres: { some: { equals: "Horror" } } } });

  // and the exported union itself rejects a non-member
  // @ts-expect-error
  const bad: MoviesCertification = "NC-17";
  void bad;
}

void valid;
void invalid;
`;
    assertConsumerCompiles(clientOutDir, consumerSource);
  });

  test("T6: tsc exits 0 for a consumer exercising endsWith/contains only where opted in, per-operator", () => {
    const t6Config: ZonemapDbConfig = {
      ...indexedConfig,
      schema: {
        sortField: "year",
        fields: {
          year: { kind: "number" },
          title: { kind: "string", indexed: true, endsWith: true, contains: true },
          rating: { kind: "number", indexed: true },
          // Indexed string field with ONLY contains opted in — proves the gate is per-OPERATOR,
          // not just "this field has some opt-in" (a plain kind/indexed check couldn't catch that).
          director: { kind: "string", indexed: true, contains: true },
        },
      },
    };
    // Overwrite the shared fixture with one that actually has `director` values (MOVIES has none).
    writeFileSync(
      path.join(tmpDir, "movies.ndjson"),
      MOVIES.map((m) => JSON.stringify({ ...m, director: "Nolan" })).join("\n") + "\n",
    );
    const { clientOutDir } = build(t6Config, { baseDir: tmpDir, generatorVersion: "0.1.0", formatVersion: 0 });

    const consumerSource = `
import { connect } from "./client.js";

const db = connect();

async function valid() {
  await db.movies.findMany({ where: { title: { endsWith: "Knight" } } });
  await db.movies.findMany({ where: { title: { contains: "Matr" } } });
  // contains/endsWith prune via their own index, so each is valid as a SOLE constraint (not a filter-only rider).
  await db.movies.findMany({ where: { title: { contains: "Matr" } }, limit: 1 });
  await db.movies.findMany({ where: { director: { contains: "Nolan" } } });
}

async function invalid() {
  // rating is indexed but never opted into endsWith/contains — disabled operators.
  // @ts-expect-error
  await db.movies.findMany({ where: { rating: { endsWith: "5" } } });
  // @ts-expect-error
  await db.movies.findMany({ where: { rating: { contains: "5" } } });

  // director opted into contains but NOT endsWith — proves the gate is per-operator, not per-field.
  // @ts-expect-error
  await db.movies.findMany({ where: { director: { endsWith: "n" } } });

  // wrong value type: title's operators all take strings.
  // @ts-expect-error
  await db.movies.findMany({ where: { title: { endsWith: 5 } } });
  // @ts-expect-error
  await db.movies.findMany({ where: { title: { contains: 5 } } });
}

void valid;
void invalid;
`;
    assertConsumerCompiles(clientOutDir, consumerSource);
  });

  test("T7: tsc exits 0 for a consumer exercising some/presence ops/not-with-pruning and rejecting their misuse", () => {
    const t7Config: ZonemapDbConfig = {
      ...config,
      schema: {
        sortField: "year",
        fields: {
          year: { kind: "number" },
          title: { kind: "string", indexed: true },
          tagline: { kind: "string", indexed: true, absent: true, nullable: true },
          studio: { kind: "string", indexed: true, nullable: true },
          genres: { kind: "string", indexed: true, multi: true },
        },
      },
    };
    writeFileSync(
      path.join(tmpDir, "movies.ndjson"),
      [
        { year: 1999, title: "The Matrix", genres: ["Sci-Fi", "Action"], tagline: "Welcome to the Real World", studio: "WB" },
        { year: 2000, title: "Gladiator", genres: ["Action", "Drama"], studio: null },
        { year: 2000, title: "Snatch", genres: ["Crime", "Comedy"], tagline: null, studio: "Columbia" },
        { year: 2008, title: "The Dark Knight", genres: ["Action", "Crime"], tagline: "Why So Serious?", studio: "WB" },
      ]
        .map((m) => JSON.stringify(m))
        .join("\n") + "\n",
    );
    const { clientOutDir } = build(t7Config, { baseDir: tmpDir, generatorVersion: "0.1.0", formatVersion: 0 });

    const consumerSource = `
import { connect } from "./client.js";

const db = connect();

async function valid() {
  // Multi-valued field forces \`some\`, shorthand and object form both work.
  await db.movies.findMany({ where: { genres: { some: "Sci-Fi" } } });
  await db.movies.findMany({ where: { genres: { some: { startsWith: "Sci" } } } });

  // Presence ops on the absentable field. They're riders, so each rides on a sort-field range.
  await db.movies.findMany({ where: { year: { gte: 1900 }, tagline: { isNull: true } } });
  await db.movies.findMany({ where: { year: { gte: 1900 }, tagline: { isAbsent: true } } });
  await db.movies.findMany({ where: { year: { gte: 1900 }, tagline: { exists: false } } });

  // A nullable-only field gets isNull and exists, but not isAbsent.
  await db.movies.findMany({ where: { year: { gte: 1900 }, studio: { isNull: true } } });
  await db.movies.findMany({ where: { year: { gte: 1900 }, studio: { exists: true } } });

  // \`not\` alongside a real pruning constraint on the SAME field compiles and runs.
  await db.movies.findMany({ where: { title: { not: "Gladiator", startsWith: "G" } } });

  // The record type says what the data can hold: optional for absent, | null for nullable.
  const { records } = await db.movies.findMany({ limit: 1 });
  const movie = records[0]!;
  const tagline: string | null | undefined = movie.tagline;
  const studio: string | null = movie.studio;
  void tagline;
  void studio;
}

async function invalid() {
  // some on a single-valued (non-multi) field.
  // @ts-expect-error
  await db.movies.findMany({ where: { title: { some: "Gladiator" } } });

  // a non-some operator directly on a multi-valued field — must go through \`some\`.
  // @ts-expect-error
  await db.movies.findMany({ where: { genres: { equals: "Action" } } });

  // absent-ops on a field that never opted into absent: true.
  // @ts-expect-error
  await db.movies.findMany({ where: { title: { isNull: true } } });
  // @ts-expect-error
  await db.movies.findMany({ where: { title: { isAbsent: true } } });
  // @ts-expect-error
  await db.movies.findMany({ where: { title: { exists: true } } });

  // isAbsent on a field whose key is never missing.
  // @ts-expect-error
  await db.movies.findMany({ where: { studio: { isAbsent: true } } });

  // The record type admits null and absence, so narrowing is required before use as a string.
  const { records } = await db.movies.findMany({ limit: 1 });
  // @ts-expect-error
  const tagline: string = records[0]!.tagline;
  // @ts-expect-error
  const studio: string = records[0]!.studio;
  void tagline;
  void studio;

  // \`not\` as the SOLE constraint — RiderGuard rejects it (no pruning companion).
  // @ts-expect-error
  await db.movies.findMany({ where: { title: { not: "Gladiator" } } });

  // the missing-value operators are riders too, so alone they're rejected (ADR-0013).
  // @ts-expect-error
  await db.movies.findMany({ where: { tagline: { isNull: true } } });
}

void valid;
void invalid;
`;
    assertConsumerCompiles(clientOutDir, consumerSource);
  });

  describe("list operators (ADR-0010)", () => {
    const listConfig: ZonemapDbConfig = {
      ...config,
      blockBytes: 60,
      schema: {
        sortField: "year",
        fields: {
          year: { kind: "number" },
          title: { kind: "string", indexed: true },
          genres: { kind: "string", indexed: true, multi: true, absent: true, values: ["Action", "Drama", "Crime"] },
        },
      },
    };
    const LIST_MOVIES = [
      { year: 1990, title: "A", genres: [] },
      { year: 1991, title: "B", genres: ["Action"] },
      { year: 1992, title: "C", genres: ["Drama"] },
      { year: 1993, title: "D" },
      { year: 1994, title: "E", genres: [] },
      { year: 1995, title: "F", genres: ["Action", "Crime"] },
    ];
    const writeListMovies = () =>
      writeFileSync(path.join(tmpDir, "movies.ndjson"), LIST_MOVIES.map((m) => JSON.stringify(m)).join("\n") + "\n");

    test("the manifest lists, per multi-valued field, exactly the blocks holding a present []", () => {
      writeListMovies();
      const { manifest, outputDir } = build(listConfig, { baseDir: tmpDir, generatorVersion: "0.1.0", formatVersion: 0 });
      expect(manifest.blocks.length).toBeGreaterThan(2);

      const expected = manifest.blocks.flatMap((block, ordinal) => {
        const records = readFileSync(path.join(outputDir, "blocks", `${block.hash}.ndjson`), "utf8")
          .split("\n")
          .filter((l) => l.length > 0)
          .map((l) => JSON.parse(l) as { genres?: unknown[] });
        // A missing key is not an empty list (ADR-0010 §3), so record D must not count.
        return records.some((r) => Array.isArray(r.genres) && r.genres.length === 0) ? [ordinal] : [];
      });
      expect(expected.length).toBeGreaterThan(0);
      expect(manifest.indexes.genres!.emptyBlocks).toEqual(expected);
      // Only multi-valued fields carry it.
      expect(manifest.indexes.title!.emptyBlocks).toBeUndefined();
    });

    test("a multi-valued field with no empty lists still carries emptyBlocks, as []", () => {
      writeFileSync(
        path.join(tmpDir, "movies.ndjson"),
        LIST_MOVIES.filter((m) => m.genres?.length !== 0).map((m) => JSON.stringify(m)).join("\n") + "\n",
      );
      const { manifest } = build(listConfig, { baseDir: tmpDir, generatorVersion: "0.1.0", formatVersion: 0 });
      // [] means "no block holds one"; a missing key would mean "unknown" to the runtime.
      expect(manifest.indexes.genres!.emptyBlocks).toEqual([]);
    });

    test("tsc exits 0 for a consumer using hasEvery/every/isEmpty, and rejects their misuse", () => {
      writeListMovies();
      const { clientOutDir } = build(listConfig, { baseDir: tmpDir, generatorVersion: "0.1.0", formatVersion: 0 });

      const consumerSource = `
import { connect } from "./client.js";

const db = connect();

async function valid() {
  await db.movies.findMany({ where: { genres: { hasEvery: ["Action", "Crime"] } } });
  await db.movies.findMany({ where: { genres: { every: { in: ["Action", "Drama"] } } } });
  await db.movies.findMany({ where: { genres: { every: "Action" } } });
  await db.movies.findMany({ where: { genres: { isEmpty: true } } });
  // exactly [Action, Crime]: two keys on one field AND together.
  await db.movies.findMany({ where: { genres: { hasEvery: ["Action", "Crime"], every: { in: ["Action", "Crime"] } } } });
}

async function invalid() {
  // list operators belong to multi-valued fields only.
  // @ts-expect-error
  await db.movies.findMany({ where: { title: { hasEvery: ["A"] } } });
  // @ts-expect-error
  await db.movies.findMany({ where: { title: { isEmpty: true } } });

  // values narrow to the field's baked union, like some's equality operators.
  // @ts-expect-error
  await db.movies.findMany({ where: { genres: { hasEvery: ["Western"] } } });
  // @ts-expect-error
  await db.movies.findMany({ where: { genres: { every: { in: ["Western"] } } } });

  // isEmpty is true-only; "non-empty" is some over anything.
  // @ts-expect-error
  await db.movies.findMany({ where: { genres: { isEmpty: false } } });
}

void valid;
void invalid;
`;
      assertConsumerCompiles(clientOutDir, consumerSource);
    });
  });

  test("T8: tsc exits 0 for a consumer exercising get(id) when a pk is declared, and rejecting get on a pk-less collection", () => {
    const pkConfig: ZonemapDbConfig = {
      ...config,
      schema: { sortField: "year", pk: "title", fields: { year: { kind: "number" }, title: { kind: "string", indexed: true } } },
    };
    const { clientOutDir: pkClientOutDir } = build(pkConfig, { baseDir: tmpDir, generatorVersion: "0.1.0", formatVersion: 0 });

    const pkConsumerSource = `
import { connect } from "./client.js";

const db = connect();

async function valid() {
  const hit: { title: string; year: number } | null = await db.movies.get("Gladiator");
  void hit;
}

async function invalid() {
  // get(id) takes the pk's value type — title is a string.
  // @ts-expect-error
  await db.movies.get(5);
}

void valid;
void invalid;
`;
    assertConsumerCompiles(pkClientOutDir, pkConsumerSource);

    const noPkTmpDir = mkdtempSync(path.join(tmpdir(), "zonemapdb-seam1-nopk-"));
    writeFileSync(path.join(noPkTmpDir, "movies.ndjson"), MOVIES.map((m) => JSON.stringify(m)).join("\n") + "\n");
    const { clientOutDir: noPkClientOutDir } = build(config, { baseDir: noPkTmpDir, generatorVersion: "0.1.0", formatVersion: 0 });

    const noPkConsumerSource = `
import { connect } from "./client.js";

const db = connect();

async function invalid() {
  // no pk declared — the collection has no \`get\` member at all.
  // @ts-expect-error
  await db.movies.get("anything");
}

void invalid;
`;
    assertConsumerCompiles(noPkClientOutDir, noPkConsumerSource);
    rmSync(noPkTmpDir, { recursive: true, force: true });
  });
});

describe("seam #1 — init --yes → build (T10)", () => {
  const PRODUCTS = [
    { id: "p1", category: "electronics", price: 100, name: "Widget" },
    { id: "p2", category: "electronics", price: 200, name: "Gadget" },
    { id: "p3", category: "books", price: 15, name: "Novel" },
    { id: "p4", category: "books", price: 20, name: "Textbook" },
    { id: "p5", category: "toys", price: 30, name: "Blocks" },
  ];

  function writeProducts(dir: string, records: typeof PRODUCTS = PRODUCTS): void {
    writeFileSync(path.join(dir, "products.ndjson"), records.map((p) => JSON.stringify(p)).join("\n") + "\n");
  }

  test("init --yes infers a schema and writes a config that build consumes just like a hand-authored one", () => {
    writeProducts(tmpDir);
    const configPath = path.join(tmpDir, "zonemapdb.config.json");

    const { config: written, reinferred } = init({
      cwd: tmpDir,
      configPath,
      yes: true,
      fullScan: true,
      inputPath: "products.ndjson",
    });

    expect(reinferred).toBe(true);
    expect(written.$schema).toBeDefined();
    expect(written.formatVersion).toBe(getFormatVersion());
    expect(written.schema.sortField).toBe("price"); // the only number/date field observed
    expect(written.schema.fields.category?.indexed).toBe(true); // low-cardinality categorical field
    expect(written.schema.pk).toBe("id"); // unique + id-named — recommended as the user PK
    expect(written.schema.fields.id?.indexed).toBe(true); // pk must be indexed so get(id) has a lookup path
    expect(existsSync(configPath)).toBe(true);

    const { manifest } = build(loadConfigFile(configPath), { baseDir: tmpDir, generatorVersion: "0.1.0", formatVersion: 0 });
    expect(manifest.dataset.recordCount).toBe(PRODUCTS.length);
    expect(manifest.dataset.sortField).toBe("price");
  });

  test("init --yes requires --yes — the interactive wizard isn't implemented yet", () => {
    writeProducts(tmpDir);
    expect(() =>
      init({ cwd: tmpDir, configPath: path.join(tmpDir, "zonemapdb.config.json"), yes: false, inputPath: "products.ndjson" }),
    ).toThrow(/--yes/);
  });

  test("init --yes is deterministic: identical input infers an identical baked schema on repeat runs", () => {
    writeProducts(tmpDir);
    const configPathA = path.join(tmpDir, "a.config.json");
    const configPathB = path.join(tmpDir, "b.config.json");

    const { config: a } = init({ cwd: tmpDir, configPath: configPathA, yes: true, fullScan: true, inputPath: "products.ndjson" });
    const { config: b } = init({ cwd: tmpDir, configPath: configPathB, yes: true, fullScan: true, inputPath: "products.ndjson" });

    expect(a).toEqual(b);
    expect(readFileSync(configPathA, "utf8")).toBe(readFileSync(configPathB, "utf8"));
  });

  test("an explicit --sort-field flag overrides the inferred recommendation", () => {
    // id is unique but string-kind, so it isn't inference-eligible on its own — declare a second
    // number field so both "price" (the inferred pick) and "rank" (the override) are valid candidates.
    const withRank = PRODUCTS.map((p, i) => ({ ...p, rank: i + 1 }));
    writeProducts(tmpDir, withRank);
    const configPath = path.join(tmpDir, "zonemapdb.config.json");

    const { config } = init({
      cwd: tmpDir,
      configPath,
      yes: true,
      fullScan: true,
      inputPath: "products.ndjson",
      sortField: "rank",
    });

    expect(config.schema.sortField).toBe("rank");
  });

  test("--indexed fully overrides the indexed set on re-run rather than merging with it (flags > file)", () => {
    writeProducts(tmpDir);
    const configPath = path.join(tmpDir, "zonemapdb.config.json");
    const { config: before } = init({ cwd: tmpDir, configPath, yes: true, fullScan: true, inputPath: "products.ndjson" });
    expect(before.schema.fields.category?.indexed).toBe(true);

    const { config: after } = init({ cwd: tmpDir, configPath, yes: true, indexedFields: ["name"] });

    expect(after.schema.fields.name?.indexed).toBe(true);
    expect(after.schema.fields.category?.indexed).toBeUndefined(); // no longer merged in from the old set
  });

  test("--ends-with/--contains opt a field into the reversed/trigram index and force it indexed", () => {
    writeProducts(tmpDir);
    const configPath = path.join(tmpDir, "zonemapdb.config.json");
    init({ cwd: tmpDir, configPath, yes: true, fullScan: true, inputPath: "products.ndjson" });

    const { config } = init({ cwd: tmpDir, configPath, yes: true, endsWithFields: ["name"], containsFields: ["name"] });

    expect(config.schema.fields.name).toEqual({ kind: "string", indexed: true, endsWith: true, contains: true });
  });

  test("build fails loud when the input data has drifted from the baked schema's declared kind", () => {
    writeProducts(tmpDir);
    const configPath = path.join(tmpDir, "zonemapdb.config.json");
    init({ cwd: tmpDir, configPath, yes: true, fullScan: true, inputPath: "products.ndjson" });

    // price drifts from number to string after the schema was baked.
    const drifted = PRODUCTS.map((p) => ({ ...p, price: String(p.price) }));
    writeProducts(tmpDir, drifted);

    expect(() => build(loadConfigFile(configPath), { baseDir: tmpDir, generatorVersion: "0.1.0", formatVersion: 0 })).toThrow(
      /drift/i,
    );
  });

  test("a build that fails leaves the previous build's output in place, and no staging directory", () => {
    writeProducts(tmpDir);
    const configPath = path.join(tmpDir, "zonemapdb.config.json");
    init({ cwd: tmpDir, configPath, yes: true, fullScan: true, inputPath: "products.ndjson" });
    const { outputDir } = build(loadConfigFile(configPath), { baseDir: tmpDir, generatorVersion: "0.1.0", formatVersion: 0 });
    const manifestBefore = readFileSync(path.join(outputDir, "manifest.json"), "utf8");

    writeProducts(tmpDir, PRODUCTS.map((p) => ({ ...p, price: String(p.price) })));
    expect(() => build(loadConfigFile(configPath), { baseDir: tmpDir, generatorVersion: "0.1.0", formatVersion: 0 })).toThrow(/drift/i);

    expect(readFileSync(path.join(outputDir, "manifest.json"), "utf8")).toBe(manifestBefore);
    expect(readdirSync(path.dirname(outputDir)).filter((name) => name.includes("zonemapdb-partial"))).toEqual([]);
  });

  test("a build that fails after writing blocks cleans up its staging directory too", () => {
    writeProducts(tmpDir);
    const configPath = path.join(tmpDir, "zonemapdb.config.json");
    init({ cwd: tmpDir, configPath, yes: true, fullScan: true, inputPath: "products.ndjson" });
    const { outputDir } = build(loadConfigFile(configPath), { baseDir: tmpDir, generatorVersion: "0.1.0", formatVersion: 0 });
    const manifestBefore = readFileSync(path.join(outputDir, "manifest.json"), "utf8");

    // Fails once indexing starts, like a full disk would: by then the staging tree holds blocks.
    const staging = path.join(path.dirname(outputDir), `.${path.basename(outputDir)}.zonemapdb-partial`);
    let stagedBlocks = 0;
    const failWhileIndexing = (event: { phase: string }) => {
      if (!event.phase.startsWith("indexing")) return;
      stagedBlocks = readdirSync(path.join(staging, "blocks")).length;
      throw new Error("ENOSPC: no space left on device");
    };
    expect(() =>
      build(loadConfigFile(configPath), { baseDir: tmpDir, generatorVersion: "0.1.0", formatVersion: 0, onProgress: failWhileIndexing }),
    ).toThrow(/ENOSPC/);

    expect(stagedBlocks).toBeGreaterThan(0);
    expect(existsSync(staging)).toBe(false);
    expect(readFileSync(path.join(outputDir, "manifest.json"), "utf8")).toBe(manifestBefore);
  });

  test("--reinfer refreshes the baked schema after the data's shape changes", () => {
    writeProducts(tmpDir);
    const configPath = path.join(tmpDir, "zonemapdb.config.json");
    const { config: before } = init({ cwd: tmpDir, configPath, yes: true, fullScan: true, inputPath: "products.ndjson" });
    expect(before.schema.fields.brand).toBeUndefined();

    const withBrand = PRODUCTS.map((p) => ({ ...p, brand: p.category === "books" ? "Penguin" : "Acme" }));
    writeProducts(tmpDir, withBrand);

    const { config: after, reinferred } = init({
      cwd: tmpDir,
      configPath,
      yes: true,
      fullScan: true,
      reinfer: true,
    });

    expect(reinferred).toBe(true);
    expect(after.schema.fields.brand).toBeDefined();
  });

  test("--reinfer refreshes facts about the data but keeps every choice the user made", () => {
    const configPath = path.join(tmpDir, "zonemapdb.config.json");
    // A hand-tuned config: string sort field, a trimmed indexed set, a text opt-in, compression, a
    // non-default block size. None of these are what inference would pick on its own.
    const tuned: ZonemapDbConfig = {
      collection: "products",
      input: { path: "products.ndjson" },
      blockBytes: 1234,
      compression: "gzip",
      schema: {
        sortField: "name",
        pk: "id",
        fields: {
          id: { kind: "string", indexed: true },
          name: { kind: "string" },
          category: { kind: "string", indexed: true, contains: true, values: ["books", "electronics", "toys"] },
          price: { kind: "number" },
        },
      },
    };
    writeFileSync(configPath, JSON.stringify(tuned, null, 2));

    // The data changes: a new category, some null prices, and a new sometimes-missing field.
    const changed = [
      ...PRODUCTS.map((p, i) => ({ ...p, price: i === 0 ? null : p.price, ...(i % 2 === 0 ? { note: "sale" } : {}) })),
      { id: "p6", category: "garden", price: 12, name: "Trowel" },
    ];
    writeFileSync(path.join(tmpDir, "products.ndjson"), changed.map((p) => JSON.stringify(p)).join("\n") + "\n");

    const { config } = init({ cwd: tmpDir, configPath, yes: true, fullScan: true, reinfer: true });

    // choices kept
    expect(config.schema.sortField).toBe("name");
    expect(config.schema.pk).toBe("id");
    expect(config.compression).toBe("gzip");
    expect(config.blockBytes).toBe(1234);
    expect(config.schema.fields.price!.indexed).toBeUndefined();
    expect(config.schema.fields.category!.contains).toBe(true);
    // facts refreshed
    expect(config.schema.fields.price!.nullable).toBe(true);
    expect(config.schema.fields.category!.values).toEqual(["books", "electronics", "garden", "toys"]);
    expect(config.schema.fields.note).toMatchObject({ kind: "string", absent: true });
    // and the refreshed config builds against the changed data
    expect(() => build(config, { baseDir: tmpDir, generatorVersion: "0.1.0", formatVersion: 0 })).not.toThrow();
  });

  test("--reinfer leaves a deliberately widened field widened", () => {
    const configPath = path.join(tmpDir, "zonemapdb.config.json");
    writeProducts(tmpDir);
    const { config: first } = init({ cwd: tmpDir, configPath, yes: true, fullScan: true, inputPath: "products.ndjson" });
    // The user deletes `values` to widen an indexed enum-like field back to plain string.
    const enumField = Object.entries(first.schema.fields).find(([, f]) => f.values !== undefined)![0];
    const widened = JSON.parse(readFileSync(configPath, "utf8")) as ZonemapDbConfig;
    delete widened.schema.fields[enumField]!.values;
    writeFileSync(configPath, JSON.stringify(widened, null, 2));

    const { config } = init({ cwd: tmpDir, configPath, yes: true, fullScan: true, reinfer: true });
    expect(config.schema.fields[enumField]!.values).toBeUndefined();
  });

  test("a kept text opt-in can be turned off: by un-indexing the field, or by leaving it out of --contains", () => {
    writeProducts(tmpDir);
    const configPath = path.join(tmpDir, "zonemapdb.config.json");
    const withContains: ZonemapDbConfig = {
      collection: "products",
      input: { path: "products.ndjson" },
      schema: {
        sortField: "name",
        fields: {
          id: { kind: "string", indexed: true },
          name: { kind: "string" },
          category: { kind: "string", indexed: true, contains: true, endsWith: true },
          price: { kind: "number" },
        },
      },
    };
    writeFileSync(configPath, JSON.stringify(withContains, null, 2));

    // Un-indexing takes the opt-ins with it, rather than failing on "contains but not indexed".
    for (const reinfer of [true, false]) {
      const { config } = resolveInitConfig({ cwd: tmpDir, configPath, yes: true, reinfer, indexedFields: ["id"] });
      expect(config.schema.fields.category).not.toHaveProperty("indexed");
      expect(config.schema.fields.category).not.toHaveProperty("contains");
      expect(config.schema.fields.category).not.toHaveProperty("endsWith");
    }

    // --contains is the complete set, like --indexed: the wizard passes [] when nothing is ticked.
    const { config } = resolveInitConfig({ cwd: tmpDir, configPath, yes: true, reinfer: true, indexedFields: ["id", "category"], containsFields: [] });
    expect(config.schema.fields.category!.indexed).toBe(true);
    expect(config.schema.fields.category).not.toHaveProperty("contains");
    expect(config.schema.fields.category!.endsWith).toBe(true);
  });

  test("re-running init without --reinfer keeps compression", () => {
    writeProducts(tmpDir);
    const configPath = path.join(tmpDir, "zonemapdb.config.json");
    init({ cwd: tmpDir, configPath, yes: true, fullScan: true, inputPath: "products.ndjson" });
    const withCompression = { ...(JSON.parse(readFileSync(configPath, "utf8")) as ZonemapDbConfig), compression: "brotli" as const };
    writeFileSync(configPath, JSON.stringify(withCompression, null, 2));

    expect(init({ cwd: tmpDir, configPath, yes: true }).config.compression).toBe("brotli");
  });

  test("without --reinfer, re-running init on an existing config reuses the baked schema untouched", () => {
    writeProducts(tmpDir);
    const configPath = path.join(tmpDir, "zonemapdb.config.json");
    const { config: before } = init({ cwd: tmpDir, configPath, yes: true, fullScan: true, inputPath: "products.ndjson" });

    const withBrand = PRODUCTS.map((p) => ({ ...p, brand: "Acme" }));
    writeProducts(tmpDir, withBrand);

    const { config: after, reinferred } = init({ cwd: tmpDir, configPath, yes: true });

    expect(reinferred).toBe(false);
    expect(after.schema).toEqual(before.schema);
  });
});

describe("seam #1 — asking to index a payload-only json field degrades gracefully", () => {
  // `prices` is a nested object, so inference makes it payload-only kind "json" — it can be
  // returned but never filtered on. Asking to index it must not cost the user the whole config.
  const NESTED = [
    { id: "p1", category: "electronics", price: 100, name: "Widget", prices: { usd: "1.50" } },
    { id: "p2", category: "electronics", price: 200, name: "Gadget", prices: { usd: "2.00" } },
    { id: "p3", category: "books", price: 15, name: "Novel", prices: { usd: "3.00", eur: "2.80" } },
  ];

  function writeNested(dir: string): void {
    writeFileSync(path.join(dir, "nested.ndjson"), NESTED.map((p) => JSON.stringify(p)).join("\n") + "\n");
  }

  test("init reads every record by default, so inference sees data past the first 1000", () => {
    // A field and a value that only appear late in the file. Sampling the leading records misses
    // both: the field looks absent-free and the enum looks closed at two values.
    const rows = Array.from({ length: 2500 }, (_, i) => ({
      id: `r${i}`,
      rank: i,
      tier: i < 1200 ? (i % 2 === 0 ? "bronze" : "silver") : "gold",
      ...(i > 2000 ? { note: "late arrival" } : {}),
    }));
    writeFileSync(path.join(tmpDir, "late.ndjson"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const configPath = path.join(tmpDir, "zonemapdb.config.json");

    const { config } = init({ cwd: tmpDir, configPath, yes: true, inputPath: "late.ndjson" });

    // the late-only field was discovered at all
    expect(config.schema.fields.note).toBeDefined();
    // and "gold" is in tier's value union, which a leading sample would never have seen
    expect(config.schema.fields.tier?.values).toEqual(["bronze", "gold", "silver"]);
  });

  test("--sample-size opts back into a leading sample, and misses what lies beyond it", () => {
    const rows = Array.from({ length: 2500 }, (_, i) => ({
      id: `r${i}`,
      rank: i,
      tier: i < 1200 ? (i % 2 === 0 ? "bronze" : "silver") : "gold",
    }));
    writeFileSync(path.join(tmpDir, "late.ndjson"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const configPath = path.join(tmpDir, "zonemapdb.config.json");

    const { config } = init({ cwd: tmpDir, configPath, yes: true, inputPath: "late.ndjson", sampleSize: 500 });

    // sampling is a documented speed/accuracy trade, not a silent one — "gold" is simply not there
    expect(config.schema.fields.tier?.values).toEqual(["bronze", "silver"]);
  });

  test("--reinfer keeps a hand-authored tsType on a json field", () => {
    writeNested(tmpDir);
    const configPath = path.join(tmpDir, "zonemapdb.config.json");

    init({ cwd: tmpDir, configPath, yes: true, fullScan: true, inputPath: "nested.ndjson" });

    // the user hand-adds a payload type, as the docs tell them to
    const authored = JSON.parse(readFileSync(configPath, "utf8")) as ZonemapDbConfig;
    authored.schema.fields.prices = {
      kind: "json",
      tsType: "Prices",
      tsImport: 'import type { Prices } from "../types/prices.js";',
    };
    writeFileSync(configPath, JSON.stringify(authored, null, 2));

    // --reinfer rediscovers the DATA's shape; it must not discard declarations only the user can make
    const { config } = init({ cwd: tmpDir, configPath, yes: true, fullScan: true, reinfer: true });

    expect(config.schema.fields.prices?.tsType).toBe("Prices");
    expect(config.schema.fields.prices?.tsImport).toBe('import type { Prices } from "../types/prices.js";');
  });

  test("--indexed naming a json field drops just that field and still writes a usable config", () => {
    writeNested(tmpDir);
    const configPath = path.join(tmpDir, "zonemapdb.config.json");

    const { config, warnings } = init({
      cwd: tmpDir,
      configPath,
      yes: true,
      fullScan: true,
      inputPath: "nested.ndjson",
      indexedFields: ["category", "prices"],
    });

    // the offending field is un-indexed, not fatal — and everything else the user asked for survives
    expect(config.schema.fields.prices?.kind).toBe("json");
    expect(config.schema.fields.prices?.indexed).toBeUndefined();
    expect(config.schema.fields.category?.indexed).toBe(true);
    expect(existsSync(configPath)).toBe(true);

    expect(warnings.join("\n")).toMatch(/prices/);
    expect(warnings.join("\n")).toMatch(/payload-only|can't be filtered|cannot be filtered/i);

    // and the config it wrote is one `build` accepts
    const { manifest } = build(loadConfigFile(configPath), { baseDir: tmpDir, generatorVersion: "0.1.0", formatVersion: 0 });
    expect(manifest.dataset.recordCount).toBe(NESTED.length);
    expect(manifest.schema.fields.prices?.indexed).toBe(false);
  });

  test("--contains / --ends-with naming a json field are dropped the same way", () => {
    writeNested(tmpDir);
    const configPath = path.join(tmpDir, "zonemapdb.config.json");

    const { config, warnings } = init({
      cwd: tmpDir,
      configPath,
      yes: true,
      fullScan: true,
      inputPath: "nested.ndjson",
      containsFields: ["prices"],
      endsWithFields: ["prices"],
    });

    expect(config.schema.fields.prices?.contains).toBeUndefined();
    expect(config.schema.fields.prices?.endsWith).toBeUndefined();
    expect(config.schema.fields.prices?.indexed).toBeUndefined();
    expect(warnings.join("\n")).toMatch(/prices/);
  });

  test("an existing config that already marks a json field indexed is repaired rather than rejected", () => {
    writeNested(tmpDir);
    const configPath = path.join(tmpDir, "zonemapdb.config.json");
    init({ cwd: tmpDir, configPath, yes: true, fullScan: true, inputPath: "nested.ndjson" });

    // simulate a hand-edited config (or one written by an older version)
    const handEdited = loadConfigFile(configPath);
    handEdited.schema.fields.prices = { kind: "json", indexed: true, contains: true };
    writeFileSync(configPath, JSON.stringify(handEdited, null, 2));

    const { config, warnings } = init({ cwd: tmpDir, configPath, yes: true });
    expect(config.schema.fields.prices?.indexed).toBeUndefined();
    expect(config.schema.fields.prices?.contains).toBeUndefined();
    expect(warnings.join("\n")).toMatch(/prices/);
  });

  test("a json field named as the sortField is still a hard error — there is no safe repair", () => {
    writeNested(tmpDir);
    expect(() =>
      init({
        cwd: tmpDir,
        configPath: path.join(tmpDir, "zonemapdb.config.json"),
        yes: true,
        fullScan: true,
        inputPath: "nested.ndjson",
        sortField: "prices",
      }),
    ).toThrow(/prices/);
  });
});

describe("seam #1 — external sort scale hardening (T13)", () => {
  test("forcing the disk-spill path (a tiny sortRunRecords) produces the same manifest+blocks as the in-memory path", () => {
    const inMemory = build(config, { baseDir: tmpDir, generatorVersion: "0.1.0", formatVersion: 0 });
    const spilled = build(config, {
      baseDir: tmpDir,
      generatorVersion: "0.1.0",
      formatVersion: 0,
      sortRunRecords: 2,
    });

    expect(spilled.manifest).toEqual(inMemory.manifest);
    expect(spilled.manifest.blocks.map((s) => s.hash)).toEqual(inMemory.manifest.blocks.map((s) => s.hash));
  });

  test("rebuilding after changing one record's data changes only that record's block hash, not the others (ADR-0003 §8)", () => {
    const tinyBlockConfig: ZonemapDbConfig = { ...config, blockBytes: 60 }; // forces multiple blocks
    writeFileSync(path.join(tmpDir, "movies.ndjson"), MOVIES.map((m) => JSON.stringify(m)).join("\n") + "\n");
    const before = build(tinyBlockConfig, { baseDir: tmpDir, generatorVersion: "0.1.0", formatVersion: 0 });
    expect(before.manifest.blocks.length).toBeGreaterThan(1);

    // Same byte length ("8.7" → "1.7") so the block byte-target cut points don't shift — isolates
    // the assertion to "did the hash change", not "did block boundaries also move".
    const changed = MOVIES.map((m, i) => (i === 0 ? { ...m, rating: 1.7 } : m));
    writeFileSync(path.join(tmpDir, "movies.ndjson"), changed.map((m) => JSON.stringify(m)).join("\n") + "\n");
    const after = build(tinyBlockConfig, { baseDir: tmpDir, generatorVersion: "0.1.0", formatVersion: 0 });

    expect(after.manifest.blocks.length).toBe(before.manifest.blocks.length);
    const changedOrdinals = before.manifest.blocks
      .map((_, i) => i)
      .filter((i) => before.manifest.blocks[i]!.hash !== after.manifest.blocks[i]!.hash);
    expect(changedOrdinals).toHaveLength(1); // exactly the one block holding the changed record
  });

  test("rebuilding from a shuffled copy of the same records produces byte-identical block hashes (ADR-0002 §6/ADR-0003 §8)", () => {
    const shuffled = [...MOVIES].reverse();
    writeFileSync(path.join(tmpDir, "movies.ndjson"), shuffled.map((m) => JSON.stringify(m)).join("\n") + "\n");

    const fromShuffled = build(config, { baseDir: tmpDir, generatorVersion: "0.1.0", formatVersion: 0 });

    writeFileSync(path.join(tmpDir, "movies.ndjson"), MOVIES.map((m) => JSON.stringify(m)).join("\n") + "\n");
    const fromOriginal = build(config, { baseDir: tmpDir, generatorVersion: "0.1.0", formatVersion: 0 });

    expect(fromShuffled.manifest).toEqual(fromOriginal.manifest);
  });

  test("clusters null/absent sort values into a contiguous, flagged tail", () => {
    const withMissing = [
      { year: 2000, title: "Gladiator" },
      { year: null, title: "Untitled Null" },
      { year: 2010, title: "Inception" },
      { title: "Untitled Absent" },
    ];
    writeFileSync(path.join(tmpDir, "movies.ndjson"), withMissing.map((m) => JSON.stringify(m)).join("\n") + "\n");
    const missingConfig: ZonemapDbConfig = {
      ...config,
      schema: { ...config.schema, fields: { ...config.schema.fields, year: { kind: "number", absent: true, nullable: true }, rating: { kind: "number", absent: true } } },
    };

    const { manifest, outputDir } = build(missingConfig, { baseDir: tmpDir, generatorVersion: "0.1.0", formatVersion: 0 });

    const yearZonemap = manifest.zonemap.year as {
      splitPoints: unknown[];
      missing?: { blockFrom: number; nullCount: number; absentCount: number };
    };
    expect(yearZonemap.missing).toBeDefined();
    expect(yearZonemap.missing!.nullCount).toBe(1);
    expect(yearZonemap.missing!.absentCount).toBe(1);

    // real values sort first (ascending), then null, then absent — contiguous at the tail.
    const lastBlock = manifest.blocks[manifest.blocks.length - 1]!;
    const lastBlockContent = readFileSync(path.join(outputDir, "blocks", `${lastBlock.hash}.ndjson`), "utf8");
    const lastBlockTitles = lastBlockContent
      .trim()
      .split("\n")
      .map((line) => (JSON.parse(line) as { title: string }).title);
    expect(lastBlockTitles).toEqual(["Gladiator", "Inception", "Untitled Null", "Untitled Absent"]);
    expect(yearZonemap.missing!.blockFrom).toBe(manifest.blocks.length - 1);
  });

  test("build() itself (not just inspect) warns on a low-cardinality sort field", () => {
    const lowCardConfig: ZonemapDbConfig = {
      collection: "events",
      input: { path: "events.ndjson" },
      schema: { sortField: "year", fields: { year: { kind: "number" }, name: { kind: "string" } } },
    };
    const records = Array.from({ length: 30 }, (_, i) => ({ year: 2000, name: `event-${i}` }));
    writeFileSync(path.join(tmpDir, "events.ndjson"), records.map((r) => JSON.stringify(r)).join("\n") + "\n");

    const { warnings } = build(lowCardConfig, { baseDir: tmpDir, generatorVersion: "0.1.0", formatVersion: 0 });
    expect(warnings.some((w) => w.includes("distinct value"))).toBe(true);
  });

  test("build() itself warns on a record bigger than the block-byte target (oversized-record skew)", () => {
    const oversizedConfig: ZonemapDbConfig = {
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

    const { warnings } = build(oversizedConfig, { baseDir: tmpDir, generatorVersion: "0.1.0", formatVersion: 0 });
    expect(warnings.some((w) => w.includes("oversized"))).toBe(true);
  });

  test("build() itself warns when blocks skew more than 2x the mean size (equal-key pileup)", () => {
    const skewConfig: ZonemapDbConfig = {
      collection: "blobs",
      input: { path: "blobs.ndjson" },
      schema: { sortField: "id", fields: { id: { kind: "number" }, blob: { kind: "string" } } },
      blockBytes: 20,
    };
    const records = [
      { id: 1, blob: "a" },
      { id: 2, blob: "b" },
      { id: 3, blob: "c" },
      { id: 4, blob: "d" },
      { id: 5, blob: "e" },
      { id: 6, blob: "x".repeat(2000) },
    ];
    writeFileSync(path.join(tmpDir, "blobs.ndjson"), records.map((r) => JSON.stringify(r)).join("\n") + "\n");

    const { warnings } = build(skewConfig, { baseDir: tmpDir, generatorVersion: "0.1.0", formatVersion: 0 });
    expect(warnings.some((w) => /mean block size/.test(w))).toBe(true);
  });

  test("blocks nest under hash-prefix subdirs on disk once blockCount exceeds ~1,000 (ADR-0002 §8)", () => {
    const manyBlocksConfig: ZonemapDbConfig = {
      collection: "events",
      input: { path: "events.ndjson" },
      schema: { sortField: "id", fields: { id: { kind: "number" } } },
      blockBytes: 1,
    };
    const records = Array.from({ length: 1001 }, (_, i) => ({ id: i }));
    writeFileSync(path.join(tmpDir, "events.ndjson"), records.map((r) => JSON.stringify(r)).join("\n") + "\n");

    const { manifest, outputDir } = build(manyBlocksConfig, { baseDir: tmpDir, generatorVersion: "0.1.0", formatVersion: 0 });

    expect(manifest.blocks.length).toBe(1001);
    const firstHash = manifest.blocks[0]!.hash;
    expect(existsSync(path.join(outputDir, "blocks", `${firstHash}.ndjson`))).toBe(false);
    expect(existsSync(path.join(outputDir, "blocks", firstHash.slice(0, 2), `${firstHash}.ndjson`))).toBe(true);
    // Blocks are written flat while the count is unknown, then moved — none may be left behind.
    const top = readdirSync(path.join(outputDir, "blocks"), { withFileTypes: true });
    expect(top.filter((entry) => !entry.isDirectory())).toEqual([]);
  });

  test("compression: brotli writes .ndjson.br blocks that decompress, and preserves block hashes", () => {
    const plain = build(config, { baseDir: tmpDir, generatorVersion: "0.1.0", formatVersion: 0 });
    const br = build(
      { ...config, output: "public/zonemapdb-br", compression: "brotli" },
      { baseDir: tmpDir, generatorVersion: "0.1.0", formatVersion: 0 },
    );

    expect(br.manifest.dataset.compression).toBe("brotli");
    // The hash is over logical, pre-compression content, so it is identical across all three encodings.
    expect(br.manifest.blocks.map((s) => s.hash)).toEqual(plain.manifest.blocks.map((s) => s.hash));

    const hash = br.manifest.blocks[0]!.hash;
    const onDisk = readFileSync(path.join(br.outputDir, "blocks", `${hash}.ndjson.br`));
    expect(existsSync(path.join(br.outputDir, "blocks", `${hash}.ndjson`))).toBe(false);
    expect(brotliDecompressSync(onDisk).toString("utf8")).toBe(
      readFileSync(path.join(plain.outputDir, "blocks", `${hash}.ndjson`), "utf8"),
    );

    // ...and the whole served tree is brotli, manifest and index chunks included
    expect(existsSync(path.join(br.outputDir, "manifest.json.br"))).toBe(true);
    for (const chunk of br.manifest.indexes.title?.chunks ?? []) expect(chunk.file).toMatch(/\.json\.br$/);

    // raw-bytes hosts can't serve it to Chrome, so every brotli build says so; plain builds don't
    expect(br.warnings.some((w) => w.includes("Content-Encoding: br"))).toBe(true);
    expect(plain.warnings.some((w) => w.includes("Content-Encoding: br"))).toBe(false);
  });

  test("optional build-time gzip writes .ndjson.gz blocks, flags manifest.dataset.compression, and preserves block hashes (ADR-0002 §8)", () => {
    const gzipConfig: ZonemapDbConfig = { ...config, output: "public/zonemapdb-gz", gzip: true };

    const plain = build(config, { baseDir: tmpDir, generatorVersion: "0.1.0", formatVersion: 0 });
    const gzipped = build(gzipConfig, { baseDir: tmpDir, generatorVersion: "0.1.0", formatVersion: 0 });

    expect(gzipped.manifest.dataset.compression).toBe("gzip");
    expect(plain.manifest.dataset.compression).toBeUndefined();
    // toggling gzip doesn't perturb block hashes — the hash is over logical, pre-compression content
    expect(gzipped.manifest.blocks.map((s) => s.hash)).toEqual(plain.manifest.blocks.map((s) => s.hash));

    const hash = gzipped.manifest.blocks[0]!.hash;
    expect(existsSync(path.join(gzipped.outputDir, "blocks", `${hash}.ndjson.gz`))).toBe(true);
    expect(existsSync(path.join(gzipped.outputDir, "blocks", `${hash}.ndjson`))).toBe(false);

    const compressed = readFileSync(path.join(gzipped.outputDir, "blocks", `${hash}.ndjson.gz`));
    const plainContent = readFileSync(path.join(plain.outputDir, "blocks", `${hash}.ndjson`), "utf8");
    expect(gunzipSync(compressed).toString("utf8")).toBe(plainContent);
  });
});

describe("seam #1 — warning about text indexes the data can't support", () => {
  const ROWS = Array.from({ length: 40 }, (_, i) => ({
    id: `f47ac10b-58cc-4372-a567-0e02b2c3d${String(i).padStart(3, "0")}`,
    rank: i,
    uri: `https://api.example.com/cards/${i}?utm_source=api`,
    name: `Lightning Bolt ${i}`,
  }));

  beforeEach(() => {
    writeFileSync(path.join(tmpDir, "shaped.ndjson"), ROWS.map((r) => JSON.stringify(r)).join("\n") + "\n");
  });

  test("init warns when endsWith/contains is turned on for URL and UUID fields, but not for real text", () => {
    const { warnings } = init({
      cwd: tmpDir,
      configPath: path.join(tmpDir, "zonemapdb.config.json"),
      yes: true,
      inputPath: "shaped.ndjson",
      endsWithFields: ["uri", "id", "name"],
      containsFields: ["uri", "id", "name"],
    });
    const joined = warnings.join("\n");

    // URLs end in an opaque id or a shared suffix — the reversed index can't discriminate
    expect(joined).toMatch(/endsWith\(uri\)[\s\S]*URL/);
    expect(joined).toMatch(/contains\(uri\)[\s\S]*URL/);
    // hex identifiers have no meaningful substrings either way
    expect(joined).toMatch(/endsWith\(id\)[\s\S]*identifier/);
    expect(joined).toMatch(/contains\(id\)[\s\S]*identifier/);
    // ...and a genuine text field is left alone
    expect(joined).not.toMatch(/\((name)\)/);
  });

  test("says nothing when no text index was requested", () => {
    const { warnings } = init({
      cwd: tmpDir,
      configPath: path.join(tmpDir, "zonemapdb.config.json"),
      yes: true,
      inputPath: "shaped.ndjson",
    });
    expect(warnings.join("\n")).not.toMatch(/endsWith|contains/);
  });
});

/**
 * The motivating shape (ADR-0009): a column stored as TEXT because a minority of its values are
 * domain sentinels, which you nonetheless want to compare numerically. Mirrors Scryfall's `power`,
 * where 1.6% of values are `*`, `1+*` or `∞` and the rest are ordinary integers.
 */
const STATS = [
  { name: "Grizzly Bears", power: "2", year: 1993 },
  { name: "Craw Wurm", power: "6", year: 1993 },
  { name: "Force of Nature", power: "8", year: 1994 },
  { name: "Lord of the Pit", power: "7", year: 1994 },
  { name: "Tarmogoyf", power: "*", year: 2007 },
  { name: "Nameless Race", power: "*", year: 1994 },
  { name: "Angry Mob", power: "2+*", year: 1994 },
  { name: "Impervious Greatwurm", power: "16", year: 2018 },
  { name: "Infinity Elemental", power: "∞", year: 2017 },
  { name: "Ghalta", power: "12", year: 2018 },
];

const deriveConfig: ZonemapDbConfig = {
  collection: "movies",
  input: { path: "stats.ndjson" },
  blockBytes: 90,
  schema: {
    sortField: "year",
    fields: {
      year: { kind: "number" },
      name: { kind: "string" },
      power: { kind: "string", indexed: true },
      power_num: { kind: "number", indexed: true, absent: true, derive: { from: "power", using: "numeric" } },
    },
  },
};

describe("seam #1 — derived fields (ADR-0009)", () => {
  beforeEach(() => {
    writeFileSync(path.join(tmpDir, "stats.ndjson"), STATS.map((s) => JSON.stringify(s)).join("\n") + "\n");
  });

  test("a derived number column is an ordinary indexed field, earning the range operators its source cannot have", () => {
    const { manifest } = build(deriveConfig, { baseDir: tmpDir, generatorVersion: "0.1.0", formatVersion: 0 });

    // `absent: true` (unmappable values leave the key out) adds isAbsent/exists; never null, so no isNull.
    expect(manifest.schema.fields.power_num!.operators).toEqual(["equals", "in", "gt", "gte", "lt", "lte", "not", "isAbsent", "exists"]);
    // The source keeps its own semantics — `equals: "*"` still resolves, ranges still (rightly) don't.
    expect(manifest.schema.fields.power!.operators).toEqual(["equals", "in", "startsWith", "endsWith", "contains", "not"]);
    expect(manifest.zonemap.power_num).toHaveProperty("pairs");
  });

  test("the derived values land in the block payload, and unparseable ones are absent rather than zero", () => {
    const { outputDir } = build(deriveConfig, { baseDir: tmpDir, generatorVersion: "0.1.0", formatVersion: 0 });
    const blocksDir = path.join(outputDir, "blocks");
    const records = readdirSync(blocksDir)
      .flatMap((file) => readFileSync(path.join(blocksDir, file), "utf8").split("\n").filter(Boolean))
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    const byName = new Map(records.map((r) => [r.name as string, r]));
    expect(byName.get("Grizzly Bears")!.power_num).toBe(2);
    expect(byName.get("Impervious Greatwurm")!.power_num).toBe(16);

    // A zero here would silently make Tarmogoyf a 0-power creature and pollute every range query.
    expect("power_num" in byName.get("Tarmogoyf")!).toBe(false);
    expect("power_num" in byName.get("Angry Mob")!).toBe(false);
    expect("power_num" in byName.get("Infinity Elemental")!).toBe(false);

    // The printed value survives untouched, so the UI can still render "2+*".
    expect(byName.get("Angry Mob")!.power).toBe("2+*");
    expect(byName.get("Tarmogoyf")!.power).toBe("*");
  });

  test("the generated types expose ranges on the derived field and still refuse them on the source", () => {
    const { clientOutDir } = build(deriveConfig, { baseDir: tmpDir, generatorVersion: "0.1.0", formatVersion: 0 });

    assertConsumerCompiles(
      clientOutDir,
      `
import { connect } from "./client.js";

const db = connect();

async function valid() {
  await db.movies.findMany({ where: { power_num: { gte: 7 } } });
  await db.movies.findMany({ where: { power_num: { gt: 1, lte: 12 } } });
  // the source column keeps the exact-match query the derived one cannot answer
  await db.movies.findMany({ where: { power: { equals: "*" } } });
  // absent: true unlocks the presence operators, which is how you find the unparseable ones —
  // riders, so they ride on a constraint that prunes
  await db.movies.findMany({ where: { power: { in: ["*", "1+*"] }, power_num: { isAbsent: true } } });
}

async function invalid() {
  // power is still a string field — lexicographic ranges stay off.
  // @ts-expect-error
  await db.movies.findMany({ where: { power: { gte: "7" } } });

  // the derived field is a real number field, so a string bound is a type error.
  // @ts-expect-error
  await db.movies.findMany({ where: { power_num: { gte: "7" } } });
}

void valid;
void invalid;
`,
    );
  });
});
