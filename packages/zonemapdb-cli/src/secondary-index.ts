import type { FieldConfig, FieldKind, PairZonemapEntry } from "./types.js";

const DEFAULT_TRUNCATE_LEN = 12;

/** Parquet-style lower truncation: a proper prefix always compares ≤ the true value. */
export function truncateStringLower(value: string, maxLen = DEFAULT_TRUNCATE_LEN): string {
  return value.length <= maxLen ? value : value.slice(0, maxLen);
}

/** Codepoint-safe reversal — used to build the reversed-value index for `endsWith` (ADR-0003 §7). */
export function reverseString(value: string): string {
  return [...value].reverse().join("");
}

/** Increments the last code point of `prefix` so the result strictly exceeds every string sharing it. */
function incrementString(prefix: string): string {
  const chars = [...prefix];
  for (let i = chars.length - 1; i >= 0; i--) {
    const code = chars[i]!.codePointAt(0)!;
    if (code < 0x10ffff) {
      chars[i] = String.fromCodePoint(code + 1);
      return chars.slice(0, i + 1).join("");
    }
  }
  return prefix + "￿";
}

/** Parquet-style "next string after" upper truncation — a strict upper bound a few bytes long. */
export function truncateStringUpper(value: string, maxLen = DEFAULT_TRUNCATE_LEN): string {
  return value.length <= maxLen ? value : incrementString(value.slice(0, maxLen));
}

/**
 * The values one record contributes for `field`: a multi-valued field's record
 * holds an array (each element indexed individually, existentially matched via
 * `some` — T7); a single-valued field holds one scalar. Null/undefined entries
 * are skipped either way — same "no index entry for absent data" rule as before.
 */
/** The values one record contributes for `field` — a shared primitive: a multi-valued field's
 * record holds an array (each element indexed individually via `some`, T7); a single-valued
 * field holds one scalar. Also used by `estimator.ts` to profile the same fields the same way. */
export function valuesOf(record: Record<string, unknown>, field: string, multi: boolean): unknown[] {
  if (!multi) return [record[field]];
  const value = record[field];
  return Array.isArray(value) ? value : [];
}

function canonicalKey(value: unknown, kind: FieldKind): string {
  if (kind === "number") return String(value as number);
  if (kind === "boolean") return String(value as boolean);
  return value as string; // string | date — dates are already ISO strings
}

function compareByKind(a: unknown, b: unknown, kind: FieldKind): number {
  if (kind === "number") return (a as number) - (b as number);
  if (kind === "boolean") return a === b ? 0 : a ? 1 : -1;
  return (a as string) < (b as string) ? -1 : (a as string) > (b as string) ? 1 : 0;
}

/** One block's [min,max] over `field` — its entry in the field's zonemap (ADR-0002 §7 / ADR-0003 §2, §9). */
function zonemapPairOf(
  records: Record<string, unknown>[],
  field: string,
  kind: FieldKind,
  multi = false,
): [unknown, unknown] {
  let min: unknown;
  let max: unknown;
  for (const record of records) {
    for (const value of valuesOf(record, field, multi)) {
      if (value === null || value === undefined) continue;
      if (min === undefined || compareByKind(value, min, kind) < 0) min = value;
      if (max === undefined || compareByKind(value, max, kind) > 0) max = value;
    }
  }
  // A block can hold zero non-null values for an absentable field (T7) — no bound to compute or truncate.
  if (min === undefined) return [undefined, undefined];
  if (kind === "string") {
    return [truncateStringLower(min as string), truncateStringUpper(max as string)];
  }
  return [min, max];
}

/** Per-block [min,max] over `field`, ordinal-aligned with `groups`. */
export function computeSecondaryZonemap(
  groups: Record<string, unknown>[][],
  field: string,
  kind: FieldKind,
  multi = false,
): PairZonemapEntry {
  return zonemapEntry(groups.map((group) => zonemapPairOf(group, field, kind, multi)), kind);
}

function zonemapEntry(pairs: [unknown, unknown][], kind: FieldKind): PairZonemapEntry {
  return kind === "string" ? { pairs, truncated: true } : { pairs };
}

export interface IndexChunkEntry {
  /** Chars shared with the PREVIOUS entry's canonical key; 0 for a chunk's first entry (front-coding, ADR-0003 §4). */
  prefixLen: number;
  suffix: string;
  /** Delta-encoded ascending block ordinals — cumulative-sum from 0 reconstructs them (ADR-0003 §5). */
  postings: number[];
}

export interface IndexChunkFile {
  entries: IndexChunkEntry[];
}

export interface BuiltIndexChunk {
  from: unknown;
  to: unknown;
  content: string;
}

interface DictEntry {
  value: unknown;
  key: string;
  blockIndices: number[];
}

/**
 * Distinct keys → the ascending block ordinals holding them: the in-memory form of one index, built
 * up one block at a time. It grows with distinct values × postings, never with record count.
 */
class PostingsDictionary {
  private readonly byKey = new Map<string, DictEntry>();

  /** Notes that `blockIndex` holds `value` (canonical form `key`). Blocks must arrive in ascending order. */
  add(key: string, value: unknown, blockIndex: number): void {
    let entry = this.byKey.get(key);
    if (!entry) {
      entry = { value, key, blockIndices: [] };
      this.byKey.set(key, entry);
    }
    if (entry.blockIndices[entry.blockIndices.length - 1] !== blockIndex) entry.blockIndices.push(blockIndex);
  }

  /** Every entry in value order, ready to chunk. */
  sorted(kind: FieldKind): DictEntry[] {
    return [...this.byKey.values()].sort((a, b) => compareByKind(a.value, b.value, kind));
  }
}

/** Adds one block's values of `field` to its base (inverted) index dictionary. */
function addValues(dict: PostingsDictionary, records: Record<string, unknown>[], blockIndex: number, field: string, kind: FieldKind, multi: boolean): void {
  for (const record of records) {
    for (const value of valuesOf(record, field, multi)) {
      if (value === null || value === undefined) continue;
      dict.add(canonicalKey(value, kind), value, blockIndex);
    }
  }
}

/** Adds one block's values of `field`, each reversed, to its `endsWith` dictionary (ADR-0003 §7). */
function addReversedValues(dict: PostingsDictionary, records: Record<string, unknown>[], blockIndex: number, field: string, multi: boolean): void {
  for (const record of records) {
    for (const value of valuesOf(record, field, multi)) {
      if (value === null || value === undefined) continue;
      const reversed = reverseString(value as string);
      dict.add(reversed, reversed, blockIndex);
    }
  }
}

/** Adds every trigram of one block's values of `field` to its `contains` dictionary (ADR-0003 §7). */
function addTrigrams(dict: PostingsDictionary, records: Record<string, unknown>[], blockIndex: number, field: string, multi: boolean): void {
  for (const record of records) {
    for (const value of valuesOf(record, field, multi)) {
      if (value === null || value === undefined) continue;
      for (const gram of trigramsOf(value as string)) dict.add(gram, gram, blockIndex);
    }
  }
}

function encodeEntry(entry: DictEntry, prevKey: string): IndexChunkEntry {
  const maxShared = Math.min(prevKey.length, entry.key.length);
  let prefixLen = 0;
  while (prefixLen < maxShared && prevKey[prefixLen] === entry.key[prefixLen]) prefixLen++;

  const postings: number[] = [];
  let prev = 0;
  for (const blockIndex of entry.blockIndices) {
    postings.push(blockIndex - prev);
    prev = blockIndex;
  }

  return { prefixLen, suffix: entry.key.slice(prefixLen), postings };
}

/** Cuts a sorted distinct-value dictionary into front-coded, delta-encoded, ~chunkBytes-sized chunks. */
function buildChunksFromDictionary(distinct: DictEntry[], chunkBytes: number): BuiltIndexChunk[] {
  if (distinct.length === 0) return [];

  const chunks: BuiltIndexChunk[] = [];
  let currentEntries: IndexChunkEntry[] = [];
  let currentBytes = 0;
  let chunkFirstValue: unknown;

  const flush = (lastValue: unknown): void => {
    if (currentEntries.length === 0) return;
    chunks.push({
      from: chunkFirstValue,
      to: lastValue,
      content: JSON.stringify({ entries: currentEntries } satisfies IndexChunkFile),
    });
    currentEntries = [];
    currentBytes = 0;
  };

  for (let i = 0; i < distinct.length; i++) {
    const dictEntry = distinct[i]!;
    const isChunkStart = currentEntries.length === 0;
    const prevKey = isChunkStart ? "" : distinct[i - 1]!.key;
    const encoded = encodeEntry(dictEntry, prevKey);
    const entryBytes = JSON.stringify(encoded).length + 1;

    if (!isChunkStart && currentBytes + entryBytes > chunkBytes) {
      flush(distinct[i - 1]!.value);
      const restart = encodeEntry(dictEntry, "");
      currentEntries.push(restart);
      currentBytes = JSON.stringify(restart).length + 1;
      chunkFirstValue = dictEntry.value;
    } else {
      if (isChunkStart) chunkFirstValue = dictEntry.value;
      currentEntries.push(encoded);
      currentBytes += entryBytes;
    }
  }
  flush(distinct[distinct.length - 1]!.value);

  return chunks;
}

/** Every sliding 3-char window of `value` — the dictionary keys of a trigram index. */
function trigramsOf(value: string): string[] {
  const grams: string[] = [];
  for (let i = 0; i <= value.length - 3; i++) grams.push(value.slice(i, i + 3));
  return grams;
}

/**
 * Builds the chunked inverted index for one non-sort indexed field (ADR-0003):
 * distinct values sorted, front-coded within each chunk (so a chunk decodes
 * standalone), delta-encoded postings (value → block ordinals), cut into
 * ~chunkBytes-sized groups.
 */
export function buildInvertedIndex(
  groups: Record<string, unknown>[][],
  field: string,
  kind: FieldKind,
  chunkBytes: number,
  multi = false,
): BuiltIndexChunk[] {
  const dict = new PostingsDictionary();
  groups.forEach((group, blockIndex) => addValues(dict, group, blockIndex, field, kind, multi));
  return buildChunksFromDictionary(dict.sorted(kind), chunkBytes);
}

/**
 * Builds the reversed-value index that unlocks `endsWith` (ADR-0003 §7): the
 * SAME chunked-dictionary structure as the base index, keyed on each string
 * value reversed — so `endsWith("son")` becomes a `startsWith` prefix-range
 * query on this index once the runtime reverses the query value too.
 */
export function buildReversedIndex(
  groups: Record<string, unknown>[][],
  field: string,
  chunkBytes: number,
  multi = false,
): BuiltIndexChunk[] {
  const dict = new PostingsDictionary();
  groups.forEach((group, blockIndex) => addReversedValues(dict, group, blockIndex, field, multi));
  return buildChunksFromDictionary(dict.sorted("string"), chunkBytes);
}

/**
 * Builds the trigram index that unlocks `contains` (ADR-0003 §7): every
 * distinct 3-char substring across the field's values, front-coded/delta-
 * encoded exactly like the base index, but keyed on trigrams rather than
 * whole values — a value shorter than 3 chars contributes none.
 */
export function buildTrigramIndex(
  groups: Record<string, unknown>[][],
  field: string,
  chunkBytes: number,
  multi = false,
): BuiltIndexChunk[] {
  const dict = new PostingsDictionary();
  groups.forEach((group, blockIndex) => addTrigrams(dict, group, blockIndex, field, multi));
  return buildChunksFromDictionary(dict.sorted("string"), chunkBytes);
}

/**
 * Mean postings-list length across a built structure's dictionary entries — i.e. how many blocks
 * the average lookup on it resolves to. Compared against `blockCount` this is the one number that
 * says whether an index actually *prunes*: an entry pointing at most blocks buys nothing, since the
 * query still has to fetch most of the dataset. `undefined` for an empty structure.
 */
export function meanPostingsLength(chunks: BuiltIndexChunk[]): number | undefined {
  let entries = 0;
  let postings = 0;
  for (const chunk of chunks) {
    const parsed = JSON.parse(chunk.content) as IndexChunkFile;
    for (const entry of parsed.entries) {
      entries++;
      postings += entry.postings.length;
    }
  }
  return entries === 0 ? undefined : postings / entries;
}

/**
 * Ordinals of the blocks holding at least one record whose `field` is a present `[]` — what `isEmpty`
 * and `every` prune on (ADR-0010 §4). A missing key or `null` is not an empty list (§3), so neither
 * counts.
 */
export function emptyListBlocks(groups: Record<string, unknown>[][], field: string): number[] {
  const ordinals: number[] = [];
  groups.forEach((group, ordinal) => {
    if (holdsEmptyList(group, field)) ordinals.push(ordinal);
  });
  return ordinals;
}

function holdsEmptyList(records: Record<string, unknown>[], field: string): boolean {
  return records.some((record) => Array.isArray(record[field]) && (record[field] as unknown[]).length === 0);
}

/** Total UTF-8 bytes of the field's raw (non-null) string values — the "size of the column" ADR-0003 §7 warns against exceeding. */
export function computeColumnBytes(groups: Record<string, unknown>[][], field: string, multi = false): number {
  return groups.reduce((sum, group) => sum + columnBytesOf(group, field, multi), 0);
}

function columnBytesOf(records: Record<string, unknown>[], field: string, multi: boolean): number {
  let bytes = 0;
  for (const record of records) {
    for (const value of valuesOf(record, field, multi)) {
      if (typeof value === "string") bytes += Buffer.byteLength(value, "utf8");
    }
  }
  return bytes;
}

/** Everything one secondary indexed field's structures need, finished once the last block is in. */
export interface FieldIndexResult {
  zonemap: PairZonemapEntry;
  chunks: BuiltIndexChunk[];
  /** `endsWith` only. */
  reversedChunks?: BuiltIndexChunk[];
  /** `contains` only. */
  trigramChunks?: BuiltIndexChunk[];
  /** List fields only: the blocks holding a present `[]` (ADR-0010 §4). */
  emptyBlocks?: number[];
  /** `contains` only: the raw column's bytes, which the trigram index is judged against (ADR-0003 §7). */
  columnBytes?: number;
}

/**
 * Builds every structure for one secondary indexed field — zonemap, base index, and the `endsWith`/
 * `contains` opt-ins — one block at a time, so `build` can drop each block once it's been read (#28).
 * The same code backs the whole-dataset `computeSecondaryZonemap`/`build*Index` functions above, so the
 * streamed and in-memory forms can't drift apart.
 */
export class FieldIndexer {
  private readonly multi: boolean;
  private readonly pairs: [unknown, unknown][] = [];
  private readonly base = new PostingsDictionary();
  private readonly reversed: PostingsDictionary | undefined;
  private readonly trigrams: PostingsDictionary | undefined;
  private readonly emptyBlocks: number[] | undefined;
  private columnBytes = 0;

  constructor(
    private readonly name: string,
    private readonly field: FieldConfig,
  ) {
    this.multi = field.multi === true;
    this.reversed = field.endsWith ? new PostingsDictionary() : undefined;
    this.trigrams = field.contains ? new PostingsDictionary() : undefined;
    this.emptyBlocks = this.multi ? [] : undefined;
  }

  addBlock(blockIndex: number, records: Record<string, unknown>[]): void {
    const { name, field, multi } = this;
    this.pairs.push(zonemapPairOf(records, name, field.kind, multi));
    addValues(this.base, records, blockIndex, name, field.kind, multi);
    if (this.reversed) addReversedValues(this.reversed, records, blockIndex, name, multi);
    if (this.trigrams) {
      addTrigrams(this.trigrams, records, blockIndex, name, multi);
      this.columnBytes += columnBytesOf(records, name, multi);
    }
    if (this.emptyBlocks && holdsEmptyList(records, name)) this.emptyBlocks.push(blockIndex);
  }

  finish(chunkBytes: number): FieldIndexResult {
    return {
      zonemap: zonemapEntry(this.pairs, this.field.kind),
      chunks: buildChunksFromDictionary(this.base.sorted(this.field.kind), chunkBytes),
      ...(this.reversed ? { reversedChunks: buildChunksFromDictionary(this.reversed.sorted("string"), chunkBytes) } : {}),
      ...(this.trigrams
        ? { trigramChunks: buildChunksFromDictionary(this.trigrams.sorted("string"), chunkBytes), columnBytes: this.columnBytes }
        : {}),
      ...(this.emptyBlocks ? { emptyBlocks: this.emptyBlocks } : {}),
    };
  }
}
