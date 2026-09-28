import { SORTABLE_KINDS, type SortableKind } from "./config.js";
import type { OnProgress } from "./progress.js";
import type { FieldKind } from "./types.js";
import { UNSELECTIVE_POSTINGS_RATIO } from "./warnings.js";

/** ISO-8601 date/date-time, e.g. "1999-03-31" or "2000-05-05T00:00:00Z" (ADR-0001: date = string + isDate). */
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?)?$/;

/** Field names that look like an identifier, for the pk-recommendation naming heuristic. */
const ID_LIKE_NAME_RE = /(^_?id$)|([._-]?id$)/i;

/** ADR-0006 §5: `init` recommends a *small* default indexed set, not opt-out-of-everything. */
const DEFAULT_MAX_INDEXED = 3;

/**
 * Average records per distinct value below which a field stops behaving like a facet and starts
 * behaving like an identifier. Keeps the default indexed set on fields that actually group records:
 * on 116k Scryfall cards this admits `type_line`, `artist` and `set` while excluding near-unique
 * columns whose index would hold roughly one entry per record.
 */
const MIN_RECORDS_PER_FACET_VALUE = 10;
/** Below this many records the facet band is meaningless (a ratio of a handful rounds to nothing), so only uniqueness is judged. */
const MIN_RECORDS_FOR_FACET_BAND = 100;

/**
 * A string field with at most this many distinct values is treated as enum-like, and its values are
 * baked into the config so codegen can emit a value union (MTG colours, a rarity, a status).
 * Deliberately conservative: it should catch closed sets and miss fields that merely *happen* to be
 * small right now — a set code (dozens, grows every release) or an artist name must stay wide, since
 * a union narrows `equals`/`in`/`some` and a stale one rejects a legitimate query.
 */
export const MAX_ENUM_VALUES = 16;

/**
 * What a field's values LOOK like, independent of how many there are. Used to warn about text indexes
 * that cannot work before one is built, complementing the build's measured "barely prunes" check —
 * this is structural and available at choice time, that one is empirical and only available after.
 */
export type ValueShape = "url" | "uuid" | "text";

/** Any scheme-prefixed URI, not just http(s). */
const URL_SHAPE_RE = /^[a-z][a-z0-9+.-]*:\/\//i;
const UUID_SHAPE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Share of sampled values that must match for the shape to be claimed — a stray outlier shouldn't hide it. */
const SHAPE_MAJORITY = 0.9;

/** Counts how many string values look like URLs or UUIDs, to name the field's `ValueShape`. */
class ShapeCounter {
  private strings = 0;
  private urls = 0;
  private uuids = 0;

  add(value: string): void {
    this.strings++;
    if (URL_SHAPE_RE.test(value)) this.urls++;
    else if (UUID_SHAPE_RE.test(value)) this.uuids++;
  }

  shape(): ValueShape {
    if (this.strings === 0) return "text";
    if (this.urls >= this.strings * SHAPE_MAJORITY) return "url";
    if (this.uuids >= this.strings * SHAPE_MAJORITY) return "uuid";
    return "text";
  }
}

/**
 * Distinct values a field may hold before its count switches from exact to estimated. Below it,
 * inference is exact — every dataset up to a million records infers exactly as it would with the whole
 * input in memory. Above it, memory would otherwise grow with the data, which is what inference over
 * an input too big to hold can't afford (#29).
 */
export const EXACT_DISTINCT_MAX = 1_000_000;

/** HyperLogLog precision: 2^14 registers, 16 KB per counter, standard error 1.04/√2^14 ≈ 0.8%. */
const HLL_BITS = 14;
const HLL_REGISTERS = 1 << HLL_BITS;
/** Three standard errors: how far below the record count an estimate may sit and still read as "all distinct". */
const HLL_UNIQUE_TOLERANCE = (3 * 1.04) / Math.sqrt(HLL_REGISTERS);

/** cyrb53: a fast, well-mixed 53-bit string hash (public domain). 53 bits keeps collisions negligible at a million values. */
function hash53(str: string): number {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/** An open-addressing set of 53-bit hashes in one Float64Array — 16 bytes a value, against ~70 for a `Set<string>`. */
class HashSet53 {
  private table = new Float64Array(1024);
  size = 0;

  /** Adds `h`; false if it was already present. */
  add(h: number): boolean {
    const key = h === 0 ? 1 : h; // 0 marks an empty slot
    if ((this.size + 1) * 2 > this.table.length) this.grow();
    return this.insert(this.table, key);
  }

  has(h: number): boolean {
    const key = h === 0 ? 1 : h;
    const table = this.table;
    const mask = table.length - 1;
    for (let i = (key >>> 0) & mask; ; i = (i + 1) & mask) {
      if (table[i] === 0) return false;
      if (table[i] === key) return true;
    }
  }

  private insert(table: Float64Array, key: number): boolean {
    const mask = table.length - 1;
    for (let i = (key >>> 0) & mask; ; i = (i + 1) & mask) {
      if (table[i] === 0) {
        table[i] = key;
        if (table === this.table) this.size++;
        return true;
      }
      if (table[i] === key) return false;
    }
  }

  private grow(): void {
    const old = this.table;
    const next = new Float64Array(old.length * 2);
    for (const key of old) if (key !== 0) this.insert(next, key);
    this.table = next;
  }
}

/**
 * Counts a field's distinct values in bounded memory: exactly (by 53-bit hash) up to
 * `EXACT_DISTINCT_MAX`, then by HyperLogLog estimate. The exact set is kept, frozen, past the cap, so a
 * later repeat of any of the first million values still proves the field isn't unique.
 */
class DistinctCounter {
  constructor(private readonly exactMax: number) {}

  private readonly exact = new HashSet53();
  private readonly registers = new Uint8Array(HLL_REGISTERS);
  private overflowed = false;
  private sawRepeat = false;
  private added = 0;

  add(key: string): void {
    this.added++;
    const h = hash53(key);

    const register = h & (HLL_REGISTERS - 1);
    const rest = Math.floor(h / HLL_REGISTERS); // the remaining 39 bits
    const rank = rest === 0 ? 40 : 39 - Math.floor(Math.log2(rest)); // leading zeros + 1
    if (rank > this.registers[register]!) this.registers[register] = rank;

    if (!this.overflowed) {
      if (!this.exact.add(h)) this.sawRepeat = true;
      else if (this.exact.size > this.exactMax) this.overflowed = true;
    } else if (this.exact.has(h)) {
      this.sawRepeat = true;
    }
  }

  /** Distinct values: exact below the cap, a HyperLogLog estimate (±~0.8%) above it. */
  count(): number {
    if (!this.overflowed) return this.exact.size;
    return Math.min(this.added, Math.max(this.exactMax + 1, Math.round(this.estimate())));
  }

  /** Every value added was distinct — certain below the cap, judged within the estimate's error above it. */
  allDistinct(): boolean {
    if (this.sawRepeat) return false;
    if (!this.overflowed) return true;
    return this.estimate() >= this.added * (1 - HLL_UNIQUE_TOLERANCE);
  }

  private estimate(): number {
    const m = HLL_REGISTERS;
    let sum = 0;
    let zeros = 0;
    for (const r of this.registers) {
      sum += 2 ** -r;
      if (r === 0) zeros++;
    }
    const raw = ((0.7213 / (1 + 1.079 / m)) * m * m) / sum;
    // Small-range correction (linear counting) — only reachable if the cap were set very low.
    return raw <= 2.5 * m && zeros > 0 ? m * Math.log(m / zeros) : raw;
  }
}

/** A value's identity for distinct counting — equal exactly when the two values' JSON is equal, without serializing strings. */
function distinctKey(value: unknown): string {
  switch (typeof value) {
    case "string":
      return "s" + value;
    case "number":
      return "n" + String(value);
    case "boolean":
      return value ? "t" : "f";
    default:
      return "j" + JSON.stringify(value);
  }
}

export interface InferredField {
  kind: FieldKind;
  /**
   * Distinct non-null values observed (for multi fields: distinct elements across all arrays). Exact up
   * to `EXACT_DISTINCT_MAX`, estimated (±~0.8%) above it.
   */
  cardinality: number;
  /** Every non-null value is different from every other — what makes a field pk-shaped. */
  unique: boolean;
  /** The key was missing from at least one sampled record but present in another (absent ≠ null). */
  absent: boolean;
  /** At least one record held `null` for this key (null ≠ absent). */
  nullable: boolean;
  /** Every observed value was a string[] — a scalar leaf under an object-array (ADR-0001). */
  multi: boolean;
  /**
   * Sorted distinct values, present only for enum-like string fields (≤ `MAX_ENUM_VALUES` distinct).
   * Drives codegen's value union; omitted for every other field so they stay typed as plain `string`.
   */
  values?: string[];
  /** What the values look like — advisory only, never persisted to the config. */
  shape: ValueShape;
}

export interface InferenceResult {
  recordCount: number;
  fields: Record<string, InferredField>;
  sortField: string;
  pk?: string;
  /** Recommended default opt-in indexed set (excludes the sort field). */
  indexedFields: string[];
  /**
   * Fields the ranking would have indexed but left out because the index wouldn't prune (#31). Each
   * one's slot went to the next candidate. Empty when inference had no `blockShare` probe.
   */
  unselectiveIndexes: UnselectiveIndex[];
}

/**
 * Estimated share of data files the average value of `field` would sit in with records sorted by
 * `sortField`: the build's "barely prunes" measurement (ADR-0013), predicted before a build exists.
 * Undefined when there is nothing to judge, such as too few blocks for the ratio to mean anything.
 */
export type BlockShareProbe = (sortField: string, sortKind: SortableKind, field: string, inferred: InferredField) => number | undefined;

export interface UnselectiveIndex {
  field: string;
  /** Estimated share of data files the field's average value sits in, from 0 to 1. */
  blockShare: number;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

/** Collects the distinct string values of a field up to `MAX_ENUM_VALUES`, giving up past it. */
class EnumCollector {
  private values: Set<string> | undefined = new Set();

  add(value: string): void {
    if (this.values === undefined || this.values.has(value)) return;
    this.values.add(value);
    if (this.values.size > MAX_ENUM_VALUES) this.values = undefined;
  }

  /** The sorted distinct values, or `undefined` for none or too many. */
  result(): string[] | undefined {
    return this.values === undefined || this.values.size === 0 ? undefined : [...this.values].sort();
  }
}

/**
 * Everything inference needs to know about one field, gathered one record at a time. Holds counts,
 * a capped enum set and bounded distinct counters — never the values themselves.
 */
class FieldStats {
  constructor(private readonly exactDistinctMax: number) {}

  present = 0;
  private nulls = 0;

  // Scalars (non-null, non-array)
  private scalars = 0;
  private booleans = 0;
  private numbers = 0;
  private strings = 0;
  private allDates = true;
  private scalarDistinct: DistinctCounter | undefined;
  private readonly scalarEnum = new EnumCollector();
  private readonly scalarShape = new ShapeCounter();

  // Arrays
  private arrays = 0;
  private allStringArrays = true;
  private arrayDistinct: DistinctCounter | undefined;
  private elementDistinct: DistinctCounter | undefined;
  private readonly elementEnum = new EnumCollector();
  private readonly elementShape = new ShapeCounter();

  add(value: unknown): void {
    this.present++;
    if (value === null) {
      this.nulls++;
      return;
    }
    if (Array.isArray(value)) {
      this.arrays++;
      // A mixed or payload field reports distinct whole values, so arrays are counted whole too.
      (this.arrayDistinct ??= new DistinctCounter(this.exactDistinctMax)).add(distinctKey(value));
      if (!this.allStringArrays) return;
      if (!isStringArray(value)) {
        // Only string[] is a queryable list field (T7); the element stats are moot from here on.
        this.allStringArrays = false;
        this.elementDistinct = undefined;
        return;
      }
      const elements = (this.elementDistinct ??= new DistinctCounter(this.exactDistinctMax));
      for (const element of value) {
        elements.add(distinctKey(element));
        this.elementEnum.add(element);
        this.elementShape.add(element);
      }
      return;
    }

    this.scalars++;
    (this.scalarDistinct ??= new DistinctCounter(this.exactDistinctMax)).add(distinctKey(value));
    if (typeof value === "boolean") this.booleans++;
    else if (typeof value === "number") this.numbers++;
    else if (typeof value === "string") {
      this.strings++;
      if (this.allDates && !ISO_DATE_RE.test(value)) this.allDates = false;
      this.scalarEnum.add(value);
      this.scalarShape.add(value);
    }
  }

  finish(recordCount: number): InferredField {
    const absent = this.present < recordCount;
    const nullable = this.nulls > 0;

    // A field that mixes arrays and scalars can't be a single queryable kind, and a list of anything
    // but strings isn't a queryable list — both are carried as payload.
    if (this.arrays > 0 && (this.scalars > 0 || !this.allStringArrays)) {
      const counters = [this.scalarDistinct, this.arrayDistinct].filter((c): c is DistinctCounter => c !== undefined);
      return {
        kind: "json",
        cardinality: counters.reduce((sum, c) => sum + c.count(), 0),
        unique: false,
        absent,
        nullable,
        multi: false,
        shape: "text",
      };
    }

    if (this.arrays > 0) {
      const values = this.elementEnum.result();
      return {
        kind: "string",
        cardinality: this.elementDistinct?.count() ?? 0,
        unique: false,
        absent,
        nullable,
        multi: true,
        shape: this.elementShape.shape(),
        ...(values ? { values } : {}),
      };
    }

    const kind = this.scalarKind();
    // `date` is excluded deliberately: a closed set of dates is a coincidence of the data, not a
    // domain enum, and freezing it would reject any later date.
    const values = kind === "string" ? this.scalarEnum.result() : undefined;
    return {
      kind,
      cardinality: this.scalarDistinct?.count() ?? 0,
      unique: this.scalarDistinct?.allDistinct() ?? false,
      absent,
      nullable,
      multi: false,
      shape: this.scalarShape.shape(),
      ...(values ? { values } : {}),
    };
  }

  private scalarKind(): FieldKind {
    const n = this.scalars;
    if (n === 0) return "string";
    if (this.booleans === n) return "boolean";
    if (this.numbers === n) return "number";
    if (this.strings === n) return this.allDates ? "date" : "string";
    // Nested objects and mixed-scalar-type fields aren't a queryable scalar kind — carry them as
    // payload-only "json" (ADR-0001) rather than failing the whole init.
    return "json";
  }
}

/** A field is PK-shaped when its own values look like an identifier: present on every record, unique, id-like name. */
function looksLikePk(name: string, f: InferredField): boolean {
  return !f.multi && !f.absent && !f.nullable && f.unique && ID_LIKE_NAME_RE.test(name);
}

/** A field can be a sort-field candidate iff it's an always-present, single-valued sortable kind
 * (ADR-0002 §2) — exported so the wizard's sort-field step (T12) shares this exact predicate
 * instead of a second copy that could silently drift from what `init --yes` would recommend. */
export function isSortFieldCandidate(f: Pick<InferredField, "kind" | "multi" | "absent">): boolean {
  return SORTABLE_KINDS.includes(f.kind as SortableKind) && !f.multi && !f.absent;
}

/**
 * Ranks a candidate's *kind* ahead of its cardinality. Strings are legal sort fields (locality on
 * the field users search is the point — ADR-0002 §2), but ranking purely by cardinality would hand
 * the default to whichever column is most unique, which on real data is an id/UUID/URL — the worst
 * possible locality. So number/date keep the default and a string only wins when nothing else can.
 */
function sortKindRank(kind: FieldKind): number {
  return kind === "string" ? 1 : 0;
}

function recommendSortField(fields: Record<string, InferredField>, recordCount: number): string {
  const candidates = Object.entries(fields).filter(([, f]) => isSortFieldCandidate(f));
  if (candidates.length === 0) {
    throw new Error(
      "zonedb: init could not infer a sort field — no always-present, single-valued " +
        `${SORTABLE_KINDS.join("/")} field was found in the sample; declare one explicitly with --sort-field`,
    );
  }

  candidates.sort(([nameA, a], [nameB, b]) => {
    const kindRank = sortKindRank(a.kind) - sortKindRank(b.kind);
    if (kindRank !== 0) return kindRank;
    if (b.cardinality !== a.cardinality) return b.cardinality - a.cardinality;
    // ADR-0002 §2: tiebreak toward the PK — judged directly off each candidate's own
    // uniqueness + id-like name, not by deferring to recommendPk (which runs after the
    // sort field is chosen, and pk may legitimately equal the sort field — ADR-0002 §4).
    const aPkLike = looksLikePk(nameA, a);
    const bPkLike = looksLikePk(nameB, b);
    if (aPkLike !== bPkLike) return aPkLike ? -1 : 1;
    return nameA < nameB ? -1 : nameA > nameB ? 1 : 0;
  });

  return candidates[0]![0];
}

function recommendPk(fields: Record<string, InferredField>): string | undefined {
  // A pk may legitimately be the sort field itself — the "free" get(id) path (ADR-0002 §4).
  const idLike = Object.entries(fields)
    .filter(([name, f]) => (f.kind === "number" || f.kind === "string") && looksLikePk(name, f))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return idLike[0]?.[0];
}

function recommendIndexedFields(
  fields: Record<string, InferredField>,
  recordCount: number,
  sortField: string,
  blockShare: BlockShareProbe | undefined,
): Pick<InferenceResult, "indexedFields" | "unselectiveIndexes"> {
  const entries = Object.entries(fields).filter(([name]) => name !== sortField);

  // Multi-valued fields can only be declared correctly when indexed (T7 constraint) — always include them.
  const forced = entries.filter(([, f]) => f.multi).map(([name]) => name);

  // DESCENDING cardinality, within a facet-shaped band. Ascending picked the least selective fields
  // available — on a real 116k-record dataset the three winners were all two-value booleans
  // (`highres_image`, `reserved`, `game_changer`) while `set` (1047), `artist` (2524) and `type_line`
  // (4937) went unindexed. That also contradicted ADR-0003 §6 step 4, which uses higher cardinality as
  // the selectivity proxy precisely because it prunes harder.
  //
  // The band matters in both directions: a value shared by fewer than MIN_RECORDS_PER_FACET_VALUE
  // records on average is identifier-shaped, not a facet, and indexing it buys a per-value index entry
  // for almost no grouping.
  // The band needs enough records to mean anything: on a 5-record sample `recordCount / 10` is 0 and
  // would reject every field. Below the threshold, "not unique" is the only claim the data supports.
  const maxFacetCardinality =
    recordCount >= MIN_RECORDS_FOR_FACET_BAND ? Math.floor(recordCount / MIN_RECORDS_PER_FACET_VALUE) : recordCount - 1;
  const categorical = entries
    .filter(
      ([, f]) =>
        f.kind !== "json" && !f.multi && f.cardinality > 1 && f.cardinality <= maxFacetCardinality,
    )
    .sort(([nameA, a], [nameB, b]) => (a.cardinality !== b.cardinality ? b.cardinality - a.cardinality : nameA < nameB ? -1 : 1));

  // Cardinality says how finely a field groups records, not whether those groups line up with blocks.
  // Since ADR-0013 an unindexed field is still filterable as a rider, so an index whose values sit in
  // most blocks is pure cost — the build warns about exactly these. Skip them and give the slot to the
  // next candidate (#31). Multi-valued fields stay forced: they can't be declared unindexed.
  const picked: string[] = [];
  const unselectiveIndexes: UnselectiveIndex[] = [];
  for (const [name, f] of categorical) {
    if (picked.length === DEFAULT_MAX_INDEXED) break;
    const share = blockShare?.(sortField, fields[sortField]!.kind as SortableKind, name, f);
    if (share !== undefined && share > UNSELECTIVE_POSTINGS_RATIO) unselectiveIndexes.push({ field: name, blockShare: share });
    else picked.push(name);
  }

  return { indexedFields: [...forced, ...picked], unselectiveIndexes };
}

/**
 * Infers a candidate schema one record at a time — the only inference site (ADR-0005 §4). Pure: no
 * I/O, no defaults from config — `init` layers flags/existing-file precedence on top of this
 * recommendation.
 *
 * Memory is bounded by field count, not record count (#29): each field keeps counts, a capped enum
 * set and a distinct counter that is exact up to `EXACT_DISTINCT_MAX` and estimated past it. So `init`
 * can read an input far bigger than memory in full, rather than guessing from its head.
 */
export class SchemaInferrer {
  private readonly stats = new Map<string, FieldStats>();
  private recordCount = 0;
  private readonly exactDistinctMax: number;

  constructor(opts: { exactDistinctMax?: number } = {}) {
    this.exactDistinctMax = opts.exactDistinctMax ?? EXACT_DISTINCT_MAX;
  }

  add(record: Record<string, unknown>): void {
    this.recordCount++;
    for (const key in record) {
      if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
      let field = this.stats.get(key);
      if (field === undefined) {
        field = new FieldStats(this.exactDistinctMax);
        this.stats.set(key, field);
      }
      field.add(record[key]);
    }
  }

  /** Records seen so far. */
  get size(): number {
    return this.recordCount;
  }

  /**
   * `blockShare` lets the index recommendation skip fields that wouldn't prune; without it, cardinality
   * alone decides. `sortField` is the sort field the caller will actually use (a `--sort-field`, or the
   * one an existing config keeps): the index recommendation is judged against it, since which values
   * cluster depends entirely on the sort. It is used when the data has it as a single-valued sortable
   * field, and the recommendation falls back to inferring one otherwise. May be called again with
   * other options; the counts aren't consumed.
   */
  finish(opts: { blockShare?: BlockShareProbe; sortField?: string } = {}): InferenceResult {
    const recordCount = this.recordCount;
    const fields: Record<string, InferredField> = {};
    // Fields in order of first appearance, like the records' own keys.
    for (const [name, field] of this.stats) fields[name] = field.finish(recordCount);

    const chosen = opts.sortField === undefined ? undefined : fields[opts.sortField];
    const sortField =
      chosen !== undefined && SORTABLE_KINDS.includes(chosen.kind as SortableKind) && !chosen.multi
        ? opts.sortField!
        : recommendSortField(fields, recordCount);
    const pk = recommendPk(fields);
    const { indexedFields, unselectiveIndexes } = recommendIndexedFields(fields, recordCount, sortField, opts.blockShare);

    return { recordCount, fields, sortField, pk, indexedFields, unselectiveIndexes };
  }
}

/** How often `inferSchema` reports progress, in records. */
const PROGRESS_EVERY = 10_000;

/** `SchemaInferrer` over records already in memory. */
export function inferSchema(
  records: Record<string, unknown>[],
  opts: { onProgress?: OnProgress } = {},
): InferenceResult {
  const inferrer = new SchemaInferrer();
  const report = (done: number) =>
    opts.onProgress?.({ phase: "inferring schema", done, total: records.length, unit: "count" });
  records.forEach((record, i) => {
    inferrer.add(record);
    if ((i + 1) % PROGRESS_EVERY === 0) report(i + 1);
  });
  report(records.length);
  return inferrer.finish();
}
