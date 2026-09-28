import { ZonemapDbError } from "./errors.js";
import { compressionSuffix, decompressionFormat, type Compression } from "./types.js";
import { blockRelPath } from "./block-fetch.js";
import { fetchCompressedText, fetchJson, parseCorruptible } from "./fetch-file.js";
import { FORMAT_VERSION } from "./version.js";

export interface BlockDescriptor {
  hash: string;
  bytes: number;
  count: number;
}

export interface FieldSchemaEntry {
  kind: string;
  isDate: boolean;
  indexed: boolean;
  /** Everything a `where` may write on this field (ADR-0013). */
  operators: readonly string[];
  /** The subset of `operators` that narrows which blocks a query reads; the rest are riders. */
  pruning: readonly string[];
  /** The key may be missing from a record (absent ≠ null). */
  absent?: true;
  /** The value may be `null` (null ≠ absent). */
  nullable?: true;
  /** Scalar leaf under an object-array — value is an array, matched existentially via `some` (T7). */
  multi?: true;
  /** Present (`true`) only for the user PK field (T8). */
  pk?: true;
}

export interface SchemaDescriptor {
  collection: string;
  sortField: string;
  /** Names the user PK field, if declared (T8). */
  pk?: string;
  fields: Record<string, FieldSchemaEntry>;
}

/** Records with a null/absent sort-field value cluster in a contiguous tail at the high end (ADR-0002 §9). */
export interface MissingZonemapInfo {
  /** Ordinal of the earliest block containing any missing (null or absent) sort-field value. */
  blockFrom: number;
  /** Records with an explicit `null` sort-field value. */
  nullCount: number;
  /** Records whose sort-field key is absent entirely (not just null). */
  absentCount: number;
}

/** Sort field: N+1 monotonic split-points, binary-searchable (ADR-0003 §2). */
export interface SplitPointZonemapEntry {
  splitPoints: unknown[];
  /** Present iff at least one record had a null/absent sort-field value (ADR-0002 §9). */
  missing?: MissingZonemapInfo;
}

/** Secondary field: per-block [min,max] pairs, ordinal-aligned with `blocks[]` (ADR-0003 §2/§9). */
export interface PairZonemapEntry {
  pairs: [unknown, unknown][];
  truncated?: boolean;
}

/** A secondary field's zonemap moved out of root into a per-field sidecar file (ADR-0003 §3) — spilled when the root manifest would exceed the gzip budget. */
export interface SidecarZonemapEntry {
  sidecar: string;
}

export type ZonemapEntry = SplitPointZonemapEntry | PairZonemapEntry | SidecarZonemapEntry;

/** One index chunk's value-range coverage — routing metadata only (ADR-0003 §9). */
export interface IndexChunkDirEntry {
  from: unknown;
  to: unknown;
  file: string;
}

export interface IndexDescriptor {
  operators: readonly string[];
  chunks: IndexChunkDirEntry[];
  /** Reversed-value index chunk directory — present iff `endsWith` opted in (ADR-0003 §7/§9). */
  reversed?: { chunks: IndexChunkDirEntry[] };
  /** Trigram index chunk directory — present iff `contains` opted in (ADR-0003 §7/§9). */
  trigram?: { chunks: IndexChunkDirEntry[] };
  /**
   * Multi-valued fields only: ordinals of the blocks holding at least one present `[]` — what
   * `isEmpty` and `every` prune on (ADR-0010 §4/§5). Missing (a pre-ADR-0010 build) means unknown.
   */
  emptyBlocks?: number[];
}

export interface Manifest {
  formatVersion: number;
  generatorVersion: string;
  dataset: {
    collection: string;
    recordCount: number;
    blockCount: number;
    sortField: string;
    /** Present (`true`) only when block payloads are gzipped at build time (ADR-0002 §8) — omitted otherwise. */
    /**
     * How every served file was pre-compressed, when the build did so (ADR-0002 §8). Absent means
     * plain files. `gzip?: true` is the pre-`compression` spelling, still read so an older deploy keeps
     * working against a newer client.
     */
    compression?: Compression;
    /** @deprecated Superseded by `compression: "gzip"`. */
    gzip?: true;
  };
  schema: SchemaDescriptor;
  blocks: BlockDescriptor[];
  zonemap: Record<string, ZonemapEntry>;
  indexes: Record<string, IndexDescriptor>;
}

/**
 * Fetches the root manifest. `gzipped` says the deploy pre-compressed it (ADR-0002 §8) — unlike index
 * chunks and zonemap sidecars, whose `.gz` paths come FROM the manifest and so describe themselves,
 * this is the bootstrap fetch: nothing has been read yet that could tell the client the encoding. The
 * generated client carries the answer instead, stamped by the same `build` that wrote the file, so the
 * two cannot drift.
 *
 * `cache` defaults to `"no-cache"` (#32): the manifest is the one stable-named file, and a host that
 * caches everything for minutes (GitHub Pages sends `max-age=600`) would otherwise hand back the
 * previous deploy's copy after a redeploy. Revalidating costs a 304 when nothing changed. The client
 * passes `"reload"` when a referenced file 404s and it needs to know what the deploy says now.
 */
export async function fetchManifest(
  basePath: string,
  fetchImpl: typeof fetch,
  compression: Compression = "none",
  cache: RequestCache = "no-cache",
): Promise<Manifest> {
  const url = `${basePath}/manifest.json${compressionSuffix(compression)}`;
  const format = decompressionFormat(compression);
  let parsed: Manifest;
  if (format === undefined) {
    parsed = (await fetchJson(url, "manifest", fetchImpl, undefined, cache)) as Manifest;
  } else {
    const text = await fetchCompressedText(url, "manifest", format, fetchImpl, undefined, cache);
    parsed = parseCorruptible(url, () => JSON.parse(text) as Manifest);
  }
  // JSON-valid but not a manifest — the body "won't parse" into one (ADR-0007 §5).
  if (typeof parsed.formatVersion !== "number") {
    throw new ZonemapDbError({
      code: "CORRUPT_DATA",
      url,
      message: `zonemapdb: the manifest at "${url}" parsed as JSON but has no numeric formatVersion — the deploy is corrupt. Re-run \`zonemapdb build\` and redeploy.`,
    });
  }
  // ADR-0005: same major → always compatible (SemVer); major mismatch → fail loud.
  if (parsed.formatVersion !== FORMAT_VERSION) {
    throw new ZonemapDbError({
      code: "FORMAT_VERSION",
      url,
      message:
        `zonemapdb: the dataset at "${url}" was built with zonemapdb major ${String(parsed.formatVersion)} ` +
        `but this runtime is major ${FORMAT_VERSION} — align versions and re-run \`zonemapdb build\`.`,
    });
  }
  // ADR-0013 added each field's `pruning` list inside major 0. The rider rule can't be enforced
  // without it, so a tree built before it is refused like any format mismatch rather than guessed at.
  if (Object.values(parsed.schema?.fields ?? {}).some((field) => !Array.isArray(field.pruning))) {
    throw new ZonemapDbError({
      code: "FORMAT_VERSION",
      url,
      message:
        `zonemapdb: the dataset at "${url}" was built by a zonemapdb older than this runtime (before 0.3.0, which ` +
        `added which operators prune) — re-run \`zonemapdb build\` with the current version and redeploy.`,
    });
  }
  return parsed;
}

/**
 * How this deploy compressed the files the manifest points at. Reads the modern `compression` field
 * and falls back to the original `gzip: true`, so a tree built before the field existed still works.
 */
export function datasetCompression(manifest: Manifest): Compression {
  return manifest.dataset.compression ?? (manifest.dataset.gzip === true ? "gzip" : "none");
}

/**
 * Whether `manifest` points at `url` — a block, an index chunk (base, reversed or trigram) or a
 * zonemap sidecar. The client asks this of a freshly fetched manifest after a referenced file 404s
 * (#32): if the fresh manifest still names the file the deploy really is missing it, and if not, the
 * 404 came from a stale manifest and the query is worth one retry.
 */
export function manifestReferences(manifest: Manifest, basePath: string, url: string): boolean {
  const prefix = `${basePath}/`;
  if (!url.startsWith(prefix)) return false;
  const path = url.slice(prefix.length);

  const compression = datasetCompression(manifest);
  if (manifest.blocks.some((block) => blockRelPath(block.hash, manifest.blocks.length, compression) === path)) return true;

  for (const index of Object.values(manifest.indexes)) {
    const directories = [index.chunks, index.reversed?.chunks ?? [], index.trigram?.chunks ?? []];
    if (directories.some((chunks) => chunks.some((chunk) => chunk.file === path))) return true;
  }

  return Object.values(manifest.zonemap).some((entry) => "sidecar" in entry && entry.sidecar === path);
}
