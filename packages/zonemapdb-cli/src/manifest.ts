import type {
  FieldConfig,
  FieldSchemaEntry,
  IndexChunkDirEntry,
  IndexDescriptor,
  Manifest,
  MissingZonemapInfo,
  PairZonemapEntry,
  ResolvedConfig,
  SchemaDescriptor,
  BlockDescriptor,
  ZonemapEntry,
} from "./types.js";

/**
 * What a field accepts, and which of those operators prune (ADR-0013). Every queryable field accepts
 * every operator its type allows; an index decides only which of them narrow the blocks a query reads.
 * The rest are riders: they test the records a pruning constraint already selected, which costs
 * nothing at build time.
 */
export interface FieldOperators {
  /** Everything a `where` may write on this field. */
  operators: readonly string[];
  /** The subset that narrows blocks. Empty for an unindexed field. */
  pruning: readonly string[];
}

const RANGE_OPERATORS = ["gt", "gte", "lt", "lte"] as const;

/**
 * The operators each kind allows. String ranges are the one deliberate gap: comparison is
 * lexicographic, so `gte: "2"` on a numeric-looking column drops every double-digit value. Only a
 * string SORT field gets them, where that order is the physical one the user chose (ADR-0003 §7).
 */
function operatorsForKind(field: FieldConfig, isSortField: boolean): string[] {
  switch (field.kind) {
    case "string":
      return ["equals", "in", ...(isSortField ? RANGE_OPERATORS : []), "startsWith", "endsWith", "contains", "not"];
    case "number":
    case "date":
      return ["equals", "in", ...RANGE_OPERATORS, "not"];
    case "boolean":
      return ["equals", "not"];
    default:
      return []; // json: payload only (ADR-0001)
  }
}

/**
 * The operators an index structure answers. The sort field's split-points prune equality and ranges,
 * and a string sort field's prefixes too — a prefix is a contiguous span of its sorted values. A
 * secondary field's inverted index answers equality and prefixes (strings), its zonemap pairs answer
 * ranges (number/date: stored untruncated, so exact at block granularity), and the `endsWith`/
 * `contains` opt-ins build the reversed and trigram indexes those operators prune through.
 */
function pruningForKind(field: FieldConfig, isSortField: boolean): string[] {
  if (isSortField) return ["equals", "in", ...RANGE_OPERATORS, ...(field.kind === "string" ? ["startsWith"] : [])];
  switch (field.kind) {
    case "string":
      return ["equals", "in", "startsWith", ...(field.endsWith ? ["endsWith"] : []), ...(field.contains ? ["contains"] : [])];
    case "number":
    case "date":
      return ["equals", "in", ...RANGE_OPERATORS];
    case "boolean":
      return ["equals"];
    default:
      return [];
  }
}

/**
 * `isNull`/`isAbsent`/`exists`, each offered only when the data can actually be that way: `isNull`
 * for a nullable field, `isAbsent` for one whose key can be missing, `exists` for either. Always
 * riders. Not offered on the sort field or on list fields, whose missing values have their own rules
 * (ADR-0002 §9, ADR-0010).
 */
function missingValueOperators(field: FieldConfig): string[] {
  if (field.multi) return [];
  const ops: string[] = [];
  if (field.nullable) ops.push("isNull");
  if (field.absent) ops.push("isAbsent");
  if (field.nullable || field.absent) ops.push("exists");
  return ops;
}

export function operatorsForField(field: FieldConfig, isSortField: boolean, indexed: boolean): FieldOperators {
  const operators = [...operatorsForKind(field, isSortField), ...(isSortField ? [] : missingValueOperators(field))];
  return { operators, pruning: isSortField || indexed ? pruningForKind(field, isSortField) : [] };
}

/**
 * Everything the manifest needs from the sort field, gathered one block at a time from the globally
 * sorted stream (#28): the split-points, the null/absent tail, and — free because equal values are
 * adjacent once sorted — the distinct-value count behind the low-cardinality warning.
 */
export class SortFieldTracker {
  private readonly points: unknown[] = [];
  private lastValue: unknown;
  private nullCount = 0;
  private absentCount = 0;
  private missingFrom: number | undefined;
  private distinct = 0;
  private lastDistinctKey: string | undefined;

  constructor(private readonly sortField: string) {}

  addBlock(blockIndex: number, records: Record<string, unknown>[]): void {
    this.points.push(records[0]![this.sortField]);
    this.lastValue = records[records.length - 1]![this.sortField];

    for (const record of records) {
      const value = record[this.sortField];
      if (value === null) {
        this.nullCount++;
        this.missingFrom ??= blockIndex;
      } else if (value === undefined) {
        this.absentCount++;
        this.missingFrom ??= blockIndex;
      } else {
        const key = JSON.stringify(value);
        if (key !== this.lastDistinctKey) {
          this.distinct++;
          this.lastDistinctKey = key;
        }
      }
    }
  }

  /** N+1 monotonic boundaries: splitPoints[i] = min value of block i; the final entry is the last block's max. */
  splitPoints(): unknown[] {
    return this.points.length === 0 ? [] : [...this.points, this.lastValue];
  }

  /**
   * The contiguous null/absent tail at the high end of the globally sorted records (ADR-0002 §9),
   * with the two kinds counted separately. `undefined` when every record has a real sort-field value.
   */
  missingTail(): MissingZonemapInfo | undefined {
    if (this.missingFrom === undefined) return undefined;
    return { blockFrom: this.missingFrom, nullCount: this.nullCount, absentCount: this.absentCount };
  }

  /** Distinct non-missing sort-field values. */
  cardinality(): number {
    return this.distinct;
  }
}

function trackGroups(groups: Record<string, unknown>[][], sortField: string): SortFieldTracker {
  const tracker = new SortFieldTracker(sortField);
  groups.forEach((group, blockIndex) => tracker.addBlock(blockIndex, group));
  return tracker;
}

/** `SortFieldTracker.splitPoints` over block groups already in memory. */
export function computeSplitPoints(groups: Record<string, unknown>[][], sortField: string): unknown[] {
  return trackGroups(groups, sortField).splitPoints();
}

/** `SortFieldTracker.missingTail` over block groups already in memory. */
export function computeMissingTail(groups: Record<string, unknown>[][], sortField: string): MissingZonemapInfo | undefined {
  return trackGroups(groups, sortField).missingTail();
}

function buildSchemaDescriptor(config: ResolvedConfig): SchemaDescriptor {
  const fields: Record<string, FieldSchemaEntry> = {};
  for (const [name, field] of Object.entries(config.fields)) {
    const isSortField = name === config.sortField;
    const indexed = isSortField || field.indexed === true;
    const { operators, pruning } = operatorsForField(field, isSortField, indexed);
    fields[name] = {
      kind: field.kind,
      isDate: field.kind === "date",
      indexed,
      operators,
      pruning,
      ...(field.absent === true ? { absent: true as const } : {}),
      ...(field.nullable === true ? { nullable: true as const } : {}),
      ...(field.multi === true ? { multi: true as const } : {}),
      ...(name === config.pk ? { pk: true as const } : {}),
      ...(field.values !== undefined ? { values: field.values } : {}),
      ...(field.valuesType !== undefined ? { valuesType: field.valuesType } : {}),
      ...(field.tsType !== undefined ? { tsType: field.tsType } : {}),
      ...(field.tsImport !== undefined ? { tsImport: field.tsImport } : {}),
    };
  }
  return {
    collection: config.collection,
    sortField: config.sortField,
    ...(config.pk !== undefined ? { pk: config.pk } : {}),
    fields,
  };
}

export function buildManifest(opts: {
  config: ResolvedConfig;
  blockFiles: BlockDescriptor[];
  splitPoints: unknown[];
  /** The sort field's contiguous null/absent tail, if any (ADR-0002 §9). */
  missing?: MissingZonemapInfo;
  /** Per non-sort indexed field, its per-block [min,max] zonemap entry (ADR-0003). */
  secondaryZonemaps?: Record<string, PairZonemapEntry>;
  /** Per non-sort indexed field, its index chunk directory (ADR-0003). */
  indexChunkDirs?: Record<string, IndexChunkDirEntry[]>;
  /** Per field opted into `endsWith`, its reversed-value index chunk directory (ADR-0003 §7/§9). */
  reversedChunkDirs?: Record<string, IndexChunkDirEntry[]>;
  /** Per field opted into `contains`, its trigram index chunk directory (ADR-0003 §7/§9). */
  trigramChunkDirs?: Record<string, IndexChunkDirEntry[]>;
  /** Per multi-valued field, the blocks holding a present `[]` (ADR-0010 §5). */
  emptyBlocks?: Record<string, number[]>;
  formatVersion: number;
  generatorVersion: string;
}): Manifest {
  const {
    config,
    blockFiles,
    splitPoints,
    missing,
    secondaryZonemaps = {},
    indexChunkDirs = {},
    reversedChunkDirs = {},
    trigramChunkDirs = {},
    emptyBlocks = {},
    formatVersion,
    generatorVersion,
  } = opts;
  const recordCount = blockFiles.reduce((sum, s) => sum + s.count, 0);
  const schema = buildSchemaDescriptor(config);

  const zonemap: Record<string, ZonemapEntry> = {
    [config.sortField]: { splitPoints, ...(missing ? { missing } : {}) },
  };
  for (const [field, entry] of Object.entries(secondaryZonemaps)) zonemap[field] = entry;

  const indexes: Record<string, IndexDescriptor> = {};
  const indexDescriptorFor = (field: string): IndexDescriptor =>
    indexes[field] ?? { operators: schema.fields[field]!.operators, chunks: [] };
  for (const [field, chunks] of Object.entries(indexChunkDirs)) {
    indexes[field] = { operators: schema.fields[field]!.operators, chunks };
  }
  for (const [field, chunks] of Object.entries(reversedChunkDirs)) {
    indexes[field] = { ...indexDescriptorFor(field), reversed: { chunks } };
  }
  for (const [field, chunks] of Object.entries(trigramChunkDirs)) {
    indexes[field] = { ...indexDescriptorFor(field), trigram: { chunks } };
  }
  for (const [field, ordinals] of Object.entries(emptyBlocks)) {
    indexes[field] = { ...indexDescriptorFor(field), emptyBlocks: ordinals };
  }

  return {
    formatVersion,
    generatorVersion,
    dataset: {
      collection: config.collection,
      recordCount,
      blockCount: blockFiles.length,
      sortField: config.sortField,
      ...(config.compression !== "none" ? { compression: config.compression } : {}),
    },
    schema,
    blocks: blockFiles.map(({ hash, bytes, count }) => ({ hash, bytes, count })),
    zonemap,
    indexes,
  };
}
