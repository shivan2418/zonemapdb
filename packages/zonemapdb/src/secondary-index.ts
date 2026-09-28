// Secondary-field pruning (ADR-0003): decode a chunked inverted-index chunk,
// pick the chunk(s) a filter could touch from the (always-in-manifest) chunk
// directory, and resolve which blocks actually hold a matching value.

import type { IndexChunkDirEntry } from "./manifest.js";
import type { FieldKind } from "./types.js";

export interface IndexChunkEntry {
  /** Chars shared with the PREVIOUS entry's canonical key; 0 for a chunk's first entry (ADR-0003 §4). */
  prefixLen: number;
  suffix: string;
  /** Delta-encoded ascending block ordinals — cumulative-sum from 0 reconstructs them (ADR-0003 §5). */
  postings: number[];
}

export interface IndexChunkFile {
  entries: IndexChunkEntry[];
}

export interface DecodedIndexEntry {
  value: unknown;
  blockIndices: number[];
}

function fromCanonicalKey(key: string, kind: FieldKind): unknown {
  if (kind === "number") return Number(key);
  if (kind === "boolean") return key === "true";
  return key; // string | date — dates are already ISO strings
}

/** Reconstructs a chunk's front-coded dictionary + delta-encoded postings into typed values. */
export function decodeIndexChunk(file: IndexChunkFile, kind: FieldKind): DecodedIndexEntry[] {
  let prevKey = "";
  return file.entries.map((entry) => {
    prevKey = prevKey.slice(0, entry.prefixLen) + entry.suffix;
    let acc = 0;
    const blockIndices = entry.postings.map((delta) => (acc += delta));
    return { value: fromCanonicalKey(prevKey, kind), blockIndices };
  });
}

export interface SecondaryFieldFilter {
  equals?: unknown;
  in?: unknown[];
  startsWith?: string;
}

function overlapsValue(dir: IndexChunkDirEntry, value: unknown): boolean {
  return (dir.from as never) <= (value as never) && (value as never) <= (dir.to as never);
}

/** Any string with `prefix` lies lexicographically within [prefix, prefix + a sentinel higher than any real char]. */
function overlapsPrefix(dir: IndexChunkDirEntry, prefix: string): boolean {
  const sentinel = prefix + "￿";
  return (dir.from as string) <= sentinel && (dir.to as string) >= prefix;
}

/** The chunk directory entries a filter could possibly match — routes which chunks to fetch. */
export function chunksForFilter(chunks: IndexChunkDirEntry[], filter: SecondaryFieldFilter): IndexChunkDirEntry[] {
  const matched = new Set<IndexChunkDirEntry>();
  if (filter.equals !== undefined) {
    for (const chunk of chunks) if (overlapsValue(chunk, filter.equals)) matched.add(chunk);
  }
  if (filter.in !== undefined) {
    for (const value of filter.in) for (const chunk of chunks) if (overlapsValue(chunk, value)) matched.add(chunk);
  }
  if (filter.startsWith !== undefined) {
    for (const chunk of chunks) if (overlapsPrefix(chunk, filter.startsWith)) matched.add(chunk);
  }
  return [...matched];
}

function matchesEntryValue(value: unknown, filter: SecondaryFieldFilter): boolean {
  if (filter.equals !== undefined && value !== filter.equals) return false;
  if (filter.in !== undefined && !filter.in.includes(value)) return false;
  if (filter.startsWith !== undefined && !(value as string).startsWith(filter.startsWith)) return false;
  return true;
}

/** The union of block ordinals whose decoded entry value satisfies the filter. */
export function blockIndicesForFilter(decoded: DecodedIndexEntry[], filter: SecondaryFieldFilter): Set<number> {
  const blockIndices = new Set<number>();
  for (const entry of decoded) {
    if (matchesEntryValue(entry.value, filter)) for (const s of entry.blockIndices) blockIndices.add(s);
  }
  return blockIndices;
}

/** Codepoint-safe reversal (ADR-0003 §7): `endsWith(suffix)` becomes `startsWith` on the reversed index once both sides are reversed. */
export function reverseString(value: string): string {
  return [...value].reverse().join("");
}

/** Every sliding 3-char window of `value` — the query-side counterpart of the trigram index's dictionary keys (ADR-0003 §7). */
export function trigramsOf(value: string): string[] {
  const grams: string[] = [];
  for (let i = 0; i <= value.length - 3; i++) grams.push(value.slice(i, i + 3));
  return grams;
}
