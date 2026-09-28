import type { ValueShape } from "./infer.js";
import type { BlockDescriptor, Compression } from "./types.js";

/** Heuristic average sort-value run length past which a sort field counts as "low cardinality" (ADR-0002 §6) — scale-free, so it works identically whether cardinality came from raw records or block-boundary split-points. Not a hard rule: `cutIntoBlocks` caps real `blockCount` at cardinality (equal-key runs never split), so this can't be phrased as "fewer distinct values than blocks". */
const LOW_CARDINALITY_AVG_RUN_LENGTH = 20;

/** ADR-0002 §6: a low-cardinality sort field blocks unevenly (every block becomes a single-key pileup). */
export function lowCardinalitySortFieldWarning(recordCount: number, sortFieldCardinality: number): string | undefined {
  if (sortFieldCardinality === 0 || recordCount < LOW_CARDINALITY_AVG_RUN_LENGTH) return undefined;
  const avgRunLength = recordCount / sortFieldCardinality;
  if (avgRunLength <= LOW_CARDINALITY_AVG_RUN_LENGTH) return undefined;
  return `zonemapdb: the sort field has only ${sortFieldCardinality} distinct value(s) across ${recordCount} records (~${Math.round(avgRunLength)} per value) — low-cardinality sort fields block unevenly (equal-key runs stay contiguous, ADR-0002 §6).`;
}

/**
 * Above this share of all blocks, an average lookup on the structure is fetching so much of the
 * dataset that the index isn't buying pruning — it's paying for itself twice (build output plus a
 * chunk fetch) to arrive at "read most of the files anyway".
 */
export const UNSELECTIVE_POSTINGS_RATIO = 0.35;
/** Below this block count the ratio is degenerate (a 1-block build is trivially "100% of blocks"), so stay quiet. */
export const MIN_BLOCKS_FOR_SELECTIVITY = 8;

/**
 * ADR-0003 §7: `endsWith`/`contains` are per-field opt-ins whose whole justification is pruning. A
 * structure whose average entry resolves to most of the blocks fails that justification — the
 * `id`/`uri`/`object` shape, where values are identifiers, URLs, or near-constant and their
 * substrings are spread uniformly across the dataset. Distinct from the "bigger than the data"
 * warning, which is about build-output size: an index can be small and still useless, or large and
 * worth it.
 */
export function unselectiveTextIndexWarning(
  field: string,
  operator: "endsWith" | "contains",
  meanPostings: number | undefined,
  blockCount: number,
): string | undefined {
  if (meanPostings === undefined || blockCount < MIN_BLOCKS_FOR_SELECTIVITY) return undefined;
  const ratio = meanPostings / blockCount;
  if (ratio <= UNSELECTIVE_POSTINGS_RATIO) return undefined;
  return (
    `zonemapdb: ${operator}(${field}): this index barely prunes — the average lookup resolves to ` +
    `${Math.round(meanPostings)} of ${blockCount} data files (${Math.round(ratio * 100)}%), so a query using it ` +
    `still reads most of the dataset. Typical of identifier, URL, or near-constant fields, whose substrings ` +
    `are spread evenly across every file. equals/in/startsWith on "${field}" use its plain index and don't need ` +
    `this one — consider turning ${operator} off.`
  );
}

/**
 * The same measurement for a field's plain index (ADR-0013). Since an unindexed field is still
 * queryable — its filters ride on a pruning constraint — an index that doesn't prune is pure cost:
 * build output, manifest bytes, and a chunk fetch per query. The house-number shape: sorted by street,
 * every common number sits in nearly every block.
 */
export function unselectiveIndexWarning(
  field: string,
  meanPostings: number | undefined,
  blockCount: number,
  textOptIns: readonly ("endsWith" | "contains")[] = [],
): string | undefined {
  if (meanPostings === undefined || blockCount < MIN_BLOCKS_FOR_SELECTIVITY) return undefined;
  const ratio = meanPostings / blockCount;
  if (ratio <= UNSELECTIVE_POSTINGS_RATIO) return undefined;
  // The text indexes are built on top of the plain one, so removing it means removing them too.
  const alongWith = textOptIns.length === 0 ? "" : ` (and its ${textOptIns.map((op) => `"${op}"`).join(" and ")}, which need${textOptIns.length === 1 ? "s" : ""} the index)`;
  return (
    `zonemapdb: index(${field}): this index barely prunes — the average value appears in ` +
    `${Math.round(meanPostings)} of ${blockCount} data files (${Math.round(ratio * 100)}%). Consider removing ` +
    `"indexed": true${alongWith}: "${field}" stays filterable as a rider next to a filter that prunes, and the build ` +
    `drops this index's files.`
  );
}

/**
 * Why `init` left a field unindexed that it would once have recommended (#31): sorted the way the
 * config sorts, the field's values sit in most data files, so its index would be the kind the build
 * warns "barely prunes". Says what indexing it would still buy — a field filtered on by itself needs a
 * pruning constraint, and an index is one even when it prunes badly.
 */
export function skippedIndexNote(field: string, sortField: string, blockShare: number): string {
  return (
    `zonemapdb: init left "${field}" unindexed — sorted by "${sortField}", its average value would sit in about ` +
    `${Math.round(blockShare * 100)}% of the data files, so an index wouldn't narrow the read. It stays filterable ` +
    `as a rider next to a filter that prunes. Add "indexed": true if you need to filter on "${field}" by itself.`
  );
}

/**
 * Warns about a text index whose field's values cannot support it, judged from their SHAPE rather than
 * from the field's name. This fires at choice time — before a build exists — and complements
 * `unselectiveTextIndexWarning`, which measures the built structure and so can only report afterwards.
 *
 * `endsWith` on URLs is the clearest case: they end either in an opaque id or in a suffix every record
 * shares (`?utm_source=api` across an entire real dataset), so the reversed index cannot discriminate.
 * Hex identifiers have no meaningful substrings in either direction.
 */
export function unsuitableTextIndexWarning(
  field: string,
  operator: "endsWith" | "contains",
  shape: ValueShape,
): string | undefined {
  if (shape === "uuid") {
    return (
      `zonemapdb: ${operator}(${field}): the values are identifiers (hex UUIDs), which have no meaningful ` +
      `substrings — this index can't answer a question anyone asks. Use equals/in, which are already free.`
    );
  }
  if (shape === "url") {
    if (operator === "endsWith") {
      return (
        `zonemapdb: endsWith(${field}): the values are URLs, which end either in an opaque id or in a ` +
        `suffix every record shares — so a reversed index can't discriminate between them. This is usually ` +
        `pure build output for no query.`
      );
    }
    return (
      `zonemapdb: contains(${field}): the values are URLs. Substring-searching them is rarely what an app ` +
      `needs, and a trigram index over URLs is one of the largest structures a build can produce — check you ` +
      `really want it.`
    );
  }
  return undefined;
}

/** ADR-0002 §5: a record bigger than the block-byte target gets its own oversized, flagged block. */
export function oversizedRecordWarning(maxRecordBytes: number, blockBytes: number): string | undefined {
  if (maxRecordBytes <= blockBytes) return undefined;
  return `zonemapdb: the largest record is ${maxRecordBytes} bytes, over the ${blockBytes}-byte block target — it will get its own oversized, flagged block (ADR-0002 §5).`;
}

/** ADR-0002 §6: a single sort value's equal-key run pileup produces an oversized block relative to the target. */
export function skewedBlocksWarning(blocks: BlockDescriptor[]): string | undefined {
  if (blocks.length === 0) return undefined;
  const totalBytes = blocks.reduce((sum, s) => sum + s.bytes, 0);
  const meanBytes = totalBytes / blocks.length;
  if (meanBytes <= 0) return undefined;
  const oversized = blocks.filter((s) => s.bytes > meanBytes * 2);
  if (oversized.length === 0) return undefined;
  return `zonemapdb: ${oversized.length} block(s) are more than 2x the mean block size (${Math.round(meanBytes)} bytes) — likely an equal-key pileup on the sort field or an oversized record (ADR-0002 §5/§6).`;
}

/**
 * `compression: "brotli"` only works where the host decodes the `.br` files at the transport layer
 * (`Content-Encoding: br`). A host that serves raw bytes (GitHub Pages, plain object-storage buckets)
 * leaves decoding to `DecompressionStream("brotli")`, which Chrome does not ship yet, so the deploy
 * fails there with CORRUPT_DATA. The build can't see the host, so this warns on every brotli build.
 */
export function brotliHostSupportWarning(compression: Compression): string | undefined {
  if (compression !== "brotli") return undefined;
  return `zonemapdb: compression "brotli" needs a host that serves .br files with Content-Encoding: br. On raw-bytes hosts (GitHub Pages, plain object storage) Chrome can't decode them yet, because it doesn't support DecompressionStream("brotli"); use "gzip" there. See docs/deploy-guide.md.`;
}
