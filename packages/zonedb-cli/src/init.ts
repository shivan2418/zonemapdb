import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DEFAULT_BLOCK_BYTES, loadConfigFile, resolveConfig } from "./config.js";
import { estimateBlockCount } from "./estimator.js";
import { SchemaInferrer, type BlockShareProbe, type InferenceResult, type UnselectiveIndex, type ValueShape } from "./infer.js";
import { BlockShareEstimator } from "./prune-estimate.js";
import { Reservoir } from "./reservoir.js";
import { countInputRecords, iterateInputRecords, type InputReadOptions, type PopulationStats } from "./input.js";
import type { OnProgress } from "./progress.js";
import { MIN_BLOCKS_FOR_SELECTIVITY, skippedIndexNote, unsuitableTextIndexWarning } from "./warnings.js";
import type { FieldConfig, InputFormat, ZoneDbConfig } from "./types.js";
import { getFormatVersion } from "./version.js";

/** Exported so callers that sample records the same way `init` does (the wizard, T12) never drift from this default. */
export const DEFAULT_SAMPLE_SIZE = 1000;

/**
 * How many leading records inference should look at, or `undefined` for every record.
 *
 * Reading everything is the DEFAULT: inference decides the baked schema, and a schema wrong about
 * the data is the expensive kind of wrong — a value union missing a late value, a field that never
 * appeared in the first 1000 rows, a cardinality that misprices an index or picks the wrong sort
 * field. Inference streams, so a full read costs time, not memory (#29). Sampling stays available for
 * a fast look at a large file, but it is opt-in.
 */
export function sampleLimit(opts: { fullScan?: boolean; sampleSize?: number }): number | undefined {
  return opts.fullScan ? undefined : opts.sampleSize;
}

export interface InputScan {
  inferred: InferenceResult;
  /** Up to `estimateSample` records drawn uniformly from everything read (`Reservoir`) — what the wizard's live estimates profile. */
  sample: Record<string, unknown>[];
  /** Record count and serialized bytes of everything read — bytes only when `measureBytes` was asked for. */
  population: PopulationStats;
  /**
   * The inference again, with the index recommendation judged against another sort field or block
   * size, from the same counts and prune sample. The wizard calls it once it knows its block size.
   */
  recommendFor(opts: { sortField?: string; blockBytes: number }): InferenceResult;
  /** The records the index recommendation judges pruning from (scalar fields only), so the wizard's live "barely prunes" agrees with it. */
  pruneSample: Record<string, unknown>[];
}

/**
 * Records kept for judging whether a recommended index would prune (#31). On Scryfall the estimate
 * lands within ~2 percentage points of the built indexes from 2,000 records and barely improves past
 * 10,000; this is the middle, since wide records make each sampled one cost kilobytes.
 */
const PRUNE_SAMPLE_SIZE = 5_000;

/** A sampled record reduced to what the pruning estimate reads, plus its size for the block count. */
interface PruneSampleItem {
  record: Record<string, unknown>;
  bytes: number;
}

/**
 * The part of a record a pruning estimate can use: scalars and arrays of scalars, the only values an
 * index is built on. Nested objects are dropped, so the sample stays small on wide records.
 */
function indexableProjection(record: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key in record) {
    const value = record[key];
    if (value !== null && typeof value === "object") {
      if (!Array.isArray(value) || value.some((v) => v !== null && typeof v === "object")) continue;
    }
    out[key] = value;
  }
  return out;
}

/**
 * The inference probe that predicts each candidate index's "barely prunes" number from the sample,
 * so the recommendation can pass over indexes the build would warn about (#31). `blockCount` comes
 * from the measured dataset size when there is one, else from the sample's mean record size.
 */
function blockShareProbe(
  sample: PruneSampleItem[],
  recordCount: number,
  datasetBytes: number | undefined,
  blockBytes: number,
): BlockShareProbe | undefined {
  if (sample.length === 0) return undefined;
  const meanBytes = sample.reduce((sum, item) => sum + item.bytes, 0) / sample.length;
  const blockCount = estimateBlockCount(datasetBytes ?? meanBytes * recordCount, blockBytes);
  // Same floor as the build warning: on a handful of blocks every value is "in most of them".
  if (blockCount < MIN_BLOCKS_FOR_SELECTIVITY) return undefined;

  const records = sample.map((item) => item.record);
  const estimators = new Map<string, BlockShareEstimator>();
  return (sortField, sortKind, field, inferred) => {
    let estimator = estimators.get(sortField);
    if (estimator === undefined) {
      estimator = new BlockShareEstimator(records, sortField, sortKind, recordCount, blockCount);
      estimators.set(sortField, estimator);
    }
    return estimator.meanShare(field, inferred.multi, inferred.cardinality);
  };
}

/**
 * One streaming pass over the input for `init` and the wizard: infers the schema, draws the estimate
 * sample and measures the dataset without ever holding more than one record plus the samples (#29).
 * Shared so the two paths can't read the input differently and drift apart in what they recommend.
 *
 * The index recommendation is judged for `sortField` (the one the caller will use, falling back to the
 * inferred one) at `blockBytes`. When the read stops early (`readOpts.limit`), pass the input's true
 * totals as `population`: how many data files there will be, and so whether a value sits in most of
 * them, depends on the whole input, not the records read.
 */
export function scanInput(
  inputPath: string,
  readOpts: InputReadOptions,
  opts: { estimateSample?: number; measureBytes?: boolean; blockBytes?: number; sortField?: string; population?: PopulationStats } = {},
): InputScan {
  const inferrer = new SchemaInferrer();
  const reservoir = new Reservoir<Record<string, unknown>>(opts.estimateSample ?? 0);
  const pruneSample = new Reservoir<PruneSampleItem>(PRUNE_SAMPLE_SIZE);
  let datasetBytes = 0;

  for (const record of iterateInputRecords(inputPath, readOpts)) {
    inferrer.add(record);
    reservoir.add(record);
    pruneSample.addWith(() => ({ record: indexableProjection(record), bytes: Buffer.byteLength(JSON.stringify(record), "utf8") }));
    if (opts.measureBytes) datasetBytes += Buffer.byteLength(JSON.stringify(record), "utf8");
  }

  if (inferrer.size === 0) {
    throw new Error(`zonedb: init found no records in "${inputPath}" to infer a schema from`);
  }
  const recordCount = opts.population?.recordCount ?? inferrer.size;
  const measuredBytes = opts.population?.datasetBytes ?? (opts.measureBytes ? datasetBytes : undefined);
  const recommendFor = (recommend: { sortField?: string; blockBytes: number }): InferenceResult => {
    const blockShare = blockShareProbe(pruneSample.sample, recordCount, measuredBytes, recommend.blockBytes);
    return inferrer.finish({
      ...(blockShare ? { blockShare } : {}),
      ...(recommend.sortField !== undefined ? { sortField: recommend.sortField } : {}),
    });
  };
  return {
    inferred: recommendFor({
      ...(opts.sortField !== undefined ? { sortField: opts.sortField } : {}),
      blockBytes: opts.blockBytes ?? DEFAULT_BLOCK_BYTES,
    }),
    sample: reservoir.sample,
    population: { recordCount: inferrer.size, datasetBytes },
    recommendFor,
    pruneSample: pruneSample.sample.map((item) => item.record),
  };
}

/** Convention for editor JSON-schema resolution: `config.schema.json` ships inside the installed devDependency. */
const CONFIG_SCHEMA_REF = "node_modules/zonedb-cli/config.schema.json";

export interface InitOptions {
  /** Directory input/config-relative paths resolve against. */
  cwd: string;
  /** Absolute path to read/write `zonedb.config.json`. */
  configPath: string;
  /** Non-interactive confirmation — must be true, or this throws. The interactive wizard (T12,
   * `wizard-tui.ts`) sits above `init()` in `bin.ts` and always passes `true` here itself, once its
   * review step confirms; `init()` has no separate interactive path of its own. */
  yes: boolean;
  /** Re-run inference even if a config already exists, refreshing the baked schema block. */
  reinfer?: boolean;
  /** Force a full scan. Redundant with the default, kept so `--full-scan` stays meaningful and explicit. */
  fullScan?: boolean;
  /** Opt into inferring from only the leading `sampleSize` records instead of the whole input. */
  sampleSize?: number;
  collection?: string;
  /** Positional input path/glob — required the first time `init` runs for a given config. */
  inputPath?: string;
  format?: InputFormat;
  delimiter?: string;
  records?: string;
  sortField?: string;
  pk?: string;
  /** Explicit opt-in indexed-field set, overriding the inferred/existing recommendation. */
  indexedFields?: string[];
  /** The complete set of fields with the reversed-value index (ADR-0003 §7) — forces them indexed too. */
  endsWithFields?: string[];
  /** The complete set of fields with the trigram index (ADR-0003 §7) — forces them indexed too. */
  containsFields?: string[];
  output?: string;
  clientOut?: string;
  basePath?: string;
  blockBytes?: number;
  indexChunkBytes?: number;
  /**
   * Progress for the read phase. Reading the whole input is the default, so on a large file this is
   * the difference between a progress bar and a long silence.
   */
  onProgress?: OnProgress;
}

type FieldFlagOverrides = Pick<InitOptions, "indexedFields" | "endsWithFields" | "containsFields">;

/**
 * Layers `--indexed`/`--ends-with`/`--contains` on top of a fields record — used identically
 * whether `fields` just came from inference or is being reused from an existing config, so the
 * flag-equivalence contract (ADR-0005 §3) is honored the same way either way. Each flag, when
 * passed, is the *complete* set for what it controls (flags > file precedence) rather than merged
 * with what the config already had. Multi-valued fields and a non-sort-field pk are always forced
 * indexed regardless — omitting them isn't a real choice, it produces a structurally broken config.
 */
function applyFieldFlagOverrides(
  fields: Record<string, FieldConfig>,
  sortField: string,
  pk: string | undefined,
  overrides: FieldFlagOverrides,
): Record<string, FieldConfig> {
  const flagGroups: [string, string[] | undefined][] = [
    ["indexed", overrides.indexedFields],
    ["ends-with", overrides.endsWithFields],
    ["contains", overrides.containsFields],
  ];
  for (const [flagName, names] of flagGroups) {
    for (const name of names ?? []) {
      if (!fields[name]) {
        throw new Error(
          `zonedb: --${flagName} "${name}" is not declared in the baked schema — pass --reinfer to rediscover fields`,
        );
      }
    }
  }

  // Each flag, when passed, is the complete set for its opt-in, like `--indexed`: a field it leaves out
  // loses the opt-in, even one the existing config had. That is the only way to turn one off without
  // hand-editing (the wizard always passes all three).
  const indexedWanted = overrides.indexedFields ? new Set(overrides.indexedFields) : undefined;
  const endsWithWanted = overrides.endsWithFields ? new Set(overrides.endsWithFields) : undefined;
  const containsWanted = overrides.containsFields ? new Set(overrides.containsFields) : undefined;
  if (!indexedWanted && !endsWithWanted && !containsWanted) return fields;

  const next: Record<string, FieldConfig> = {};
  for (const [name, f] of Object.entries(fields)) {
    if (name === sortField) {
      next[name] = f;
      continue;
    }
    const cfg: FieldConfig = { ...f };
    const mustIndex = cfg.multi === true || name === pk;

    if (endsWithWanted && !endsWithWanted.has(name)) delete cfg.endsWith;
    if (containsWanted && !containsWanted.has(name)) delete cfg.contains;
    if (indexedWanted) {
      if (indexedWanted.has(name) || mustIndex) cfg.indexed = true;
      else {
        delete cfg.indexed;
        // The text-index opt-ins are built on the plain index, so they go with it (unless their own flag
        // asks for them below, which indexes the field again). A value union stays: it narrows the
        // field's filters whether or not they prune.
        delete cfg.endsWith;
        delete cfg.contains;
      }
    }
    if (endsWithWanted?.has(name)) {
      cfg.indexed = true;
      cfg.endsWith = true;
    }
    if (containsWanted?.has(name)) {
      cfg.indexed = true;
      cfg.contains = true;
    }
    if (mustIndex) cfg.indexed = true;
    next[name] = cfg;
  }
  return next;
}

export interface InitResult {
  configPath: string;
  config: ZoneDbConfig;
  /** True when this run actually (re)inferred the schema, false when it reused an existing baked one. */
  reinferred: boolean;
  /** Non-fatal repairs made while resolving — e.g. query flags dropped from a payload-only `json` field. */
  warnings: string[];
}

/**
 * Points out fields whose value unions are identical, so codegen would emit the same literal union
 * several times over. Only a suggestion: identical *today* does not prove same concept — on real card
 * data `colors` and `color_identity` coincide while `produced_mana` adds two values — so the sharing
 * has to be the user's call via `valuesType`, and this just makes the option discoverable.
 */
function duplicateValueUnionHints(fields: Record<string, FieldConfig>): string[] {
  const groups = new Map<string, string[]>();
  for (const [name, field] of Object.entries(fields)) {
    if (field.values === undefined || field.valuesType !== undefined) continue;
    const key = [...field.values].sort().join("\u0000");
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(name);
  }
  return [...groups.entries()]
    .filter(([, names]) => names.length > 1)
    .map(
      ([key, names]) =>
        `zonedb: ${names.join(", ")} all have the same value set [${key.split("\u0000").join(", ")}], so codegen ` +
        `emits that union once per field. If they are the same concept, give them a shared name with ` +
        `"valuesType": "YourName" — build then fails if a future refresh makes them diverge, instead of ` +
        `quietly widening one of them.`,
    );
}

/** Flags that only mean something on a queryable field; `config.ts` rejects all of them on a `json` field. */
const QUERY_FLAGS = ["indexed", "endsWith", "contains", "multi"] as const;

/**
 * Strips query flags that landed on a payload-only `json` field, reporting each one.
 *
 * Asking to index a nested/mixed field is an easy mistake (a `--indexed` list, a hand-edited config,
 * or a field that only became `json` on `--reinfer` after the data changed shape), and failing the
 * whole run over it would throw away every other choice the user made. Dropping just the offending
 * flags always lands a usable config; the field itself is still stored and returned, just not
 * filterable. `sortField`/`pk` are deliberately NOT repaired this way — they name a required role,
 * so quietly dropping them would leave the config structurally incomplete, and `resolveConfig`
 * rightly rejects a `json` field in either slot.
 */
function dropQueryFlagsFromJsonFields(fields: Record<string, FieldConfig>): {
  fields: Record<string, FieldConfig>;
  warnings: string[];
} {
  const warnings: string[] = [];
  const next: Record<string, FieldConfig> = {};

  for (const [name, field] of Object.entries(fields)) {
    const dropped = field.kind === "json" ? QUERY_FLAGS.filter((flag) => field[flag] === true) : [];
    if (dropped.length === 0) {
      next[name] = field;
      continue;
    }
    const cfg: FieldConfig = { ...field };
    for (const flag of dropped) delete cfg[flag];
    next[name] = cfg;
    warnings.push(
      `zonedb: field "${name}" holds nested or mixed-type values, so it is payload-only (kind "json") — ` +
        `dropped ${dropped.join(", ")}. It is still stored and returned by findMany, but cannot be filtered on. ` +
        `To query it, flatten it into a scalar field upstream and re-run init --reinfer.`,
    );
  }

  return { fields: next, warnings };
}

/**
 * Computes the config `init` would write, without writing it — the pure(-ish; it still reads the
 * input file and any existing config) core `init()` builds on. Exported so the wizard's review step
 * (T12) can render an exact, byte-faithful "what will be written" preview by calling the *same*
 * resolution logic the actual persist step uses, instead of hand-reconstructing its own JSON shape
 * that could silently drift from it.
 */
export function resolveInitConfig(opts: InitOptions): InitResult {
  if (!opts.yes) {
    throw new Error(
      'zonedb: "init" requires --yes to run non-interactively — pass --yes plus flags, or re-run in a real terminal for the interactive wizard',
    );
  }

  const existing = existsSync(opts.configPath) ? loadConfigFile(opts.configPath) : undefined;

  const inputPath = opts.inputPath ?? existing?.input.path;
  if (!inputPath) {
    throw new Error("zonedb: init needs an input path/glob — pass it as the positional argument");
  }
  const format: InputFormat = opts.format ?? existing?.input.format ?? "ndjson";
  const delimiter = opts.delimiter ?? existing?.input.delimiter;
  const recordsPath = opts.records ?? existing?.input.records;
  const collection = opts.collection ?? existing?.collection ?? path.basename(inputPath).replace(/\.[^.]+$/, "");

  const reinferred = existing === undefined || opts.reinfer === true;

  let fields: Record<string, FieldConfig>;
  let sortField: string;
  let pk: string | undefined;
  /** Per-field value shapes, only available on a run that actually read records (see the warning below). */
  let inferredShapes: Record<string, ValueShape> | undefined;
  /** Fields the recommendation passed over because their index wouldn't prune (#31). */
  let unselectiveIndexes: UnselectiveIndex[] = [];

  if (reinferred) {
    const readDelimiter = delimiter ?? (format === "tsv" ? "\t" : ",");
    // Streams: inference holds counts per field, never the records, so reading everything is safe on
    // any size of input (#29).
    const blockBytes = opts.blockBytes ?? existing?.blockBytes;
    const readOpts: InputReadOptions = { format, delimiter: readDelimiter, recordsPath, fields: {} };
    const resolvedInput = path.resolve(opts.cwd, inputPath);
    // Reads everything unless the caller opted into a sample (see `sampleLimit`). A sampled read still
    // needs the input's true size to judge index pruning, so it's counted (cheaply: no inference).
    const limit = sampleLimit(opts);
    const population = limit === undefined ? undefined : countInputRecords(resolvedInput, readOpts);
    // The sort field this run will keep, when it's known before reading: a flag, or the existing
    // config's. The index recommendation is judged against it (it falls back to the inferred one when
    // the data no longer has it).
    const preferredSortField = opts.sortField ?? existing?.schema.sortField;
    const { inferred } = scanInput(
      resolvedInput,
      { ...readOpts, limit, ...(opts.onProgress ? { onProgress: opts.onProgress } : {}) },
      {
        ...(blockBytes !== undefined ? { blockBytes } : {}),
        ...(preferredSortField !== undefined ? { sortField: preferredSortField } : {}),
        ...(population !== undefined ? { population } : {}),
      },
    );
    unselectiveIndexes = inferred.unselectiveIndexes;

    // `--reinfer` refreshes what init LEARNED from the data (kinds, absent/nullable, lists, value
    // sets) and keeps what the user CHOSE: the sort field, the pk, which fields are indexed and
    // their text opt-ins. Re-deriving choices from inference would silently re-plan a tuned deploy
    // (a different sort field re-lays out every block). A choice only falls back to inference when
    // the field it names is gone from the data. Flags still override everything below.
    const priorSchema = existing?.schema;
    const stillPresent = (name: string | undefined) => name !== undefined && inferred.fields[name] !== undefined;
    sortField = opts.sortField ?? (stillPresent(priorSchema?.sortField) ? priorSchema!.sortField : inferred.sortField);
    pk = opts.pk ?? (priorSchema === undefined ? inferred.pk : stillPresent(priorSchema.pk) ? priorSchema.pk : undefined);
    inferredShapes = Object.fromEntries(Object.entries(inferred.fields).map(([name, f]) => [name, f.shape]));

    const defaultIndexed = new Set(inferred.indexedFields);
    if (pk !== undefined) defaultIndexed.add(pk);

    fields = {};
    for (const [name, f] of Object.entries(inferred.fields)) {
      const priorField = priorSchema?.fields[name];
      const cfg: FieldConfig = { kind: f.kind };
      // A field the config already had keeps its indexing choice; a field new to the data gets the
      // same recommendation a first run would give it.
      const wantsIndex = priorField !== undefined ? priorField.indexed === true : defaultIndexed.has(name);
      const isIndexed = f.kind !== "json" && name !== sortField && (wantsIndex || f.multi);
      if (isIndexed) cfg.indexed = true;
      // A new field gets a union when it's indexed, as on a first run. After that, whether a field HAS a
      // union is the user's call (deleting `values` widens it on purpose, and a union narrows an
      // unindexed field's filters too), but its members are a fact, so an existing union is refreshed.
      const wantsValues = priorField === undefined ? isIndexed : priorField.values !== undefined;
      if (f.values && wantsValues) cfg.values = f.values;
      if (f.multi) cfg.multi = true;
      // Facts about the data, recorded on every field so the generated record type tells the truth.
      // Which missing-value operators they unlock is decided later, from the field's role.
      if (f.absent) cfg.absent = true;
      if (f.nullable) cfg.nullable = true;
      // Text-index opt-ins are choices too, kept while the field can still carry them.
      if (isIndexed && f.kind === "string") {
        if (priorField?.endsWith) cfg.endsWith = true;
        if (priorField?.contains) cfg.contains = true;
      }
      // `tsType`/`tsImport` are the one part of a field config inference can never produce — the user
      // hand-writes them. `--reinfer` re-reads the DATA's shape, so carry them over rather than
      // silently discarding work. Dropped if the field stopped being a payload field, since a scalar
      // kind can't carry a tsType (config.ts rejects it).
      // `valuesType` is hand-authored (only the user knows two fields are the same concept), so
      // --reinfer must carry it over — but only while the field still HAS a value union to name.
      if (cfg.values && priorField?.valuesType !== undefined) cfg.valuesType = priorField.valuesType;
      if (f.kind === "json" && priorField?.tsType !== undefined) {
        cfg.tsType = priorField.tsType;
        if (priorField.tsImport !== undefined) cfg.tsImport = priorField.tsImport;
      }
      fields[name] = cfg;
    }

    // A derived field has no key in the input, so inference cannot see it and would silently delete
    // it — along with any index built on it (ADR-0009). Carry the whole declaration over verbatim;
    // it describes a computation, not a shape `--reinfer` could have re-observed. Only dropped when
    // its source field is gone from the data, where keeping it would fail config validation anyway.
    for (const [name, priorField] of Object.entries(existing?.schema.fields ?? {})) {
      if (priorField.derive === undefined || fields[name] !== undefined) continue;
      if (inferred.fields[priorField.derive.from] === undefined) continue;
      fields[name] = priorField;
    }
  } else {
    fields = existing!.schema.fields;
    sortField = opts.sortField ?? existing!.schema.sortField;
    pk = opts.pk ?? existing!.schema.pk;
  }

  fields = applyFieldFlagOverrides(fields, sortField, pk, opts);
  const repaired = dropQueryFlagsFromJsonFields(fields);
  fields = repaired.fields;

  const output = opts.output ?? existing?.output;
  const clientOut = opts.clientOut ?? existing?.clientOut;
  const basePath = opts.basePath ?? existing?.basePath;
  const blockBytes = opts.blockBytes ?? existing?.blockBytes;
  const indexChunkBytes = opts.indexChunkBytes ?? existing?.indexChunkBytes;

  const config: ZoneDbConfig = {
    $schema: CONFIG_SCHEMA_REF,
    formatVersion: getFormatVersion(),
    collection,
    input: {
      path: inputPath,
      ...(format !== "ndjson" ? { format } : {}),
      ...(delimiter !== undefined ? { delimiter } : {}),
      ...(recordsPath !== undefined ? { records: recordsPath } : {}),
    },
    ...(output !== undefined ? { output } : {}),
    ...(clientOut !== undefined ? { clientOut } : {}),
    ...(basePath !== undefined ? { basePath } : {}),
    ...(blockBytes !== undefined ? { blockBytes } : {}),
    ...(indexChunkBytes !== undefined ? { indexChunkBytes } : {}),
    // No flag sets these; carry them over so re-running init never silently turns compression off.
    ...(existing?.compression !== undefined ? { compression: existing.compression } : {}),
    ...(existing?.gzip !== undefined ? { gzip: existing.gzip } : {}),
    schema: { sortField, ...(pk !== undefined ? { pk } : {}), fields },
  };

  // Fail loud on any invalid combination before writing anything — reuses build's own invariants.
  resolveConfig(config, path.dirname(opts.configPath));

  // Shape-based text-index warnings need the inferred shapes, so they only exist on a run that
  // actually read the data (a first run, or `--reinfer`). Reusing a baked schema reads no records.
  const shapeWarnings: string[] = [];
  if (inferredShapes !== undefined) {
    for (const [name, field] of Object.entries(config.schema.fields)) {
      for (const operator of ["endsWith", "contains"] as const) {
        if (!field[operator]) continue;
        const unsuitable = unsuitableTextIndexWarning(name, operator, inferredShapes[name] ?? "text");
        if (unsuitable) shapeWarnings.push(unsuitable);
      }
    }
  }

  // Only where the recommendation actually decided: not when `--indexed` gave the complete set (the
  // wizard always does), and not for a field the existing config already had, whose indexing is a
  // kept choice. Then only the fields that did end up unindexed.
  const priorFields = existing?.schema.fields;
  const skippedIndexNotes = opts.indexedFields
    ? []
    : unselectiveIndexes
        .filter(({ field }) => priorFields?.[field] === undefined)
        .filter(({ field }) => config.schema.fields[field] !== undefined && config.schema.fields[field]!.indexed !== true)
        .map(({ field, blockShare }) => skippedIndexNote(field, sortField, blockShare));

  return {
    configPath: opts.configPath,
    config,
    reinferred,
    warnings: [
      ...repaired.warnings,
      ...shapeWarnings,
      ...skippedIndexNotes,
      ...duplicateValueUnionHints(config.schema.fields),
    ],
  };
}

/**
 * The non-interactive core of `init` (ADR-0005 §4 / ADR-0006 §1): infer → recommend → persist
 * `zonedb.config.json`. `init --yes` + flags is fully scriptable; the interactive wizard
 * (T12, `wizard-tui.ts`) is a UX layer that calls this exact function with `yes: true` once its
 * review step confirms — there is no separate wizard-side config writer to drift from this one.
 * Precedence is flags > existing file > inferred defaults (ADR-0005 §3).
 */
export function init(opts: InitOptions): InitResult {
  const result = resolveInitConfig(opts);
  mkdirSync(path.dirname(opts.configPath), { recursive: true });
  writeFileSync(opts.configPath, JSON.stringify(result.config, null, 2) + "\n");
  return result;
}
