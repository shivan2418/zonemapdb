import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { brotliDecompressSync, gunzipSync, gzipSync } from "node:zlib";
import { materialize } from "./build.js";
import { loadConfigFile, resolveConfig } from "./config.js";
import {
  MANIFEST_BUDGET_BYTES,
  estimateEqualityQueryCost,
  estimateRangeQueryCost,
  type IndexSizeEstimate,
  type QueryCostEstimate,
} from "./estimator.js";
import { iterateInputRecords } from "./input.js";
import { valuesOf } from "./secondary-index.js";
import { blockRelPath } from "./block.js";
import type { IndexChunkDirEntry, Manifest } from "./types.js";
import { lowCardinalitySortFieldWarning, oversizedRecordWarning, skewedBlocksWarning } from "./warnings.js";

export interface InspectOptions {
  /** Absolute path to a `zonemapdb.config.json` — materializes the served tree in memory from the (unbuilt) input and reports it exactly, without ever writing `output`. */
  configPath?: string;
  /** Absolute path to a built `output` directory — reports the real artifacts already on disk, no rebuild. */
  dir?: string;
}

export interface BlockSizeDistribution {
  count: number;
  totalBytes: number;
  minBytes: number;
  maxBytes: number;
  meanBytes: number;
}

export interface InspectReport {
  /** `"config"`: materialized in memory from the (unbuilt) input. `"dir"`: read from real build output on disk. Both report exact, not estimated, numbers (ADR-0003's "exact re-report", as distinct from the wizard's sampled live estimate). */
  mode: "config" | "dir";
  collection: string;
  recordCount: number;
  blockCount: number;
  blocks: BlockSizeDistribution;
  manifestBytes: number;
  manifestGzipBytes: number;
  manifestOverBudget: boolean;
  /** One entry per indexed non-sort field. */
  indexes: Record<string, IndexSizeEstimate>;
  perQuery: {
    equality?: QueryCostEstimate;
    range: QueryCostEstimate;
  };
  warnings: string[];
}

function blockSizeDistribution(blockBytes: number[]): BlockSizeDistribution {
  if (blockBytes.length === 0) return { count: 0, totalBytes: 0, minBytes: 0, maxBytes: 0, meanBytes: 0 };
  const totalBytes = blockBytes.reduce((sum, b) => sum + b, 0);
  return {
    count: blockBytes.length,
    totalBytes,
    minBytes: Math.min(...blockBytes),
    maxBytes: Math.max(...blockBytes),
    meanBytes: totalBytes / blockBytes.length,
  };
}

/** Sums one index's chunk files' real bytes and dictionary-entry count (= exact cardinality) via `readChunk`. */
function readChunkStats(chunks: IndexChunkDirEntry[], readChunk: (relPath: string) => string): { bytes: number; entryCount: number } {
  let bytes = 0;
  let entryCount = 0;
  for (const chunk of chunks) {
    const content = readChunk(chunk.file);
    bytes += Buffer.byteLength(content, "utf8");
    entryCount += (JSON.parse(content) as { entries: unknown[] }).entries.length;
  }
  return { bytes, entryCount };
}

interface StructuralReport {
  blocks: BlockSizeDistribution;
  manifestBytes: number;
  manifestGzipBytes: number;
  manifestOverBudget: boolean;
  indexes: Record<string, IndexSizeEstimate>;
  perQuery: InspectReport["perQuery"];
  warnings: string[];
}

/**
 * The report structure both modes share: given a manifest, its exact serialized JSON (as `build`
 * would write it), a way to fetch an index chunk's content (disk in `--dir`, in-memory in
 * `--config`), and a way to measure one field's raw column bytes — produces exact block/manifest/
 * index sizes and reuses the estimator's representative per-query-cost formulas fed with real
 * cardinality, so a formula change only has one place to land.
 */
function buildStructuralReport(opts: {
  manifest: Manifest;
  manifestJson: string;
  readChunk: (relPath: string) => string;
  columnBytesFor: (field: string, multi: boolean) => number;
}): StructuralReport {
  const { manifest, manifestJson, readChunk, columnBytesFor } = opts;

  const manifestBytes = Buffer.byteLength(manifestJson, "utf8");
  const manifestGzipBytes = gzipSync(manifestJson).length;
  const manifestOverBudget = manifestGzipBytes > MANIFEST_BUDGET_BYTES;

  const blocks = blockSizeDistribution(manifest.blocks.map((s) => s.bytes));

  const indexes: Record<string, IndexSizeEstimate> = {};
  const cardinalityByField: Record<string, number> = {};
  const warnings: string[] = [];

  for (const [name, descriptor] of Object.entries(manifest.indexes)) {
    const base = readChunkStats(descriptor.chunks, readChunk);
    cardinalityByField[name] = base.entryCount;
    const report: IndexSizeEstimate = { baseBytes: base.bytes, baseChunks: descriptor.chunks.length };

    if (descriptor.reversed) {
      const reversed = readChunkStats(descriptor.reversed.chunks, readChunk);
      report.reversedBytes = reversed.bytes;
      report.reversedChunks = descriptor.reversed.chunks.length;
    }
    if (descriptor.trigram) {
      const trigram = readChunkStats(descriptor.trigram.chunks, readChunk);
      report.trigramBytes = trigram.bytes;
      report.trigramChunks = descriptor.trigram.chunks.length;

      const multi = manifest.schema.fields[name]?.multi === true;
      const columnBytes = columnBytesFor(name, multi);
      report.containsExceedsColumn = trigram.bytes > columnBytes;
      if (report.containsExceedsColumn) {
        warnings.push(
          `zonemapdb: contains(${name}): the trigram index (${trigram.bytes} bytes) is bigger than the raw "${name}" column (${columnBytes} bytes) — the single biggest build-output cost; consider disabling contains for this field.`,
        );
      }
    }

    indexes[name] = report;
  }

  if (manifestOverBudget) {
    warnings.push(
      `zonemapdb: root manifest is ${manifestGzipBytes} gzipped bytes, over the ~${MANIFEST_BUDGET_BYTES} budget even after spilling every secondary zonemap to a sidecar (ADR-0003 §3) — consider fewer indexed fields.`,
    );
  }
  const skewWarning = skewedBlocksWarning(manifest.blocks);
  if (skewWarning) warnings.push(skewWarning);

  const equalityField = Object.entries(cardinalityByField)[0];
  const perQuery: InspectReport["perQuery"] = {
    range: estimateRangeQueryCost(manifest.blocks.length, blocks.meanBytes || manifest.blocks[0]?.bytes || 0),
  };
  if (equalityField) {
    const [name, cardinality] = equalityField;
    const idx = indexes[name]!;
    const avgChunkBytes = idx.baseChunks > 0 ? idx.baseBytes / idx.baseChunks : idx.baseBytes;
    perQuery.equality = estimateEqualityQueryCost(
      cardinality,
      manifest.dataset.recordCount,
      manifest.blocks.length,
      blocks.meanBytes,
      avgChunkBytes,
    );
  }

  return { blocks, manifestBytes, manifestGzipBytes, manifestOverBudget, indexes, perQuery, warnings };
}

function inspectConfig(configPath: string): InspectReport {
  const config = loadConfigFile(configPath);
  const resolved = resolveConfig(config, path.dirname(configPath));

  const records = iterateInputRecords(resolved.inputPath, {
    format: resolved.inputFormat,
    delimiter: resolved.inputDelimiter,
    recordsPath: resolved.inputRecordsPath,
    fields: resolved.fields,
  });

  // Streams like `build`, but keeps only the index files this report reads back — never the blocks.
  const chunkContent = new Map<string, string>();
  const { manifest, stats } = materialize(resolved, records, {
    block: () => {},
    file: (relPath, content) => chunkContent.set(relPath, content),
  });
  const manifestJson = JSON.stringify(manifest); // same serialization `build` writes to disk (build.ts)

  const readChunk = (relPath: string): string => {
    const content = chunkContent.get(relPath);
    if (content === undefined) throw new Error(`zonemapdb: inspect — missing in-memory index chunk "${relPath}"`);
    return content;
  };
  const columnBytesFor = (field: string): number => {
    const bytes = stats.columnBytes[field];
    if (bytes === undefined) throw new Error(`zonemapdb: inspect — no column size measured for "${field}"`);
    return bytes;
  };

  const structural = buildStructuralReport({ manifest, manifestJson, readChunk, columnBytesFor });

  const warnings = [...structural.warnings];
  const cardinalityWarning = lowCardinalitySortFieldWarning(manifest.dataset.recordCount, stats.sortFieldCardinality);
  if (cardinalityWarning) warnings.push(cardinalityWarning);

  const oversizedWarning = oversizedRecordWarning(stats.maxRecordBytes, resolved.blockBytes);
  if (oversizedWarning) warnings.push(oversizedWarning);

  return {
    mode: "config",
    collection: manifest.dataset.collection,
    recordCount: manifest.dataset.recordCount,
    blockCount: manifest.dataset.blockCount,
    ...structural,
    warnings,
  };
}

/**
 * Reads a built file back to its LOGICAL text, decompressing when the deploy pre-gzipped it
 * (ADR-0002 §8). Every size this report quotes is logical, for two reasons: `containsExceedsColumn`
 * compares an index against its own raw column, and `inspect --config` must agree byte-for-byte with
 * `inspect --dir` (it only ever sees uncompressed content). Quoting compressed bytes would silently
 * break both.
 */
function readLogicalText(filePath: string): string {
  if (filePath.endsWith(".gz")) return gunzipSync(readFileSync(filePath)).toString("utf8");
  if (filePath.endsWith(".br")) return brotliDecompressSync(readFileSync(filePath)).toString("utf8");
  return readFileSync(filePath, "utf8");
}

function inspectDir(dir: string): InspectReport {
  // A gzipped build ships `manifest.json.gz` instead — the name changes, not just the encoding.
  const manifestPath = ["manifest.json", "manifest.json.gz", "manifest.json.br"]
    .map((name) => path.join(dir, name))
    .find((candidate) => existsSync(candidate));
  if (manifestPath === undefined) {
    throw new Error(`zonemapdb: inspect --dir "${dir}" has no manifest.json — has it been built yet?`);
  }
  const manifestJson = readLogicalText(manifestPath);
  const manifest = JSON.parse(manifestJson) as Manifest;

  const readChunk = (relPath: string): string => readLogicalText(path.join(dir, relPath));
  const columnBytesFor = (field: string, multi: boolean): number => {
    let bytes = 0;
    for (const block of manifest.blocks) {
      const blockPath = path.join(dir, blockRelPath(block.hash, manifest.blocks.length, manifest.dataset.compression ?? "none"));
      const content = readLogicalText(blockPath);
      for (const line of content.split("\n")) {
        if (line.length === 0) continue;
        const record = JSON.parse(line) as Record<string, unknown>;
        for (const value of valuesOf(record, field, multi)) {
          if (typeof value === "string") bytes += Buffer.byteLength(value, "utf8");
        }
      }
    }
    return bytes;
  };

  const structural = buildStructuralReport({ manifest, manifestJson, readChunk, columnBytesFor });

  // No low-cardinality-sort-field warning here: the manifest doesn't carry the sort field's true
  // distinct-value count, and split-points can't substitute — each block's min split-point is
  // necessarily unique by construction (equal-key runs stay in one block), so counting distinct
  // split-points always just equals blockCount, undercounting whenever several values pack into
  // one block. `inspect --config` has the raw records and can compute this exactly instead.
  const warnings = [...structural.warnings];
  const singleRecordOutlier = manifest.blocks.find(
    (s) => s.count === 1 && structural.blocks.meanBytes > 0 && s.bytes > structural.blocks.meanBytes * 1.5,
  );
  if (singleRecordOutlier) {
    warnings.push(
      `zonemapdb: block "${singleRecordOutlier.hash}" holds a single record at ${singleRecordOutlier.bytes} bytes, well over the mean — likely the oversized-record case (ADR-0002 §5).`,
    );
  }

  return {
    mode: "dir",
    collection: manifest.dataset.collection,
    recordCount: manifest.dataset.recordCount,
    blockCount: manifest.dataset.blockCount,
    ...structural,
    warnings,
  };
}

/**
 * Read-only cost/health report over a config (materialized in memory from the unbuilt input) or a
 * built `output` directory (the real artifacts) — never rebuilds/writes (ADR-0005 §4).
 */
export function inspect(opts: InspectOptions): InspectReport {
  if (opts.configPath !== undefined && opts.dir !== undefined) {
    throw new Error('zonemapdb: inspect accepts exactly one of "--config" or "--dir", not both');
  }
  if (opts.configPath !== undefined) return inspectConfig(opts.configPath);
  if (opts.dir !== undefined) return inspectDir(opts.dir);
  throw new Error('zonemapdb: inspect needs "--config <path>" or "--dir <path>"');
}
