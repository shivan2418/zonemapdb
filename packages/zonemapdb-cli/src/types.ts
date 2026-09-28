// Type-only, so nothing circular survives into the emitted JS (normalize.ts imports FieldKind back).
import type { NormalizerName } from "./normalize.js";

/**
 * How the deploy pre-compresses every file it serves (ADR-0002 §8). `"none"` is the default: most
 * hosts apply `Content-Encoding` themselves, which negotiates per client, whereas a pre-compressed
 * file cannot — a baked `.br` is unreadable to a client without brotli, with no fallback.
 *
 * Note the mismatch the file extension hides: the served suffix is `.br` (matching `Content-Encoding:
 * br`), but the DecompressionStream format string is `"brotli"`.
 */
export type Compression = "none" | "gzip" | "brotli";

/** The suffix a compressed file carries. Duplicated in both packages and pinned by an equivalence test — the runtime must derive block paths without reading anything the CLI wrote. */
export function compressionSuffix(compression: Compression): string {
  return compression === "gzip" ? ".gz" : compression === "brotli" ? ".br" : "";
}

/** The `DecompressionStream` format name for a compression, or `undefined` when nothing was applied. */
export function decompressionFormat(compression: Compression): "gzip" | "brotli" | undefined {
  return compression === "none" ? undefined : compression;
}

/**
 * `"json"` is the payload-only kind: a field whose values aren't a queryable scalar/date or
 * `string[]` (nested objects, `number[]`, object arrays, mixed-type fields). It is carried verbatim
 * in each record's payload and returned by `findMany`, but is never indexed and never appears in
 * `where`/`orderBy` — the "whole nested payload; only indexed fields are queryable" contract of
 * ADR-0001. Inference assigns it automatically instead of failing on shapes it can't index.
 */
export type FieldKind = "string" | "number" | "boolean" | "date" | "json";

/** Input file shapes accepted by `build` (T9). NDJSON/JSONL is the preferred format (= block payload format). */
export type InputFormat = "ndjson" | "json" | "csv" | "tsv";

export interface FieldConfig {
  kind: FieldKind;
  /** Opt-in secondary index (ADR-0003): builds a chunked inverted index + zonemap for this non-sort field. */
  indexed?: boolean;
  /** Opt-in reversed-value index — unlocks `endsWith` (ADR-0003 §7). Requires `kind: "string"` and `indexed: true`. */
  endsWith?: boolean;
  /** Opt-in trigram index — unlocks `contains` (ADR-0003 §7). Requires `kind: "string"` and `indexed: true`. */
  contains?: boolean;
  /**
   * The key may be missing from a record (absent ≠ null). Types the field optional (`field?: T`). On
   * an indexed, single-valued, non-sort field it also unlocks `isAbsent` and `exists`. Inferred by
   * `init`; `build` fails if a record lacks the key and this isn't set.
   */
  absent?: boolean;
  /**
   * The value may be `null` (null ≠ absent). Types the field `T | null`. On an indexed,
   * single-valued, non-sort field it also unlocks `isNull` and `exists`. Inferred by `init`; `build`
   * fails if a record holds `null` and this isn't set.
   */
  nullable?: boolean;
  /** Scalar leaf under an object-array — record value is `string[]`, matched existentially via `some` (T7). Requires `kind: "string"` and `indexed: true`. */
  multi?: boolean;
  /**
   * The field's closed value set. Codegen emits it as a value union, narrowing the equality-shaped
   * operators (`equals`/`in`/`some`) so they autocomplete. Inferred for enum-like string fields; edit
   * or delete it to widen the field back to plain `string`. Requires `kind: "string"` + `indexed: true`.
   */
  values?: string[];
  /**
   * Names the value union so several fields can SHARE one emitted type instead of each getting its own
   * near-duplicate alias. Requires `values`. Any number of fields may declare the same name, and a
   * config may declare as many distinct shared names as it likes.
   *
   * Codegen cannot infer this: it can see that two fields' value sets are equal *today*, not that they
   * are the same concept. On real card data `colors` and `color_identity` coincide while
   * `produced_mana` adds two more values — collapsing them automatically would let one field accept
   * the other's values. So the sharing is declared, and `build` fails if the sets ever diverge.
   */
  valuesType?: string;
  /**
   * The TypeScript type codegen should emit for this payload field instead of `unknown`, as a type
   * expression (`ImageUris`, `CardFace[]`, `Record<string, string | null>`). Requires `kind: "json"`.
   *
   * This is an **unchecked assertion**: zonemapdb stores and returns the payload verbatim and
   * never validates it against this type. You own keeping the declaration true of your data — the
   * same deal as a database driver's row type.
   */
  tsType?: string;
  /** A complete import statement emitted verbatim above the generated interface, for whatever `tsType` names. Requires `tsType`. */
  tsImport?: string;
  /**
   * Computes this field at build time from another field, instead of reading it from the input
   * (ADR-0009). The result is written into every record before partitioning, so it is an ORDINARY column
   * from that point on — sortable, indexable, typed, and carrying whatever operators its `kind`
   * earns. The source field is left untouched and stays queryable as-is.
   *
   * The motivating case is a column stored as text that you want to compare numerically:
   * `{ kind: "number", indexed: true, derive: { from: "power", using: "numeric" } }` yields a real
   * number field with `gt`/`gte`/`lt`/`lte`, while `power` keeps `equals: "*"` working.
   *
   * `using` names one of a closed set of domain-free transforms (see `normalize.ts`). Values a
   * normalizer cannot map are ABSENT on the derived field rather than guessed at (never `null`), so
   * declare `absent: true` whenever the source has any.
   */
  derive?: {
    /** The field to read. Must be declared in `schema.fields`, and must not itself be derived. */
    from: string;
    /** A normalizer name: `numeric`, `lowercase`, `trim` or `fold`. Its output kind must match this field's `kind`. */
    using: NormalizerName;
  };
}

export interface ZonemapDbConfig {
  /** Editor autocomplete/validation reference to the published `config.schema.json` (ADR-0005 §3). */
  $schema?: string;
  /** The package major this config's baked schema was (re)inferred against — stamped by `init`. */
  formatVersion?: number;
  /** Name the generated collection is exposed under, e.g. `db.movies`. */
  collection: string;
  input: {
    /** A single file path, or a glob pattern matching same-format files to merge then block as one dataset (T9). */
    path: string;
    /** Defaults to "ndjson". */
    format?: InputFormat;
    /** Delimited (csv/tsv) column delimiter override. Default: "," for csv, "\t" for tsv. Only valid for those formats (T9). */
    delimiter?: string;
    /** JSON only: dot-path to the array/map of records nested within the parsed document — the record selector for nested JSON (T9). Lands on exactly one node; no array-flattening. */
    records?: string;
  };
  /** Served data tree. Default `public/zonemapdb`. */
  output?: string;
  /** Generated client dir. Default `src/zonemapdb`. */
  clientOut?: string;
  /** Baked default for the generated `connect()`. Default `/zonemapdb`. */
  basePath?: string;
  /** Target compressed block size in bytes. Default 2 MiB. */
  blockBytes?: number;
  /** @deprecated Use `compression: "gzip"`. Kept so existing configs keep working; setting both to conflicting values is an error. */
  gzip?: boolean;
  /**
   * Opt-in build-time compression of every served file — blocks, index chunks, zonemap sidecars and
   * the manifest — decompressed at runtime via the native `DecompressionStream` API, no library and
   * no WASM (ADR-0002 §8). Default `"none"`: the host's `Content-Encoding` negotiates per client,
   * which a baked file cannot. Use this only when your host won't compress for you.
   */
  compression?: Compression;
  /** Target gzipped size per secondary-index chunk, in bytes. Default ~45 KB (ADR-0003 §5). */
  indexChunkBytes?: number;
  schema: {
    /** Must name a `number`, `date` or `string` field — the sole range-partitioned field (ADR-0002 §2). */
    sortField: string;
    /** Names a field as the user PK — unlocks the generated client's `get(id)` (T8). */
    pk?: string;
    fields: Record<string, FieldConfig>;
  };
}

export interface ResolvedConfig {
  collection: string;
  inputPath: string;
  inputFormat: InputFormat;
  /** Resolved delimiter for csv/tsv; irrelevant for ndjson/json but always populated for simplicity. */
  inputDelimiter: string;
  inputRecordsPath?: string;
  output: string;
  clientOut: string;
  basePath: string;
  blockBytes: number;
  compression: Compression;
  indexChunkBytes: number;
  sortField: string;
  pk?: string;
  fields: Record<string, FieldConfig>;
}

export interface BlockDescriptor {
  hash: string;
  bytes: number;
  count: number;
}

export interface FieldSchemaEntry {
  kind: FieldKind;
  isDate: boolean;
  indexed: boolean;
  /** Everything a `where` may write on this field (ADR-0013). */
  operators: readonly string[];
  /** The subset of `operators` that narrows which blocks a query reads; the rest are riders. */
  pruning: readonly string[];
  /** Present (`true`) when the key may be missing from a record — omitted otherwise, mirroring the runtime's optional `FieldMeta.absent`. */
  absent?: true;
  /** Present (`true`) when the value may be `null` — omitted otherwise, mirroring the runtime's optional `FieldMeta.nullable`. */
  nullable?: true;
  /** Present (`true`) only for multi-valued (object-array scalar-leaf) fields (T7) — omitted otherwise, mirroring the runtime's optional `FieldMeta.multi`. */
  multi?: true;
  /** Present (`true`) only for the user PK field (T8) — omitted otherwise, mirroring the runtime's optional `FieldMeta.pk`. */
  pk?: true;
  /** The field's closed value set, for codegen's value union — omitted unless configured (mirrors the runtime's optional `FieldMeta.values`). */
  values?: readonly string[];
  /** Shared name for this field's value union, when several fields declare one type between them. */
  valuesType?: string;
  /** A payload field's declared TypeScript type, emitted in place of `unknown` — omitted unless configured. Never validated against the data. */
  tsType?: string;
  /** The import statement `tsType` needs, emitted verbatim above the generated interface — omitted unless configured. */
  tsImport?: string;
}

export interface SchemaDescriptor {
  collection: string;
  sortField: string;
  /** Names the user PK field, if declared (T8) — unlocks the generated client's `get(id)`. */
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
  /** String min/max are truncated with a next-string-after upper bound (ADR-0003 §2). */
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
  /** Enabled operator set for this field's index — drives T5 codegen. */
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
  /** One entry per indexed non-sort field (ADR-0003). */
  indexes: Record<string, IndexDescriptor>;
}
