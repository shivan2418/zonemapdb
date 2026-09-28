import { closeSync, mkdtempSync, openSync, readSync, rmSync, writeSync } from "node:fs";
import path from "node:path";

export type SortKind = "number" | "date" | "string";

/**
 * Compares two sort-field values. Missing values (null/undefined) sort after
 * every real value (ADR-0002: missing sort values cluster at the high end).
 * Within the missing tail, null sorts before undefined (absent) so the two
 * stay separately contiguous rather than interleaved (ADR-0002 §9).
 */
export function compareSortValues(a: unknown, b: unknown, kind: SortKind): number {
  const aMissing = a === null || a === undefined;
  const bMissing = b === null || b === undefined;
  if (aMissing && bMissing) {
    if (a === b) return 0;
    return a === null ? -1 : 1;
  }
  if (aMissing) return 1;
  if (bMissing) return -1;

  if (kind === "number") {
    return (a as number) - (b as number);
  }
  // string and date share one branch: dates are ISO strings, so lexicographic order IS chronological
  // order for them — which is why a string sort field needs no comparison logic of its own.
  const av = a as string;
  const bv = b as string;
  return av < bv ? -1 : av > bv ? 1 : 0;
}

/** Generic ascending compare for a tiebreak field of any scalar kind; missing sorts last. */
function compareTiebreak(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a === null || a === undefined) return 1;
  if (b === null || b === undefined) return -1;
  const av = a as number | string;
  const bv = b as number | string;
  return av < bv ? -1 : av > bv ? 1 : 0;
}

/**
 * Total order over records for the global sort (ADR-0002 §6 "secondary tiebreak sort within equal
 * keys"): primary by the sort field, then the declared PK (if any), then a canonical full-record
 * comparison. This makes the result independent of input row order — re-exporting the same
 * logical dataset in a different physical order still produces byte-identical blocks (ADR-0003 §8).
 */
export function compareRecordsForSort(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
  sortField: string,
  kind: SortKind,
  pk?: string,
): number {
  const primary = compareSortValues(a[sortField], b[sortField], kind);
  if (primary !== 0) return primary;
  if (pk !== undefined) {
    const pkCompare = compareTiebreak(a[pk], b[pk]);
    if (pkCompare !== 0) return pkCompare;
  }
  const aKey = JSON.stringify(a);
  const bKey = JSON.stringify(b);
  return aKey < bKey ? -1 : aKey > bKey ? 1 : 0;
}

/**
 * One record on its way through the sort, carried with its serialized line. Serializing once lets the
 * canonical tie-break compare two precomputed strings instead of `JSON.stringify`-ing both records on
 * every comparison, and the same line is what gets spilled to a run file and, later, written into a
 * block — so a record's bytes are fixed exactly once.
 */
export interface SortItem {
  record: Record<string, unknown>;
  /** `JSON.stringify(record)`. */
  line: string;
}

/** `compareRecordsForSort`, with the full-record tie-break read off the precomputed lines. */
function compareItems(a: SortItem, b: SortItem, sortField: string, kind: SortKind, pk?: string): number {
  const primary = compareSortValues(a.record[sortField], b.record[sortField], kind);
  if (primary !== 0) return primary;
  if (pk !== undefined) {
    const pkCompare = compareTiebreak(a.record[pk], b.record[pk]);
    if (pkCompare !== 0) return pkCompare;
  }
  return a.line < b.line ? -1 : a.line > b.line ? 1 : 0;
}

export interface ExternalSortOptions {
  sortField: string;
  kind: SortKind;
  pk?: string;
  /** Records buffered per sorted run before spilling to disk; a source at or under this size (and `runBytes`) sorts purely in memory. */
  runRecords: number;
  /**
   * Serialized bytes buffered per sorted run before spilling, whichever limit comes first. A record
   * count alone doesn't bound memory: 200,000 records of 5 KB each is a gigabyte of lines, plus the
   * parsed objects beside them. Default `DEFAULT_RUN_BYTES`.
   */
  runBytes?: number;
  /** Scratch directory external sort creates a run-file subdirectory under; removed by `close`. */
  tmpDir: string;
}

/** 64 MiB of serialized records per run — a few hundred MB of heap once the parsed objects are counted. */
export const DEFAULT_RUN_BYTES = 64 * 1024 * 1024;

const READ_CHUNK_BYTES = 64 * 1024;

/**
 * Reads one run file a fixed-size chunk at a time and yields it line by line — so merging N runs
 * holds only ~N × `READ_CHUNK_BYTES` in memory at once, not each run's full content. A `TextDecoder`
 * in streaming mode absorbs multi-byte UTF-8 sequences split across a chunk boundary.
 */
class RunReader {
  private readonly fd: number;
  private readonly decoder = new TextDecoder("utf-8");
  private readonly chunk = Buffer.allocUnsafe(READ_CHUNK_BYTES);
  private buffer = "";
  private eof = false;
  private closed = false;

  constructor(filePath: string) {
    this.fd = openSync(filePath, "r");
  }

  private fill(): void {
    const bytesRead = readSync(this.fd, this.chunk, 0, READ_CHUNK_BYTES, null);
    if (bytesRead === 0) {
      this.eof = true;
      this.buffer += this.decoder.decode(); // flush any trailing partial sequence
      this.close();
      return;
    }
    this.buffer += this.decoder.decode(this.chunk.subarray(0, bytesRead), { stream: true });
  }

  /** The next record with its line, or `undefined` once the run is exhausted (closing its file descriptor). */
  next(): SortItem | undefined {
    for (;;) {
      const newlineIdx = this.buffer.indexOf("\n");
      if (newlineIdx !== -1) {
        const line = this.buffer.slice(0, newlineIdx);
        this.buffer = this.buffer.slice(newlineIdx + 1);
        if (line.length === 0) continue;
        return { record: JSON.parse(line) as Record<string, unknown>, line };
      }
      if (this.eof) {
        const line = this.buffer;
        this.buffer = "";
        return line.length === 0 ? undefined : { record: JSON.parse(line) as Record<string, unknown>, line };
      }
      this.fill();
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    closeSync(this.fd);
  }
}

/**
 * A binary min-heap over the runs' current heads. Picking the next record is O(log runs) rather than
 * a linear scan of every head — at 130M records over ~650 runs, the difference between ~1.3B and ~85B
 * comparisons.
 */
class RunHeap {
  private readonly heap: { item: SortItem; reader: RunReader }[] = [];

  constructor(private readonly compare: (a: SortItem, b: SortItem) => number) {}

  get size(): number {
    return this.heap.length;
  }

  push(item: SortItem, reader: RunReader): void {
    const heap = this.heap;
    heap.push({ item, reader });
    let i = heap.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.compare(heap[i]!.item, heap[parent]!.item) >= 0) break;
      [heap[i], heap[parent]] = [heap[parent]!, heap[i]!];
      i = parent;
    }
  }

  /** Removes the smallest head, refilling from its run, and returns it. */
  pop(): SortItem {
    const heap = this.heap;
    const top = heap[0]!;
    const next = top.reader.next();
    if (next !== undefined) {
      heap[0] = { item: next, reader: top.reader };
    } else {
      const last = heap.pop()!;
      if (heap.length === 0) return top.item;
      heap[0] = last;
    }
    let i = 0;
    for (;;) {
      const left = 2 * i + 1;
      const right = left + 1;
      let smallest = i;
      if (left < heap.length && this.compare(heap[left]!.item, heap[smallest]!.item) < 0) smallest = left;
      if (right < heap.length && this.compare(heap[right]!.item, heap[smallest]!.item) < 0) smallest = right;
      if (smallest === i) break;
      [heap[i], heap[smallest]] = [heap[smallest]!, heap[i]!];
      i = smallest;
    }
    return top.item;
  }
}

/**
 * Sorts records by `compareRecordsForSort`, taking them one at a time (ADR-0002 §9, #28). Up to
 * `runRecords` records or `runBytes` of them are buffered; a source that never exceeds either sorts
 * purely in memory. Past it, each
 * full buffer is sorted and spilled to an NDJSON run file under `tmpDir`, and `sorted()` k-way-merges
 * the runs back through a heap, reading each through a small fixed-size buffer (`RunReader`) — so
 * memory peaks at one run plus a chunk per run file, never the dataset.
 *
 * Call `close` when done (including on failure) to remove the scratch directory.
 */
export class ExternalSorter {
  private buffer: SortItem[] = [];
  private bufferBytes = 0;
  private scratchDir: string | undefined;
  private readonly runFiles: string[] = [];
  private readers: RunReader[] = [];
  private count = 0;
  private readonly compare: (a: SortItem, b: SortItem) => number;

  constructor(private readonly opts: ExternalSortOptions) {
    this.compare = (a, b) => compareItems(a, b, opts.sortField, opts.kind, opts.pk);
  }

  /** Records added so far. */
  get size(): number {
    return this.count;
  }

  /** Adds one record. `line` must be `JSON.stringify(record)`; pass it when the caller already has it. */
  add(record: Record<string, unknown>, line = JSON.stringify(record)): void {
    this.buffer.push({ record, line });
    this.bufferBytes += line.length; // string length: near enough to bytes for a memory bound
    this.count++;
    if (this.buffer.length >= this.opts.runRecords || this.bufferBytes >= (this.opts.runBytes ?? DEFAULT_RUN_BYTES)) {
      this.spill();
    }
  }

  private spill(): void {
    this.scratchDir ??= mkdtempSync(path.join(this.opts.tmpDir, "zonemapdb-sort-"));
    const run = this.buffer.sort(this.compare);
    this.buffer = [];
    this.bufferBytes = 0;
    const filePath = path.join(this.scratchDir, `run-${this.runFiles.length}.ndjson`);
    // Written in slices so no single string approaches V8's max length on a run of large records.
    const fd = openSync(filePath, "w");
    try {
      const SLICE = 1000;
      for (let start = 0; start < run.length; start += SLICE) {
        const lines = run.slice(start, start + SLICE).map((item) => item.line);
        writeSync(fd, lines.join("\n") + "\n");
      }
    } finally {
      closeSync(fd);
    }
    this.runFiles.push(filePath);
  }

  /** Every record added, in sort order. Call once, after the last `add`. */
  *sorted(): Generator<SortItem> {
    if (this.runFiles.length === 0) {
      const all = this.buffer.sort(this.compare);
      this.buffer = [];
      yield* all;
      return;
    }
    if (this.buffer.length > 0) this.spill();

    this.readers = this.runFiles.map((filePath) => new RunReader(filePath));
    const heap = new RunHeap(this.compare);
    for (const reader of this.readers) {
      const head = reader.next();
      if (head !== undefined) heap.push(head, reader);
    }
    while (heap.size > 0) yield heap.pop();
  }

  /** Releases run files and their descriptors. Safe to call more than once. */
  close(): void {
    for (const reader of this.readers) reader.close();
    this.readers = [];
    if (this.scratchDir !== undefined) rmSync(this.scratchDir, { recursive: true, force: true });
    this.scratchDir = undefined;
  }
}

/** `ExternalSorter` over records already in memory, collected back into an array. */
export function externalSort(source: Record<string, unknown>[], opts: ExternalSortOptions): Record<string, unknown>[] {
  const sorter = new ExternalSorter(opts);
  try {
    for (const record of source) sorter.add(record);
    const sorted: Record<string, unknown>[] = [];
    for (const { record } of sorter.sorted()) sorted.push(record);
    return sorted;
  } finally {
    sorter.close();
  }
}
