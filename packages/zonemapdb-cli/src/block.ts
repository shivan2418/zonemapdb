import { compressionSuffix, type Compression } from "./types.js";
import { contentHash } from "./hash.js";
import type { BlockDescriptor } from "./types.js";

/** Past this many blocks, files nest under a 2-hex-char prefix subdir so no one directory holds an unwieldy number of files (ADR-0002 §8). */
export const HASH_PREFIX_THRESHOLD = 1000;
const HASH_PREFIX_LEN = 2;

/**
 * The on-disk (and served) path of a block file relative to `output`, given the TOTAL block
 * count — a deterministic, threshold-based rule shared with the runtime's read path
 * (`block-fetch.ts`), so no extra manifest field is needed to record the directory layout. The
 * gzip extension IS recorded in the manifest (`dataset.gzip`) since a query doesn't otherwise
 * know a deploy's build-time compression choice.
 */
export function blockRelPath(hash: string, blockCount: number, compression: Compression = "none"): string {
  const filename = `${hash}.ndjson${compressionSuffix(compression)}`;
  return blockCount > HASH_PREFIX_THRESHOLD ? `blocks/${hash.slice(0, HASH_PREFIX_LEN)}/${filename}` : `blocks/${filename}`;
}

export interface BlockFile extends BlockDescriptor {
  content: string;
}

/** A closed block: its file, and the records it holds (for the indexers to read before it's dropped). */
export interface CutBlock {
  file: BlockFile;
  records: Record<string, unknown>[];
}

/**
 * Cuts records (already globally sorted by `sortField`) into byte-target blocks, one record at a
 * time, handing each block to `onBlock` as it closes — so only the open block is ever held (#28).
 * Equal-key runs are kept contiguous even when that means a block exceeds the target — otherwise
 * the sort field's zonemap ranges could overlap between adjacent blocks (ADR-0002).
 */
export class BlockCutter {
  private records: Record<string, unknown>[] = [];
  private lines: string[] = [];
  private bytes = 0;

  constructor(
    private readonly sortField: string,
    private readonly targetBytes: number,
    private readonly onBlock: (block: CutBlock) => void,
  ) {}

  /** Adds the next record in sort order; `line` is its serialization (`JSON.stringify(record)`). */
  add(record: Record<string, unknown>, line: string): void {
    const lineBytes = Buffer.byteLength(line, "utf8") + 1; // + newline
    const open = this.records.length > 0;
    const wouldExceed = open && this.bytes + lineBytes > this.targetBytes;
    const sameKeyAsLast = open && this.records[this.records.length - 1]![this.sortField] === record[this.sortField];
    if (wouldExceed && !sameKeyAsLast) this.close();

    this.records.push(record);
    this.lines.push(line);
    this.bytes += lineBytes;
  }

  /** Closes the last, partial block. Call once after the last `add`. */
  finish(): void {
    if (this.records.length > 0) this.close();
  }

  private close(): void {
    const content = this.lines.join("\n") + "\n";
    const file: BlockFile = { hash: contentHash(content), bytes: this.bytes, count: this.records.length, content };
    const records = this.records;
    this.records = [];
    this.lines = [];
    this.bytes = 0;
    this.onBlock({ file, records });
  }
}

/** `BlockCutter` over records already in memory, returning just the record groups. */
export function cutIntoBlocks(
  records: Record<string, unknown>[],
  sortField: string,
  targetBytes: number,
): Record<string, unknown>[][] {
  const blocks: Record<string, unknown>[][] = [];
  const cutter = new BlockCutter(sortField, targetBytes, (block) => blocks.push(block.records));
  for (const record of records) cutter.add(record, JSON.stringify(record));
  cutter.finish();
  return blocks;
}
