import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { brotliCompressSync, constants as zlibConstants, gzipSync } from "node:zlib";
import { resolveConfig } from "./config.js";
import { generateClientTs, generateSchemaTs } from "./codegen.js";
import { deriveRecord, derivedFieldsOf } from "./derive.js";
import { SchemaDriftChecker } from "./drift.js";
import { contentHash } from "./hash.js";
import { iterateInputRecords } from "./input.js";
import { buildManifest, SortFieldTracker } from "./manifest.js";
import { FieldIndexer, meanPostingsLength } from "./secondary-index.js";
import { BlockCutter, blockRelPath, HASH_PREFIX_THRESHOLD } from "./block.js";
import type { BlockFile } from "./block.js";
import { ExternalSorter, type SortKind } from "./sort.js";
import type { OnProgress } from "./progress.js";
import type { BuiltIndexChunk } from "./secondary-index.js";
import { compressionSuffix, type Compression } from "./types.js";
import type { BlockDescriptor, IndexChunkDirEntry, Manifest, PairZonemapEntry, ResolvedConfig, ZonemapDbConfig } from "./types.js";
import { getFormatVersion, getGeneratorVersion } from "./version.js";
import {
  brotliHostSupportWarning,
  lowCardinalitySortFieldWarning,
  oversizedRecordWarning,
  skewedBlocksWarning,
  unselectiveIndexWarning,
  unselectiveTextIndexWarning,
} from "./warnings.js";
import { spillOversizedZonemaps } from "./zonemap-budget.js";

/**
 * Brotli quality for build-time compression. Not the default 11: measured on 40 MB of real JSON, q11
 * took 31s for 14.4x while q5 took 247ms for 11.8x — the same wall-clock as gzip, which manages 7.65x.
 * q11 would add minutes to every build for a further ~15%, on files a CDN caches anyway.
 */
const BROTLI_QUALITY = 5;

/** Applies the deploy's build-time compression to one file's bytes. */
function compressServedFile(content: string, compression: Compression): string | Buffer {
  if (compression === "gzip") return gzipSync(content);
  if (compression === "brotli") {
    return brotliCompressSync(Buffer.from(content, "utf8"), {
      params: { [zlibConstants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY },
    });
  }
  return content;
}

/** Records buffered per sorted run before `ExternalSorter` spills to disk (ADR-0002 §9) — tunable per-call for tests, not part of the persisted config (an execution concern, not a design decision). */
const DEFAULT_SORT_RUN_RECORDS = 200_000;

export interface MaterializeOptions {
  generatorVersion?: string;
  formatVersion?: number;
  /** Records buffered per sorted run before the global sort spills to disk. Default 200,000. */
  sortRunRecords?: number;
  /** Scratch directory the external sort may use when spilling. Default `os.tmpdir()`. */
  tmpDir?: string;
  /** Phase-level progress for long builds. Purely observational — never changes what's produced. */
  onProgress?: OnProgress;
}

/**
 * Where `materialize` hands each file as soon as it exists, so nothing has to be held until the end:
 * `build` writes to disk, `inspect --config` keeps only what it reports on. Every `content` is
 * LOGICAL (uncompressed) — compression is the sink's business.
 */
export interface BuildSink {
  /** A closed block, in ordinal order. */
  block(file: BlockFile): void;
  /** Every other content-hashed file the manifest points at, at its final path: index chunk directories and, past the manifest budget, spilled zonemap sidecars (ADR-0003 §3). */
  file(relPath: string, content: string): void;
}

export interface MaterializeResult {
  manifest: Manifest;
  /** Loud, non-fatal build-time warnings (e.g. a `contains` trigram index bigger than its column, ADR-0003 §7). */
  warnings: string[];
  /** Whole-dataset facts gathered on the way through, for `inspect --config` to report without a second pass. */
  stats: {
    maxRecordBytes: number;
    sortFieldCardinality: number;
    /** Per `contains` field: its raw column's bytes. */
    columnBytes: Record<string, number>;
  };
}

/**
 * The build pipeline, minus deciding where files go: records → derive + drift-check → global sort by
 * the sort field → cut into byte-target blocks → zonemaps + lazy indexes → manifest. `build` gives it
 * a sink that writes to disk; `inspect --config` (T11) one that only measures.
 *
 * It streams end to end (#28). Each record is derived, drift-checked and handed to the external sort
 * as it's read; the sort's merge feeds the block cutter; each closed block goes to the sink and to
 * small accumulators (split-points, zonemap pairs, value → block postings) and is then dropped. So
 * memory peaks at one sort run plus one block plus the index dictionaries — which grow with distinct
 * values, not records. The sort spills to OS-tmpdir scratch files, removed before returning.
 *
 * Drift is reported once the input has been read, before any block reaches the sink.
 */
export function materialize(
  resolved: ResolvedConfig,
  source: Iterable<Record<string, unknown>>,
  sink: BuildSink,
  opts: MaterializeOptions = {},
): MaterializeResult {
  const generatorVersion = opts.generatorVersion ?? getGeneratorVersion();
  const formatVersion = opts.formatVersion ?? getFormatVersion();
  const sortField = resolved.sortField;
  const progress = opts.onProgress;

  const indexedSecondaryFields = Object.entries(resolved.fields).filter(
    ([name, field]) => name !== sortField && field.indexed === true,
  );

  const blocks: BlockDescriptor[] = [];
  const sortTracker = new SortFieldTracker(sortField);
  const indexers = indexedSecondaryFields.map(([name, field]) => new FieldIndexer(name, field));
  let maxRecordBytes = 0;

  const sorter = new ExternalSorter({
    sortField,
    kind: resolved.fields[sortField]!.kind as SortKind,
    pk: resolved.pk,
    runRecords: opts.sortRunRecords ?? DEFAULT_SORT_RUN_RECORDS,
    tmpDir: opts.tmpDir ?? os.tmpdir(),
  });
  try {
    // Read → derive → drift-check → sort run. A derived column has to exist by the time drift checks
    // it, the sort reads it, and the indexers see it (ADR-0009); doing it here means `build` and
    // `inspect --config` derive identically.
    const derived = derivedFieldsOf(resolved.fields);
    const drift = new SchemaDriftChecker(resolved.fields);
    for (const record of source) {
      if (derived.length > 0) deriveRecord(record, derived);
      drift.check(record);
      sorter.add(record);
    }
    drift.finish();

    // Merge → cut → sink + accumulators, one block at a time.
    const recordCount = sorter.size;
    let recordsDone = 0;
    progress?.({ phase: `sorting by ${sortField}`, done: recordCount, unit: "count" });
    const cutter = new BlockCutter(sortField, resolved.blockBytes, ({ file, records }) => {
      const ordinal = blocks.length;
      blocks.push({ hash: file.hash, bytes: file.bytes, count: file.count });
      sink.block(file);
      sortTracker.addBlock(ordinal, records);
      for (const indexer of indexers) indexer.addBlock(ordinal, records);
      recordsDone += file.count;
      progress?.({ phase: "writing data files", done: recordsDone, total: recordCount, unit: "count" });
    });
    for (const { record, line } of sorter.sorted()) {
      cutter.add(record, line);
      maxRecordBytes = Math.max(maxRecordBytes, Buffer.byteLength(line, "utf8"));
    }
    cutter.finish();
  } finally {
    sorter.close();
  }

  const secondaryZonemaps: Record<string, PairZonemapEntry> = {};
  const indexChunkDirs: Record<string, IndexChunkDirEntry[]> = {};
  const reversedChunkDirs: Record<string, IndexChunkDirEntry[]> = {};
  const trigramChunkDirs: Record<string, IndexChunkDirEntry[]> = {};
  const emptyBlocks: Record<string, number[]> = {};
  const columnBytesByField: Record<string, number> = {};
  const warnings: string[] = [];

  // Under `gzip`, every manifest-referenced JSON file is written compressed and its path carries the
  // `.gz` suffix. The path IS the signal the client routes on (`fetchReferencedJson`), so there is no
  // flag to keep in sync and a tree mixing compressed and plain files still reads correctly.
  const servedSuffix = compressionSuffix(resolved.compression);

  const addIndexChunks = (field: string, subdir: string | null, builtChunks: BuiltIndexChunk[]): IndexChunkDirEntry[] =>
    builtChunks.map(({ from, to, content }) => {
      // Hash over the uncompressed content, exactly as blocks do: toggling gzip between rebuilds must
      // not perturb filenames or the manifest structures keyed on them (ADR-0002 §8).
      const hash = contentHash(content);
      const base = subdir ? `index/${field}/${subdir}/${hash}` : `index/${field}/${hash}`;
      const relPath = `${base}.json${servedSuffix}`;
      sink.file(relPath, content);
      return { from, to, file: relPath };
    });

  indexers.forEach((indexer, fieldsIndexed) => {
    const name = indexedSecondaryFields[fieldsIndexed]![0];
    // Per-field rather than a single "indexing" phase: chunking a big dictionary takes a while, and
    // which field it's on is the useful detail (a `contains` trigram field is the slow one).
    progress?.({ phase: `indexing ${name}`, done: fieldsIndexed, total: indexers.length, unit: "count" });
    const built = indexer.finish(resolved.indexChunkBytes);
    secondaryZonemaps[name] = built.zonemap;
    if (built.emptyBlocks) emptyBlocks[name] = built.emptyBlocks;
    indexChunkDirs[name] = addIndexChunks(name, null, built.chunks);
    // A list field can't be unindexed (ADR-0010), so there's no cheaper alternative to suggest.
    if (resolved.fields[name]!.multi !== true) {
      const field = resolved.fields[name]!;
      const textOptIns = (["endsWith", "contains"] as const).filter((op) => field[op] === true);
      const unselectiveIndex = unselectiveIndexWarning(name, meanPostingsLength(built.chunks), blocks.length, textOptIns);
      if (unselectiveIndex) warnings.push(unselectiveIndex);
    }

    if (built.reversedChunks) {
      reversedChunkDirs[name] = addIndexChunks(name, "reversed", built.reversedChunks);
      const unselective = unselectiveTextIndexWarning(name, "endsWith", meanPostingsLength(built.reversedChunks), blocks.length);
      if (unselective) warnings.push(unselective);
    }

    if (built.trigramChunks) {
      trigramChunkDirs[name] = addIndexChunks(name, "trigram", built.trigramChunks);
      const unselective = unselectiveTextIndexWarning(name, "contains", meanPostingsLength(built.trigramChunks), blocks.length);
      if (unselective) warnings.push(unselective);

      const trigramBytes = built.trigramChunks.reduce((sum, c) => sum + Buffer.byteLength(c.content, "utf8"), 0);
      const columnBytes = built.columnBytes!;
      columnBytesByField[name] = columnBytes;
      if (trigramBytes > columnBytes) {
        warnings.push(
          `zonemapdb: contains(${name}): trigram index (${trigramBytes} bytes) is bigger than the data — ` +
            `the raw "${name}" column is only ${columnBytes} bytes. This is the single biggest build-output cost; ` +
            `consider disabling contains for this field.`,
        );
      }
    }
  });

  progress?.({ phase: "building manifest", done: indexers.length, total: indexers.length, unit: "count" });
  const rawManifest = buildManifest({
    config: resolved,
    blockFiles: blocks,
    splitPoints: sortTracker.splitPoints(),
    missing: sortTracker.missingTail(),
    secondaryZonemaps,
    indexChunkDirs,
    reversedChunkDirs,
    trigramChunkDirs,
    emptyBlocks,
    formatVersion,
    generatorVersion,
  });

  // Root-manifest budget (ADR-0003 §3): spill the largest secondary zonemaps to per-field
  // sidecars, largest first, until the gzipped root is back under budget.
  const { manifest, sidecarFiles, warning: budgetWarning } = spillOversizedZonemaps(rawManifest, servedSuffix);
  for (const { relPath, content } of sidecarFiles) sink.file(relPath, content);
  if (budgetWarning) warnings.push(budgetWarning);

  const oversizedWarning = oversizedRecordWarning(maxRecordBytes, resolved.blockBytes);
  if (oversizedWarning) warnings.push(oversizedWarning);

  const skewWarning = skewedBlocksWarning(blocks);
  if (skewWarning) warnings.push(skewWarning);

  const cardinalityWarning = lowCardinalitySortFieldWarning(manifest.dataset.recordCount, sortTracker.cardinality());
  if (cardinalityWarning) warnings.push(cardinalityWarning);

  const brotliWarning = brotliHostSupportWarning(resolved.compression);
  if (brotliWarning) warnings.push(brotliWarning);

  return {
    manifest,
    warnings,
    stats: { maxRecordBytes, sortFieldCardinality: sortTracker.cardinality(), columnBytes: columnBytesByField },
  };
}

export interface BuildOptions {
  /** Directory config-relative paths (input/output/clientOut) are resolved against. */
  baseDir: string;
  generatorVersion?: string;
  formatVersion?: number;
  /** Records buffered per sorted run before the global sort spills to disk. Default 200,000. */
  sortRunRecords?: number;
  /** Scratch directory the external sort may use when spilling. Default `os.tmpdir()`. */
  tmpDir?: string;
  /** Phase-level progress for long builds. Purely observational — never changes what's produced. */
  onProgress?: OnProgress;
}

export interface BuildResult {
  manifest: Manifest;
  outputDir: string;
  clientOutDir: string;
  /** Loud, non-fatal build-time warnings (e.g. a `contains` trigram index bigger than its column, ADR-0003 §7). */
  warnings: string[];
}

/**
 * Reads config's input and streams it through `materialize` into a staging directory beside
 * `output`: blocks and index chunks are written as they're produced, then the manifest. Only a
 * finished tree replaces `output`, so a build that fails part-way — drift, bad input, a full disk —
 * leaves the previous build in place. Then generates the client (schema.ts + client.ts).
 */
export function build(config: ZonemapDbConfig, opts: BuildOptions): BuildResult {
  const resolved = resolveConfig(config, opts.baseDir);
  const generatorVersion = opts.generatorVersion ?? getGeneratorVersion();
  const progress = opts.onProgress;
  const compression = resolved.compression;

  const records = iterateInputRecords(resolved.inputPath, {
    format: resolved.inputFormat,
    delimiter: resolved.inputDelimiter,
    recordsPath: resolved.inputRecordsPath,
    fields: resolved.fields,
    ...(progress ? { onProgress: progress } : {}),
  });

  const staging = path.join(path.dirname(resolved.output), `.${path.basename(resolved.output)}.zonemapdb-partial`);
  rmSync(staging, { recursive: true, force: true });
  let manifest: Manifest;
  let warnings: string[];
  try {
    mkdirSync(staging, { recursive: true });
    const writeServed = (relPath: string, content: string) => {
      const filePath = path.join(staging, relPath);
      mkdirSync(path.dirname(filePath), { recursive: true });
      // Compression is a transport concern applied only at write time — every content-hash stays
      // over the LOGICAL uncompressed bytes, so toggling compression between rebuilds never perturbs
      // file names or the manifest/index structures keyed on them.
      writeFileSync(filePath, compressServedFile(content, compression));
    };

    // A block's final path depends on the total block count (hash-prefix subdirectories past
    // `HASH_PREFIX_THRESHOLD`), which isn't known until the last block closes — so blocks land flat
    // and move afterwards if needed.
    ({ manifest, warnings } = materialize(
      resolved,
      records,
      {
        block: (file) => writeServed(blockRelPath(file.hash, 0, compression), file.content),
        file: writeServed,
      },
      {
        generatorVersion,
        formatVersion: opts.formatVersion,
        sortRunRecords: opts.sortRunRecords,
        tmpDir: opts.tmpDir,
        ...(progress ? { onProgress: progress } : {}),
      },
    ));

    const blockCount = manifest.blocks.length;
    if (blockCount > HASH_PREFIX_THRESHOLD) {
      for (const { hash } of manifest.blocks) {
        const to = path.join(staging, blockRelPath(hash, blockCount, compression));
        mkdirSync(path.dirname(to), { recursive: true });
        renameSync(path.join(staging, blockRelPath(hash, 0, compression)), to);
      }
    }

    // Minified, not pretty-printed: every client downloads this file before it can run a query, and
    // the ADR-0003 §3 budget is measured on gzip(minified) — so indentation would be bytes the budget
    // never accounted for (~2.2x the file on a real dataset). `curl | jq` reads minified JSON fine.
    //
    // Under compression it also ships pre-compressed. The name changes rather than the encoding alone,
    // so a stale plain `manifest.json` left in an output directory can never be silently served as if
    // it were current — and the generated client below is stamped with which one to fetch.
    writeServed(`manifest.json${compressionSuffix(compression)}`, JSON.stringify(manifest));
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }

  rmSync(resolved.output, { recursive: true, force: true });
  renameSync(staging, resolved.output);

  progress?.({ phase: "generating client", done: 1, total: 1, unit: "count" });
  mkdirSync(resolved.clientOut, { recursive: true });
  writeFileSync(path.join(resolved.clientOut, "schema.ts"), generateSchemaTs(manifest, generatorVersion));
  writeFileSync(
    path.join(resolved.clientOut, "client.ts"),
    generateClientTs(manifest, {
      basePath: resolved.basePath,
      generatorVersion,
      ...(compression !== "none" ? { manifestCompression: compression } : {}),
    }),
  );

  return { manifest, outputDir: resolved.output, clientOutDir: resolved.clientOut, warnings };
}
