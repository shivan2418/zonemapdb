import {
  MANIFEST_BUDGET_BYTES,
  estimateCosts,
  estimateIndexSize,
  estimateBlockCount,
  profileDataset,
  recommendBlockBytes,
  type CostEstimate,
  type DatasetProfile,
  type IndexSizeEstimate,
} from "./estimator.js";
import { DEFAULT_INDEX_CHUNK_BYTES } from "./config.js";
import { inferSchema, isSortFieldCandidate, type InferenceResult, type ValueShape } from "./infer.js";
import { Reservoir } from "./reservoir.js";
import { compareSortValues, type SortKind } from "./sort.js";
import { valuesOf } from "./secondary-index.js";
import type { PopulationStats } from "./input.js";
import type { OnProgress } from "./progress.js";
import { BlockShareEstimator } from "./prune-estimate.js";
import {
  lowCardinalitySortFieldWarning,
  MIN_BLOCKS_FOR_SELECTIVITY,
  oversizedRecordWarning,
  UNSELECTIVE_POSTINGS_RATIO,
  unselectiveIndexWarning,
  unsuitableTextIndexWarning,
} from "./warnings.js";
import type { FieldConfig, FieldKind } from "./types.js";

/**
 * ADR-0006 §2/§5: the file-size step's fixed `↑/↓` list of byte targets. Spans below the ADR-0002
 * §5 recommended floor too, so a user can watch the manifest/contains costs react as blocks shrink.
 */
export const CHUNK_STEPS = [65_536, 131_072, 262_144, 524_288, 1_048_576, 2_097_152, 4_194_304, 8_388_608];

/**
 * Fast filters comes BEFORE Sort field deliberately (ADR-0002 §2). The sort field decides which
 * records are stored next to each other, so the only way to choose it well is to know what the user
 * filters on — asking for it first meant recommending locality before knowing what locality was for,
 * which is how a bulk-maintenance timestamp wins.
 */
/**
 * Cap on records the wizard PROFILES for its live estimates, independent of how many inference read.
 *
 * These are different jobs with opposite needs. Inference decides the baked schema, so it reads
 * everything (a value union missing a late value is a lasting bug). The estimates are re-derived on
 * every keypress — profiling, index sizing, and the sort-field locality measurement all walk these
 * records — so their cost has to be flat in dataset size or the wizard stops responding. Measured on a
 * 116k-record dataset before this cap: 45 SECONDS per keypress.
 *
 * Estimates stay accurate anyway because the numbers that scale with dataset size (block count, first
 * download) are computed from `population`'s true totals, not from `records.length`; what the sample
 * supplies is per-field shape — cardinality ratios, value sizes, locality — which is what sampling
 * estimates well.
 */
export const ESTIMATE_SAMPLE_MAX = 2000;

export const STAGE_LABELS = ["Detect", "Fast filters", "Sort field", "Text search", "File size", "Review"] as const;
export const LAST_STAGE = STAGE_LABELS.length - 1;
const FILTER_STAGE = 1;
const SORT_STAGE = 2;

function nearestChunkStep(bytes: number): number {
  return CHUNK_STEPS.reduce((best, step) => (Math.abs(step - bytes) < Math.abs(best - bytes) ? step : best), CHUNK_STEPS[0]!);
}

export interface WizardField {
  name: string;
  kind: FieldKind;
  cardinality: number;
  absent: boolean;
  multi: boolean;
  /** What the values look like — drives the text-search step's "this can't work" warning. */
  shape: ValueShape;
}

export interface WizardData {
  /** The TRUE total record count across the whole dataset — not the sample size (`records.length`). */
  recordCount: number;
  /** Alphabetical — the type-to-filter query (ADR-0006 §5), not field order, is what makes a
   * ~90-field real dataset navigable, so a stable, predictable order is more useful than a heuristic one. */
  fields: WizardField[];
  recommendedSortField: string;
  recommendedPk?: string;
  recommendedIndexed: string[];
  /** Fields eligible as the sort field: always-present, single-valued number/date/string (ADR-0002 §2). */
  sortCandidates: string[];
  /**
   * The records the wizard's live estimates are profiled against — capped at `ESTIMATE_SAMPLE_MAX`,
   * however many inference itself read. Re-walked on every keypress, so this must not grow with the
   * dataset; true whole-dataset totals live in `population`.
   */
  records: Record<string, unknown>[];
  /** True whole-dataset totals so size/block estimates reflect the full input even when `records` is a sample. */
  population: PopulationStats;
  /**
   * The sample `init`'s index recommendation judged pruning from (`scanInput`'s `pruneSample`), so the
   * live "barely prunes" marks agree with the recommendation. Falls back to `records`.
   */
  pruneRecords?: Record<string, unknown>[];
}

/**
 * Builds the wizard's pure model from what one streaming pass over the input gathered (`scanInput`):
 * the same `SchemaInferrer` (T10) `init --yes` uses, so the wizard's recommendations never drift from
 * the non-interactive path's, plus a uniform sample for the live estimates. The wizard always
 * (re)infers fresh — mirroring `init --reinfer` — since confirming/adjusting a fresh detection is what
 * the six-stage flow (ADR-0006 §1) is for.
 */
export function wizardDataFrom(
  inferred: InferenceResult,
  estimateRecords: Record<string, unknown>[],
  population: PopulationStats,
  pruneRecords?: Record<string, unknown>[],
): WizardData {
  const fields: WizardField[] = Object.entries(inferred.fields)
    .map(([name, f]) => ({ name, kind: f.kind, cardinality: f.cardinality, absent: f.absent, multi: f.multi, shape: f.shape }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  return {
    recordCount: population.recordCount,
    fields,
    recommendedSortField: inferred.sortField,
    recommendedPk: inferred.pk,
    recommendedIndexed: inferred.indexedFields,
    sortCandidates: fields.filter(isSortFieldCandidate).map((f) => f.name),
    records: estimateRecords,
    population,
    ...(pruneRecords !== undefined ? { pruneRecords } : {}),
  };
}

/** `wizardDataFrom` over records already in memory, which are then the whole dataset unless `population` says otherwise. */
export function buildWizardData(
  records: Record<string, unknown>[],
  population?: PopulationStats,
  opts: { onProgress?: OnProgress } = {},
): WizardData {
  if (records.length === 0) {
    throw new Error("zonedb: the wizard found no records in the input to infer a schema from");
  }
  const reservoir = new Reservoir<Record<string, unknown>>(ESTIMATE_SAMPLE_MAX);
  for (const record of records) reservoir.add(record);
  const pop: PopulationStats = population ?? {
    recordCount: records.length,
    datasetBytes: records.reduce((sum, r) => sum + Buffer.byteLength(JSON.stringify(r), "utf8"), 0),
  };
  return wizardDataFrom(inferSchema(records, opts), reservoir.sample, pop);
}

export interface WizardState {
  stage: number;
  /** Cursor within the current step's (possibly filtered) list. */
  cursor: number;
  sortField: string;
  indexedFields: Set<string>;
  endsWithFields: Set<string>;
  containsFields: Set<string>;
  blockBytes: number;
  /**
   * True once the user has chosen a sort field themselves. Until then, arriving at the sort step
   * re-seeds `sortField` from the measured recommendation, which only becomes meaningful after the
   * filter step — an explicit pick must never be silently overwritten by that.
   */
  sortFieldPicked: boolean;
  /** Type-to-filter query (ADR-0006 §5) — shared by the filter-fields and text-search steps, reset on stage change. */
  filterQuery: string;
  reviewJsonExpanded: boolean;
  persisted: boolean;
  quit: boolean;
}

export function createInitialState(data: WizardData): WizardState {
  const baseline = profileDataset(data.records, { sortField: data.recommendedSortField, fields: {} }, data.population);
  return {
    stage: 0,
    cursor: 0,
    sortField: data.recommendedSortField,
    indexedFields: new Set(data.recommendedIndexed),
    endsWithFields: new Set(),
    containsFields: new Set(),
    blockBytes: nearestChunkStep(recommendBlockBytes(baseline.p95RecordBytes)),
    sortFieldPicked: false,
    filterQuery: "",
    reviewJsonExpanded: false,
    persisted: false,
    quit: false,
  };
}

export type WizardKey =
  | { type: "up" }
  | { type: "down" }
  | { type: "left" }
  | { type: "right" }
  | { type: "space" }
  | { type: "enter" }
  | { type: "backspace" }
  | { type: "char"; value: string }
  | { type: "cancel" }
  | { type: "select-all" }
  | { type: "invert" };

function matchesQuery(name: string, query: string): boolean {
  return query === "" || name.toLowerCase().includes(query.toLowerCase());
}

/** Sort-field step's candidate list (ADR-0006 §2), narrowed by the type-to-filter query. */
function sortCandidateFields(data: WizardData, state: WizardState): WizardField[] {
  const byName = new Map(data.fields.map((f) => [f.name, f]));
  return data.sortCandidates
    .map((name) => byName.get(name)!)
    .filter((f) => matchesQuery(f.name, state.filterQuery));
}

/**
 * Filter-fields step's candidate list: every field except payload-only `json` fields — those hold
 * nested/mixed values that can't be indexed at all, so offering them would only let the user pick a
 * choice the config validator then rejects.
 *
 * The sort field is NOT excluded: this step now runs before the sort field is chosen, so there is
 * nothing meaningful to exclude, and hiding whichever field happened to be pre-seeded would drop it
 * from the list for no reason the user can see. Choosing it as the sort field later clears it from
 * this set (`clearFieldFromOptionalSets`), and `deriveWizardChoices` enforces that regardless of the
 * order the user visits steps in.
 */
function filterableFields(data: WizardData, state: WizardState): WizardField[] {
  return data.fields.filter((f) => f.kind !== "json" && matchesQuery(f.name, state.filterQuery));
}

export interface TextSearchRow {
  field: string;
  operator: "endsWith" | "contains";
}

/**
 * Text-search step's flat (field × operator) checklist (ADR-0006 §2) — one row per indexed,
 * non-sort, scalar-string field per operator; only those fields can carry `endsWith`/`contains`
 * (ADR-0003 §7). Recomputed from current state so toggling a field's indexed-ness on the previous
 * step immediately changes what's eligible here.
 */
function textSearchRows(data: WizardData, state: WizardState): TextSearchRow[] {
  const eligible = data.fields.filter(
    (f) => f.name !== state.sortField && state.indexedFields.has(f.name) && f.kind === "string" && !f.multi,
  );
  const rows: TextSearchRow[] = [];
  for (const f of eligible) rows.push({ field: f.name, operator: "endsWith" }, { field: f.name, operator: "contains" });
  return rows.filter((r) => matchesQuery(r.field, state.filterQuery));
}

/**
 * How many of the user's filter fields to measure locality against. The score is an average, so a
 * bounded sample estimates it closely, and this keeps the work flat when someone indexes 90 fields
 * (the metric is recomputed on every keypress). Deterministic — the candidate list is alphabetical.
 */
const LOCALITY_PROBE_FIELDS = 8;
/**
 * Above this measured share of data files per query, the sort field isn't buying locality for what
 * the user actually filters on — the exact situation that makes an otherwise well-configured build
 * read most of its own data on every query.
 */
const SCATTERED_SORT_FIELD_RATIO = 0.5;

/** What sorting by one candidate costs the user's chosen filters: the average, and the single best of them. */
export interface SortFieldLocality {
  /** Mean fraction of data files a query on the chosen filter fields would read. The ranking key. */
  mean: number;
  /** The cheapest single filter under this candidate — shown so the trade is visible, never ranked on. */
  best: { scatter: number; field: string };
}
/** Cap on bins used to model blocks; beyond this the extra resolution changes no ranking decision. */
const LOCALITY_MAX_BINS = 64;

/**
 * Fraction of data files a query on `field` would read, if records were range-partitioned by
 * `sortField`. Measured directly on the sampled records rather than guessed from field names: order
 * the sample by `sortField`, cut it into `bins` block-sized groups, then average — over `field`'s
 * distinct values — how many groups each value lands in. `1/bins` means perfect clustering (every
 * value in one file); `1.0` means a value is in every file, so the query reads everything.
 *
 * This is the same quantity a real build produces, at sample resolution: it is why sorting Scryfall
 * by `image_updated_at` scatters every card query across every block, and it needs no heuristic
 * about what a field is *called*.
 */
function scatterOf(
  records: Record<string, unknown>[],
  sortField: string,
  sortKind: SortKind,
  field: string,
  multi: boolean,
  bins: number,
): number | undefined {
  const ordered = [...records].sort((a, b) => compareSortValues(a[sortField], b[sortField], sortKind));
  const stats = new Map<string, { bins: Set<number>; count: number }>();
  ordered.forEach((record, i) => {
    const bin = Math.floor((i * bins) / ordered.length);
    for (const value of valuesOf(record, field, multi)) {
      if (value === null || value === undefined) continue;
      const key = typeof value === "string" ? value : JSON.stringify(value);
      let entry = stats.get(key);
      if (!entry) {
        entry = { bins: new Set(), count: 0 };
        stats.set(key, entry);
      }
      entry.bins.add(bin);
      entry.count++;
    }
  });
  if (stats.size === 0) return undefined;

  // A value occurring once sits in exactly one bin whatever the ordering, so a field whose values
  // never repeat cannot distinguish one sort field from another. It carries no signal and must not
  // dilute the average — identifier, UUID and URL columns are exactly this shape.
  let occurrences = 0;
  for (const { count } of stats.values()) occurrences += count;
  if (occurrences === stats.size) return undefined;

  // Occurrence-weighted, not a plain mean over distinct values: a query is far more likely to name a
  // common value than a rare one, and common values are the expensive ones. Averaging unweighted lets
  // a long tail of near-unique values (one artist with one card) hide how badly the frequent ones
  // scatter.
  let weighted = 0;
  for (const { bins: seen, count } of stats.values()) weighted += count * seen.size;
  return weighted / occurrences / bins;
}

/**
 * Per sort-field candidate, the average fraction of data files a query on the user's chosen filter
 * fields would read. Lower is better. A candidate the user also filters on scores near-perfectly on
 * its own contribution, so "prefer a field you query" falls out of the measurement instead of being
 * a special case bolted on top.
 */
/**
 * Memoizes the locality table, which is by far the most expensive thing `estimateForState` does (one
 * sort of the sample per candidate per probe field). It depends on nothing else in `WizardState` — not
 * the cursor, not the type-to-filter query, not the current sort field — so moving the cursor down a
 * list of 24 candidates recomputed an identical table 24 times. Keyed on identity of the record array
 * plus the inputs that actually change the answer.
 */
const localityCache = new Map<string, Record<string, SortFieldLocality>>();
const localityCacheKeys = new WeakMap<Record<string, unknown>[], number>();
let nextRecordsId = 0;

/** A stable id for a sample, so caches can key on it without hashing the records. */
function recordsId(data: WizardData): number {
  let id = localityCacheKeys.get(data.records);
  if (id === undefined) {
    id = nextRecordsId++;
    localityCacheKeys.set(data.records, id);
  }
  return id;
}

function localityCacheKey(data: WizardData, state: WizardState, bins: number): string {
  return `${recordsId(data)}|${bins}|${[...state.indexedFields].sort().join(",")}`;
}

export function sortFieldLocality(
  data: WizardData,
  state: WizardState,
  blockCount: number,
): Record<string, SortFieldLocality> {
  const bins = Math.max(2, Math.min(LOCALITY_MAX_BINS, blockCount, data.records.length));
  const cacheKey = localityCacheKey(data, state, bins);
  const cached = localityCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const byName = new Map(data.fields.map((f) => [f.name, f]));
  const probes = [...state.indexedFields]
    .sort()
    .slice(0, LOCALITY_PROBE_FIELDS)
    .map((name) => byName.get(name))
    .filter((f): f is WizardField => f !== undefined);
  if (probes.length === 0) {
    localityCache.set(cacheKey, {});
    return {};
  }

  const out: Record<string, SortFieldLocality> = {};
  for (const candidate of data.sortCandidates) {
    const kind = byName.get(candidate)!.kind as SortKind;
    const measured: { scatter: number; field: string }[] = [];
    for (const probe of probes) {
      const scatter = scatterOf(data.records, candidate, kind, probe.name, probe.multi, bins);
      if (scatter !== undefined) measured.push({ scatter, field: probe.name });
    }
    if (measured.length === 0) continue;

    // Rank on the MEAN across the user's filters, not the best of them. Sorting by S always clusters
    // S perfectly, so ranking on the best filter saturates: every candidate that is itself a selected
    // filter ties at the floor and the tiebreak decides instead. On real Scryfall data that handed the
    // recommendation to `artist` (915 distinct) over `set` (637) purely on cardinality, even though
    // sorting by `set` leaves artist queries at 39% while sorting by `artist` pushes set queries to
    // 47%. The mean is a uniform-query-frequency assumption — stated, not hidden — and it is the only
    // aggregation here that reflects total cost rather than one field's best case.
    const mean = measured.reduce((sum, m) => sum + m.scatter, 0) / measured.length;
    const best = measured.reduce((lo, m) => (m.scatter < lo.scatter ? m : lo));
    out[candidate] = { mean, best };
  }
  localityCache.set(cacheKey, out);
  return out;
}

/** Mean serialized size of a field's values — what one split-point costs in the always-downloaded manifest. */
function averageValueBytes(records: Record<string, unknown>[], field: string): number {
  let bytes = 0;
  let seen = 0;
  for (const record of records) {
    const value = record[field];
    if (value === null || value === undefined) continue;
    bytes += typeof value === "string" ? value.length : String(value).length;
    seen++;
  }
  return seen === 0 ? 0 : bytes / seen;
}

/**
 * The sort field to recommend once the user has said what they filter on. Ranked by measured
 * locality, with one guard ahead of it: a candidate whose value runs are long enough to trip
 * `lowCardinalitySortFieldWarning` blocks badly however well it clusters (equal-key runs stay
 * contiguous, ADR-0002 §6), so it loses to any candidate that doesn't. Falls back to the
 * kind-and-cardinality recommendation `init --yes` uses when nothing has been selected to measure
 * against.
 */
export function recommendedSortFieldFor(data: WizardData, state: WizardState, blockCount: number): string {
  const locality = sortFieldLocality(data, state, blockCount);
  const scored = data.sortCandidates.filter((name) => locality[name] !== undefined);
  if (scored.length === 0) return data.recommendedSortField;

  const byName = new Map(data.fields.map((f) => [f.name, f]));
  const skews = (name: string): boolean =>
    lowCardinalitySortFieldWarning(data.records.length, byName.get(name)!.cardinality) !== undefined;

  return scored.sort((a, b) => {
    if (skews(a) !== skews(b)) return skews(a) ? 1 : -1;
    if (locality[a]!.mean !== locality[b]!.mean) return locality[a]!.mean - locality[b]!.mean;
    // Equal locality happens for real: a field and a URL derived 1:1 from it partition identically
    // (`set` and `scryfall_set_uri` both have 1047 values on Scryfall). Prefer the cheaper one, because
    // split-points store the sort field's RAW values in the manifest every client downloads — measured
    // over 491 blocks, `set` costs 1.7 KB there and `scryfall_set_uri` 21.4 KB for the same pruning.
    const bytesDiff = averageValueBytes(data.records, a) - averageValueBytes(data.records, b);
    if (Math.abs(bytesDiff) > 0.5) return bytesDiff;
    const cardDiff = byName.get(b)!.cardinality - byName.get(a)!.cardinality;
    return cardDiff !== 0 ? cardDiff : a < b ? -1 : 1;
  })[0]!;
}

function clampCursor(cursor: number, length: number): number {
  if (length === 0) return 0;
  return ((cursor % length) + length) % length;
}

function enterStage(data: WizardData, state: WizardState, stage: number): WizardState {
  const next: WizardState = { ...state, stage, cursor: 0, filterQuery: "" };
  if (stage === 4) next.cursor = CHUNK_STEPS.indexOf(nearestChunkStep(state.blockBytes));
  // The measured recommendation only means anything once the filter step has been answered, so it is
  // applied on arrival at the sort step rather than up front — but never over an explicit pick.
  if (stage === SORT_STAGE && !state.sortFieldPicked) {
    next.sortField = recommendedSortFieldFor(data, state, estimateBlockCount(data.population.datasetBytes, state.blockBytes));
  }
  return next;
}

function clearFieldFromOptionalSets(state: WizardState, name: string): Pick<WizardState, "indexedFields" | "endsWithFields" | "containsFields"> {
  const indexedFields = new Set(state.indexedFields);
  const endsWithFields = new Set(state.endsWithFields);
  const containsFields = new Set(state.containsFields);
  indexedFields.delete(name);
  endsWithFields.delete(name);
  containsFields.delete(name);
  return { indexedFields, endsWithFields, containsFields };
}

/**
 * The wizard's pure reducer — every keypress goes through here, no I/O. Kept separate from the
 * terminal driver (`wizard-tui.ts`) so the whole interaction model (ADR-0006 §2) is unit-testable
 * without a real TTY: drive a sequence of keys, then assert on the resulting `WizardChoices`.
 */
export function applyKey(data: WizardData, state: WizardState, key: WizardKey): WizardState {
  if (key.type === "cancel") return { ...state, quit: true };
  if (key.type === "left") return state.stage > 0 ? enterStage(data, state, state.stage - 1) : state;
  if (key.type === "right") return state.stage < LAST_STAGE ? enterStage(data, state, state.stage + 1) : state;

  if (state.stage === 0) {
    return key.type === "enter" ? enterStage(data, state, FILTER_STAGE) : state;
  }

  if (state.stage === SORT_STAGE) {
    const candidates = sortCandidateFields(data, state);
    if (key.type === "up") return { ...state, cursor: clampCursor(state.cursor - 1, candidates.length) };
    if (key.type === "down") return { ...state, cursor: clampCursor(state.cursor + 1, candidates.length) };
    if (key.type === "space") {
      const picked = candidates[state.cursor];
      return picked
        ? { ...state, sortField: picked.name, sortFieldPicked: true, ...clearFieldFromOptionalSets(state, picked.name) }
        : state;
    }
    if (key.type === "char") return { ...state, filterQuery: state.filterQuery + key.value, cursor: 0 };
    if (key.type === "backspace") return { ...state, filterQuery: state.filterQuery.slice(0, -1), cursor: 0 };
    return state;
  }

  if (state.stage === FILTER_STAGE) {
    const candidates = filterableFields(data, state);
    if (key.type === "up") return { ...state, cursor: clampCursor(state.cursor - 1, candidates.length) };
    if (key.type === "down") return { ...state, cursor: clampCursor(state.cursor + 1, candidates.length) };
    if (key.type === "space") {
      const picked = candidates[state.cursor];
      if (!picked) return state;
      if (state.indexedFields.has(picked.name)) return { ...state, ...clearFieldFromOptionalSets(state, picked.name) };
      const indexedFields = new Set(state.indexedFields);
      indexedFields.add(picked.name);
      return { ...state, indexedFields };
    }
    // Both operate over the currently-visible (type-to-filter-narrowed) candidates, not the whole
    // field set — so filtering down to a subset then selecting-all/inverting acts on just that subset.
    if (key.type === "select-all") {
      const indexedFields = new Set(state.indexedFields);
      for (const f of candidates) indexedFields.add(f.name);
      return { ...state, indexedFields };
    }
    if (key.type === "invert") {
      const indexedFields = new Set(state.indexedFields);
      const endsWithFields = new Set(state.endsWithFields);
      const containsFields = new Set(state.containsFields);
      for (const f of candidates) {
        if (indexedFields.has(f.name)) {
          indexedFields.delete(f.name);
          endsWithFields.delete(f.name);
          containsFields.delete(f.name);
        } else {
          indexedFields.add(f.name);
        }
      }
      return { ...state, indexedFields, endsWithFields, containsFields };
    }
    if (key.type === "char") return { ...state, filterQuery: state.filterQuery + key.value, cursor: 0 };
    if (key.type === "backspace") return { ...state, filterQuery: state.filterQuery.slice(0, -1), cursor: 0 };
    return state;
  }

  if (state.stage === 3) {
    const rows = textSearchRows(data, state);
    if (key.type === "up") return { ...state, cursor: clampCursor(state.cursor - 1, rows.length) };
    if (key.type === "down") return { ...state, cursor: clampCursor(state.cursor + 1, rows.length) };
    if (key.type === "space") {
      const row = rows[state.cursor];
      if (!row) return state;
      const target = row.operator === "endsWith" ? "endsWithFields" : "containsFields";
      const set = new Set(state[target]);
      set.has(row.field) ? set.delete(row.field) : set.add(row.field);
      return { ...state, [target]: set };
    }
    // Like stage 2, both act on the currently-visible (query-narrowed) rows. Rows here are
    // (field × operator) pairs, so narrowing to one field then selecting-all enables both of that
    // field's operators — and selecting all with no query on enables every operator everywhere,
    // which the live per-row cost and the `contains`-exceeds-column warning are there to price.
    if (key.type === "select-all" || key.type === "invert") {
      const endsWithFields = new Set(state.endsWithFields);
      const containsFields = new Set(state.containsFields);
      for (const row of rows) {
        const set = row.operator === "endsWith" ? endsWithFields : containsFields;
        if (key.type === "select-all") set.add(row.field);
        else if (set.has(row.field)) set.delete(row.field);
        else set.add(row.field);
      }
      return { ...state, endsWithFields, containsFields };
    }
    if (key.type === "char") return { ...state, filterQuery: state.filterQuery + key.value, cursor: 0 };
    if (key.type === "backspace") return { ...state, filterQuery: state.filterQuery.slice(0, -1), cursor: 0 };
    return state;
  }

  if (state.stage === 4) {
    if (key.type === "up" || key.type === "down") {
      const cursor = Math.max(0, Math.min(CHUNK_STEPS.length - 1, state.cursor + (key.type === "up" ? -1 : 1)));
      return { ...state, cursor, blockBytes: CHUNK_STEPS[cursor]! };
    }
    return state;
  }

  // stage 5 — review
  if (key.type === "space") return { ...state, reviewJsonExpanded: !state.reviewJsonExpanded };
  if (key.type === "enter") return { ...state, persisted: true };
  return state;
}

export interface WizardChoices {
  sortField: string;
  indexedFields: string[];
  endsWithFields: string[];
  containsFields: string[];
  blockBytes: number;
}

/**
 * Translates wizard state into the exact flags `init`'s non-interactive core (`--yes` + flags)
 * accepts (ADR-0006 §1: "the wizard is flag-equivalent to `init --yes`"). `wizard-tui.ts` feeds this
 * straight into `init()` on persist — there is no separate config-writing code path to drift.
 */
export function deriveWizardChoices(state: WizardState): WizardChoices {
  return {
    sortField: state.sortField,
    // The sort field is queryable by virtue of being sorted (ADR-0002 §2), so it never needs to
    // appear in the explicit indexed set. Enforced here rather than only at pick time, so no
    // navigation order (check it at the filter step, then choose it as sort field, then go back and
    // re-check it) can leak a redundant `indexed: true` into the written config.
    indexedFields: [...state.indexedFields].filter((name) => name !== state.sortField),
    endsWithFields: [...state.endsWithFields],
    containsFields: [...state.containsFields],
    blockBytes: state.blockBytes,
  };
}

function forcedIndexedFieldConfigs(data: WizardData, sortField: string): Record<string, FieldConfig> {
  const out: Record<string, FieldConfig> = {};
  for (const f of data.fields) {
    if (f.name === sortField) continue;
    out[f.name] = { kind: f.kind, indexed: true, ...(f.multi ? { multi: true } : {}) };
  }
  return out;
}

export interface WizardEstimate {
  costs: CostEstimate;
  warnings: string[];
  /** Per sort-field candidate, the measured cost of the user's filters under that choice. */
  locality: Record<string, SortFieldLocality>;
  masterProfile: DatasetProfile;
  /**
   * Per filterable field, the estimated share of data files its average value sits in under the
   * current sort field — the build's "barely prunes" number, predicted from the sample (#31). Empty
   * below the block count where that ratio means anything.
   */
  blockShare: Record<string, number>;
  /** What enabling `endsWith`/`contains` on a field WOULD cost, independent of whether it's toggled on yet — the text-search step's live preview (ADR-0006 §2/§3). */
  probeIndex(name: string, opts: { endsWith?: boolean; contains?: boolean }): IndexSizeEstimate;
}

/**
 * The live estimate for the current wizard state (ADR-0006 §3): re-profiles every field as if
 * indexed once per call (cheap — the wizard samples, it doesn't full-scan by default) so toggling
 * the indexed/endsWith/contains sets is a plain filter over already-computed per-field stats, not a
 * re-scan of the records.
 */
/**
 * Memoizes the whole estimate. It is a pure function of five state fields — the sort field, the three
 * operator sets, and the block-byte target — and of nothing else the user can touch: not the cursor,
 * not the type-to-filter query, not the stage. Since `renderFrame` needs an estimate on every
 * keypress, without this every arrow-key press re-profiled the sample and re-derived every index size
 * to produce a byte-identical answer.
 */
const estimateCache = new Map<string, WizardEstimate>();

function estimateCacheKey(data: WizardData, state: WizardState): string {
  const set = (values: Set<string>) => [...values].sort().join(",");
  return [
    localityCacheKey(data, state, 0),
    state.sortField,
    state.blockBytes,
    set(state.indexedFields),
    set(state.endsWithFields),
    set(state.containsFields),
  ].join("|");
}

export function estimateForState(data: WizardData, state: WizardState): WizardEstimate {
  const cacheKey = estimateCacheKey(data, state);
  const cached = estimateCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const computed = computeEstimateForState(data, state);
  estimateCache.set(cacheKey, computed);
  return computed;
}

/** Memoizes `blockSharesFor`, which depends only on the sample, the sort field and the block count. */
const blockShareCache = new Map<string, Record<string, number>>();

function blockSharesFor(data: WizardData, sortField: string, blockCount: number): Record<string, number> {
  if (blockCount < MIN_BLOCKS_FOR_SELECTIVITY) return {};
  const cacheKey = `${recordsId(data)}|${sortField}|${blockCount}`;
  const cached = blockShareCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const sortKind = data.fields.find((f) => f.name === sortField)?.kind as SortKind;
  const estimator = new BlockShareEstimator(data.pruneRecords ?? data.records, sortField, sortKind, data.recordCount, blockCount);
  const out: Record<string, number> = {};
  for (const f of data.fields) {
    if (f.name === sortField || f.kind === "json") continue;
    const share = estimator.meanShare(f.name, f.multi, f.cardinality);
    if (share !== undefined) out[f.name] = share;
  }
  blockShareCache.set(cacheKey, out);
  return out;
}

function computeEstimateForState(data: WizardData, state: WizardState): WizardEstimate {
  const forced = forcedIndexedFieldConfigs(data, state.sortField);
  const masterProfile = profileDataset(data.records, { sortField: state.sortField, fields: forced }, data.population);

  const currentFields: Record<string, FieldConfig> = {};
  const selectedProfileFields: DatasetProfile["fields"] = {};
  for (const f of data.fields) {
    if (f.name === state.sortField) continue;
    currentFields[f.name] = {
      kind: f.kind,
      indexed: state.indexedFields.has(f.name),
      ...(f.multi ? { multi: true } : {}),
      ...(state.endsWithFields.has(f.name) ? { endsWith: true } : {}),
      ...(state.containsFields.has(f.name) ? { contains: true } : {}),
    };
    if (state.indexedFields.has(f.name)) {
      const profile = masterProfile.fields[f.name];
      if (profile) selectedProfileFields[f.name] = profile;
    }
  }

  const costs = estimateCosts(
    { ...masterProfile, fields: selectedProfileFields },
    currentFields,
    { blockBytes: state.blockBytes, indexChunkBytes: DEFAULT_INDEX_CHUNK_BYTES },
  );

  // `skewedBlocksWarning` (warnings.ts) isn't wired in here: it reads real cut `BlockDescriptor[]`
  // bytes, which only exist post-`build`/`inspect` materialization. Pre-build, `warnings.ts`'s own
  // skew message names the same two root causes surfaced below (an equal-key sort-field pileup, or
  // an oversized record) — this is the upstream, estimate-time view of the same phenomenon, not a
  // missing warning category.
  const warnings: string[] = [];
  // Compare at SAMPLE scale: `sortFieldCardinality` is sampled, so the ratio must use the sample
  // size, not the true total (mixing scales would fire a spurious low-cardinality warning).
  const lowCard = lowCardinalitySortFieldWarning(data.records.length, masterProfile.sortFieldCardinality);
  if (lowCard) warnings.push(lowCard);
  const oversized = oversizedRecordWarning(masterProfile.maxRecordBytes, state.blockBytes);
  if (oversized) warnings.push(oversized);
  // Measured on the sampled records, so it says what THIS data does rather than guessing from names.
  const locality = sortFieldLocality(data, state, costs.blockCount);
  const sortLocality = locality[state.sortField];
  if (sortLocality !== undefined && sortLocality.mean > SCATTERED_SORT_FIELD_RATIO) {
    const best = recommendedSortFieldFor(data, state, costs.blockCount);
    const alternative = locality[best];
    warnings.push(
      `zonedb: sorting by "${state.sortField}" scatters the fields you filter on — a typical query would read ` +
        `about ${Math.round(sortLocality.mean * 100)}% of your data files ` +
        `(best case, filtering on "${sortLocality.best.field}": ${Math.round(sortLocality.best.scatter * 100)}%). ` +
        (best !== state.sortField && alternative !== undefined
          ? `Sorting by "${best}" would average about ${Math.round(alternative.mean * 100)}% instead.`
          : `Some fields cannot be helped by any sort field — only one dimension can be clustered.`),
    );
  }
  // The build's "barely prunes" warning, predicted, so a useless index is visible before it's built.
  const blockShare = blockSharesFor(data, state.sortField, costs.blockCount);
  for (const f of data.fields) {
    if (!state.indexedFields.has(f.name) || f.multi || blockShare[f.name] === undefined) continue;
    const unselective = unselectiveIndexWarning(f.name, blockShare[f.name]! * costs.blockCount, costs.blockCount);
    if (unselective) warnings.push(unselective);
  }
  // Structural, so it lands the moment the box is ticked rather than after a build.
  const byField = new Map(data.fields.map((f) => [f.name, f]));
  for (const [operator, selected] of [
    ["endsWith", state.endsWithFields],
    ["contains", state.containsFields],
  ] as const) {
    for (const field of selected) {
      const unsuitable = unsuitableTextIndexWarning(field, operator, byField.get(field)?.shape ?? "text");
      if (unsuitable) warnings.push(unsuitable);
    }
  }
  for (const [name, idx] of Object.entries(costs.indexes)) {
    if (idx.containsExceedsColumn) {
      warnings.push(
        `zonedb: "${name}"'s contains index would be bigger than the field's own data — usually not worth it (ADR-0003 §7).`,
      );
    }
  }

  function probeIndex(name: string, opts: { endsWith?: boolean; contains?: boolean }): IndexSizeEstimate {
    const profile = masterProfile.fields[name];
    if (!profile) return { baseBytes: 0, baseChunks: 0 };
    return estimateIndexSize(profile, costs.blockCount, { indexChunkBytes: DEFAULT_INDEX_CHUNK_BYTES, ...opts });
  }

  return { costs, warnings, locality, masterProfile, blockShare, probeIndex };
}

// ---------------------------------------------------------------------------
// Rendering — pure string-building (ADR-0006 §4: dep-light, hand-rolled ANSI).
// ---------------------------------------------------------------------------

const ESC = "\x1b[";
const ANSI = {
  reset: `${ESC}0m`,
  bold: `${ESC}1m`,
  dim: `${ESC}2m`,
  inverse: `${ESC}7m`,
  red: `${ESC}31m`,
  green: `${ESC}32m`,
  yellow: `${ESC}33m`,
  cyan: `${ESC}36m`,
};

function bold(s: string): string {
  return ANSI.bold + s + ANSI.reset;
}
function dim(s: string): string {
  return ANSI.dim + s + ANSI.reset;
}
function color(code: string, s: string): string {
  return code + s + ANSI.reset;
}
function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}
function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

/** Overlays a single highlight on an otherwise-plain row — kept to one color per row so nested ANSI resets never clobber each other (a real terminal concern the /prototype hit too). */
function renderRow(plain: string, opts: { cursor: boolean; danger?: boolean }): string {
  if (opts.cursor) return color(ANSI.inverse, stripAnsi(plain));
  if (opts.danger) return color(ANSI.red, stripAnsi(plain));
  return plain;
}

function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${Math.round(bytes)}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

const BAR_WIDTH = 18;

/**
 * A how-full-is-the-budget meter for the first-download axis (ADR-0006 §3) — the number alone makes
 * "113B of a 976.6KB comfort limit" hard to feel at a glance, where a bar reads instantly. Filled
 * portion is clamped to the width, so going over budget renders a full bar rather than overflowing
 * the line; the bar carries the same green/over-budget-yellow signal as the figure it annotates.
 */
function budgetBar(filled: number, total: number, overBudget: boolean): string {
  const cells = Math.max(0, Math.min(BAR_WIDTH, Math.round((filled / total) * BAR_WIDTH)));
  return color(overBudget ? ANSI.yellow : ANSI.green, "█".repeat(cells)) + dim("░".repeat(BAR_WIDTH - cells));
}
function fmtInt(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

/** Assumed terminal height when the real one isn't reported (e.g. not a TTY, or under test). */
const DEFAULT_TERMINAL_ROWS = 24;
/** Never render a list window this small, even on a tiny/unreported terminal. */
const MIN_VISIBLE_ROWS = 3;
/** `renderFrame`'s own chrome above every stage's body: the title line, the crumbs line, and the blank line before the body starts. */
const FRAME_CHROME_ROWS = 3;

/**
 * How many list rows a stage can show given the terminal's real height (ADR-0006 §5: "show as many
 * options at once as the screen can fit," not a fixed page size) minus everything else that stage
 * is about to render around the list — computed by each render function from its own known
 * chrome-line count, not guessed here.
 */
function visibleRowsFor(terminalRows: number | undefined, chromeLines: number): number {
  const rows = terminalRows ?? DEFAULT_TERMINAL_ROWS;
  return Math.max(MIN_VISIBLE_ROWS, rows - FRAME_CHROME_ROWS - chromeLines);
}

/** ADR-0006 §5: scrollable list — a window centered on the cursor, sized to fill the terminal rather than a fixed page. */
function windowed<T>(items: T[], cursor: number, visibleRows: number): { items: T[]; offset: number } {
  if (items.length <= visibleRows) return { items, offset: 0 };
  const half = Math.floor(visibleRows / 2);
  const offset = Math.max(0, Math.min(items.length - visibleRows, cursor - half));
  return { items: items.slice(offset, offset + visibleRows), offset };
}

/**
 * ADR-0006 §3: the plain-language consequence axes, jargon-free ("no zonemap/postings on screen"),
 * as named blocks rather than one flat array — so each step picks the axes relevant to what it just
 * changed by name, not by a positional slice that silently breaks if a block gains/loses a line.
 */
interface EstimateAxes {
  dataFiles: string[];
  firstDownload: string[];
  perQuery: string[];
  extraIndexes: string[];
}

function estimateAxes(costs: CostEstimate): EstimateAxes {
  const dataFiles = [
    bold("  Data files") + dim("  your data, split into many small files"),
    `    ${color(ANSI.cyan, fmtInt(costs.blockCount) + " files")} ${dim("about " + fmtInt(costs.recordsPerBlock) + " records each")}`,
  ];

  const firstDownload = [
    bold("  First download") + dim("  everyone loads this once, before any query"),
    `    ${color(costs.manifest.overBudget ? ANSI.yellow : ANSI.green, fmtBytes(costs.manifest.gzipBytes))} ${dim("of a " + fmtBytes(MANIFEST_BUDGET_BYTES) + " comfort limit")}  ${budgetBar(costs.manifest.gzipBytes, MANIFEST_BUDGET_BYTES, costs.manifest.overBudget)}`,
  ];

  const perQuery = [bold("  Download per query") + dim("  what a typical query pulls down")];
  if (costs.perQuery.equality) {
    perQuery.push(
      `    filter by exact value: ${color(ANSI.cyan, fmtBytes(costs.perQuery.equality.bytes))} in ${costs.perQuery.equality.requests} request(s)`,
    );
  }
  perQuery.push(
    `    filter by a range: ${color(ANSI.cyan, fmtBytes(costs.perQuery.range.bytes))} in ${costs.perQuery.range.requests} request(s)`,
  );

  const extraBytes = Object.values(costs.indexes).reduce(
    (sum, i) => sum + i.baseBytes + (i.reversedBytes ?? 0) + (i.trigramBytes ?? 0),
    0,
  );
  const extraIndexes = [
    bold("  Extra search indexes") + dim("  load only when a query actually uses them") + `  ${color(ANSI.cyan, fmtBytes(extraBytes))}`,
  ];

  return { dataFiles, firstDownload, perQuery, extraIndexes };
}

function allEstimateLines(costs: CostEstimate): string[] {
  const axes = estimateAxes(costs);
  return [...axes.dataFiles, ...axes.firstDownload, ...axes.perQuery, ...axes.extraIndexes];
}

function renderDetect(data: WizardData): string[] {
  const lines = [bold(`Detected ${fmtInt(data.recordCount)} record(s), ${fmtInt(data.fields.length)} field(s).`), ""];
  lines.push(dim("  field                  type      cardinality   role"));
  for (const f of data.fields) {
    const role =
      // Checked first: a json field is never a sort-field/multi candidate, and "payload-only" is
      // the one thing worth saying about it — it explains why later steps won't offer it.
      f.kind === "json"
        ? dim("payload-only — not filterable")
        : f.name === data.recommendedPk
          ? color(ANSI.green, "PK guess")
          : f.name === data.recommendedSortField
            ? color(ANSI.cyan, "sort field guess")
            : f.multi
              ? color(ANSI.cyan, "multi-valued")
              : "";
    lines.push(`  ${pad(f.name, 22)} ${pad(f.kind, 9)} ${pad(fmtInt(f.cardinality), 13)} ${role}`);
  }
  lines.push("", color(ANSI.cyan, "  [Enter] looks right, continue →"));
  return lines;
}

function renderSortField(data: WizardData, state: WizardState, estimate: WizardEstimate, terminalRows?: number): string[] {
  const candidates = sortCandidateFields(data, state);
  const header = [
    bold("Pick ONE field to sort by."),
    // Lead with locality, not the operator set: this choice decides what every query costs, and
    // reading it as an incidental "which order do you want" is how a maintenance timestamp wins.
    dim("  This decides which records are stored next to each other — the biggest lever on query cost."),
    dim("  Filters on this field read a few files; filters on anything else may read most of them."),
    dim("  Pick what you filter or sort by most. Text fields also get starts-with here for free."),
    ...(Object.keys(estimate.locality).length > 0
      ? [dim("  Measured on your data: average share of it your filters would read, assuming you use them equally.")]
      : []),
    "",
  ];
  const filterLine = state.filterQuery ? [dim(`  filter: "${state.filterQuery}"`), ""] : [];
  const noMatchLine = candidates.length === 0 ? [dim("  no matching fields")] : [];
  const footer = ["", ...estimateAxes(estimate.costs).dataFiles, "", dim("  [↑/↓] move  [space] choose  [type] filter  [←/→] change step")];
  const chromeLines = header.length + filterLine.length + noMatchLine.length + footer.length;

  // Mark the MEASURED best candidate, not a fixed guess: the recommendation reacts to whatever the
  // user selected on the filter step, which is the only thing that makes locality meaningful.
  const best = recommendedSortFieldFor(data, state, estimate.costs.blockCount);
  const { items, offset } = windowed(candidates, state.cursor, visibleRowsFor(terminalRows, chromeLines));
  const rows = items.map((f, i) => {
    const idx = offset + i;
    const selected = f.name === state.sortField;
    const marker = selected ? color(ANSI.green, "◉") : "○";
    const rec = f.name === best ? color(ANSI.green, " ★ recommended") : "";
    // The consequence, measured on the user's own data rather than asserted: what share of the data
    // files a query on their chosen filter fields would have to read under this sort field.
    const measured = estimate.locality[f.name];
    const cost =
      measured === undefined
        ? dim(pad(f.kind + " · " + fmtInt(f.cardinality) + " distinct", 44))
        : dim(
            pad(
              `${f.kind} · ~${Math.round(measured.mean * 100)}% avg · best ${measured.best.field} ${Math.round(measured.best.scatter * 100)}%`,
              44,
            ),
          );
    const plain = `  ${marker} ${pad(f.name, 22)} ${cost}${rec}`;
    return renderRow(plain, { cursor: idx === state.cursor });
  });

  return [...header, ...filterLine, ...rows, ...noMatchLine, ...footer];
}

function renderFilterFields(data: WizardData, state: WizardState, estimate: WizardEstimate, terminalRows?: number): string[] {
  const candidates = filterableFields(data, state);
  // Payload-only fields are absent from the list by construction — say so, or their absence just
  // looks like the wizard lost them.
  const payloadOnlyCount = data.fields.filter((f) => f.kind === "json").length;
  const header = [
    bold("Which filters need to be fast?"),
    dim("  Every field stays filterable. The ones you pick get an index, so a filter on them narrows which files a query reads."),
    dim("  Each adds a little to the first download, plus an index that loads only when a query uses it."),
    ...(payloadOnlyCount > 0
      ? [
          dim(
            `  ${fmtInt(payloadOnlyCount)} field(s) hold nested or mixed values — stored and returned, but not filterable, so they aren't listed.`,
          ),
        ]
      : []),
    "",
  ];
  const filterLine = state.filterQuery ? [dim(`  filter: "${state.filterQuery}"`), ""] : [];
  const noMatchLine = candidates.length === 0 ? [dim("  no matching fields")] : [];
  const footer = [
    "",
    ...estimateAxes(estimate.costs).firstDownload,
    "",
    dim("  [↑/↓] move  [space] toggle  [ctrl+a] select all  [tab] invert  [type] filter  [←/→] change step"),
  ];
  const chromeLines = header.length + filterLine.length + noMatchLine.length + footer.length;

  const { items, offset } = windowed(candidates, state.cursor, visibleRowsFor(terminalRows, chromeLines));
  const rows = items.map((f, i) => {
    const idx = offset + i;
    const on = state.indexedFields.has(f.name);
    const box = on ? color(ANSI.green, "[x]") : dim("[ ]");
    const idxEstimate = estimate.costs.indexes[f.name];
    const cost = on && idxEstimate ? dim(`index loads on use: ${fmtBytes(idxEstimate.baseBytes)}`) : dim("not indexed");
    // A list field can't go unindexed, so there's no choice to inform.
    const share = f.multi ? undefined : estimate.blockShare[f.name];
    const prunes =
      share !== undefined && share > UNSELECTIVE_POSTINGS_RATIO
        ? "  " + color(ANSI.yellow, `barely prunes: in ~${Math.round(share * 100)}% of files`)
        : "";
    const plain = `  ${box} ${pad(f.name, 22)} ${cost}${prunes}`;
    return renderRow(plain, { cursor: idx === state.cursor });
  });

  return [...header, ...filterLine, ...rows, ...noMatchLine, ...footer];
}

function renderTextSearch(data: WizardData, state: WizardState, estimate: WizardEstimate, terminalRows?: number): string[] {
  const allRows = textSearchRows(data, state);
  const header = [
    bold("Extra ways to search text"),
    dim('  Exact match, "is one of", and starts-with are already on for every indexed text field.'),
    dim("  These add more, each with an extra index that loads only when it's used."),
    dim("  Matching is case-sensitive: on Title Case data, contains \"bolt\" finds nothing, \"Bolt\" works."),
    dim("  Skip these for ID, UUID and URL fields — their substrings sit in every file, so they can't narrow anything down."),
    "",
  ];
  const filterLine = state.filterQuery ? [dim(`  filter: "${state.filterQuery}"`), ""] : [];
  const noMatchLine = allRows.length === 0 ? [dim("  no indexed text fields yet — go back and index one first")] : [];
  const footer = [
    "",
    ...estimateAxes(estimate.costs).extraIndexes,
    "",
    dim("  [↑/↓] move  [space] toggle  [ctrl+a] select all  [tab] invert  [type] filter  [←/→] change step"),
  ];
  const chromeLines = header.length + filterLine.length + noMatchLine.length + footer.length;

  const { items, offset } = windowed(allRows, state.cursor, visibleRowsFor(terminalRows, chromeLines));
  const rows = items.map((row, i) => {
    const idx = offset + i;
    const on = row.operator === "endsWith" ? state.endsWithFields.has(row.field) : state.containsFields.has(row.field);
    const box = on ? color(ANSI.green, "[x]") : dim("[ ]");
    let costText: string;
    let danger = false;
    if (row.operator === "endsWith") {
      const probe = estimate.probeIndex(row.field, { endsWith: true });
      costText = `adds ${fmtBytes(probe.reversedBytes ?? 0)}`;
    } else {
      const probe = estimate.probeIndex(row.field, { contains: true });
      danger = probe.containsExceedsColumn === true;
      costText = danger
        ? `adds ${fmtBytes(probe.trigramBytes ?? 0)} — bigger than the data!`
        : `adds ${fmtBytes(probe.trigramBytes ?? 0)}`;
    }
    const label = row.operator === "endsWith" ? "ends with" : "contains";
    const plain = `  ${box} ${pad(row.field, 18)} ${pad(label, 10)} ${dim(costText)}`;
    return renderRow(plain, { cursor: idx === state.cursor, danger });
  });

  return [...header, ...filterLine, ...rows, ...noMatchLine, ...footer];
}

function renderFileSize(state: WizardState, estimate: WizardEstimate): string[] {
  const lines = [
    bold("How big should each data file be?"),
    dim("  Smaller files waste less bandwidth per query but need more requests. Bigger files are the opposite."),
    "",
  ];
  CHUNK_STEPS.forEach((step, i) => {
    const fileCount = estimateBlockCount(estimate.masterProfile.datasetBytes, step);
    const marker = step === state.blockBytes ? color(ANSI.green, "◆") : " ";
    const plain = `  ${marker} ${pad(fmtBytes(step), 8)} → ${fmtInt(fileCount)} file(s)`;
    lines.push(renderRow(plain, { cursor: i === state.cursor }));
  });
  lines.push("", ...allEstimateLines(estimate.costs));
  lines.push("", dim("  [↑/↓] pick a size  [←/→] change step"));
  return lines;
}

/**
 * `configPreview`, when the JSON is expanded, must be the *exact* JSON `init()` would write for the
 * current choices — computed by `wizard-tui.ts` via `resolveInitConfig` (the same resolution logic
 * persist calls), not reconstructed here. `wizard.ts` stays I/O-free, so it renders whatever string
 * it's handed rather than building its own second, possibly-divergent approximation of the config.
 */
function renderReview(state: WizardState, estimate: WizardEstimate, configPreview?: string): string[] {
  const choices = deriveWizardChoices(state);
  const lines = [bold("Review"), ""];
  lines.push(
    `  Sorted by ${bold(choices.sortField)} — ${fmtInt(estimate.costs.blockCount)} file(s), about ${fmtInt(estimate.costs.recordsPerBlock)} records each`,
  );
  lines.push(`  Filterable fields: ${choices.indexedFields.length ? choices.indexedFields.join(", ") : dim("none")}`);
  const extraOps = [
    ...choices.endsWithFields.map((f) => `${f} (ends with)`),
    ...choices.containsFields.map((f) => `${f} (contains)`),
  ];
  lines.push(`  Extra text search: ${extraOps.length ? extraOps.join(", ") : dim("none")}`);
  lines.push(`  File size target: ${fmtBytes(choices.blockBytes)}`);
  lines.push("");
  if (estimate.warnings.length === 0) {
    lines.push(dim("  no warnings — config within budget"));
  } else {
    lines.push(bold("  Warnings"));
    for (const w of estimate.warnings) lines.push(`${color(ANSI.yellow, "  ▲ ")}${w}`);
  }
  lines.push("");
  lines.push(dim(state.reviewJsonExpanded ? "  [space] hide config preview" : "  [space] preview config (collapsed)"));
  if (state.reviewJsonExpanded) {
    const preview = configPreview ?? "(computing preview…)";
    lines.push("", ...preview.split("\n").map((l) => "  " + dim(l)));
  }
  lines.push("", color(ANSI.cyan, "  [Enter] write zonedb.config.json") + dim("   [←] back"));
  return lines;
}

/**
 * The whole rendered frame for one keystroke — `wizard-tui.ts` clears the screen and writes this
 * each time. `configPreview`, if given, is only used on the review stage (see `renderReview`).
 * `terminalRows`, if given, sizes each step's scrollable list to fill the real terminal height
 * (ADR-0006 §5) instead of a fixed page size — falls back to `DEFAULT_TERMINAL_ROWS` when omitted
 * (not a TTY, or under test).
 */
export function renderFrame(
  data: WizardData,
  state: WizardState,
  estimate: WizardEstimate,
  configPreview?: string,
  terminalRows?: number,
): string {
  const crumbs = STAGE_LABELS.map((label, i) =>
    i === state.stage ? color(ANSI.inverse, ` ${i + 1} ${label} `) : dim(` ${i + 1} ${label} `),
  ).join(dim("→"));
  const header = `${bold(color(ANSI.cyan, "zonedb init"))}\n${crumbs}\n`;

  let body: string[];
  switch (state.stage) {
    case 0:
      body = renderDetect(data);
      break;
    case FILTER_STAGE:
      body = renderFilterFields(data, state, estimate, terminalRows);
      break;
    case SORT_STAGE:
      body = renderSortField(data, state, estimate, terminalRows);
      break;
    case 3:
      body = renderTextSearch(data, state, estimate, terminalRows);
      break;
    case 4:
      body = renderFileSize(state, estimate);
      break;
    default:
      body = renderReview(state, estimate, configPreview);
      break;
  }
  return `${header}\n${body.join("\n")}\n`;
}
