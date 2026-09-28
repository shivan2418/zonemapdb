import { describe, expect, test } from "vitest";
import { BlockCutter, type BlockFile } from "../src/block.js";

/** Cuts `records` (already sorted by `year`) and returns the block files, as `build` receives them. */
function cut(records: Record<string, unknown>[], targetBytes: number): BlockFile[] {
  const files: BlockFile[] = [];
  const cutter = new BlockCutter("year", targetBytes, (block) => files.push(block.file));
  for (const record of records) cutter.add(record, JSON.stringify(record));
  cutter.finish();
  return files;
}

describe("BlockCutter block files", () => {
  test("serializes each block to newline-terminated NDJSON with a content hash", () => {
    const files = cut(
      [
        { year: 2000, title: "A" },
        { year: 2001, title: "B" },
        { year: 2001, title: "C" },
      ],
      30,
    );
    expect(files).toHaveLength(2);
    expect(files[0]!.content).toBe('{"year":2000,"title":"A"}\n');
    expect(files[0]!.count).toBe(1);
    expect(files[1]!.count).toBe(2);
    expect(files[1]!.content).toBe('{"year":2001,"title":"B"}\n{"year":2001,"title":"C"}\n');
    for (const file of files) {
      expect(file.hash).toMatch(/^[0-9a-f]{16}$/);
      expect(file.bytes).toBe(Buffer.byteLength(file.content, "utf8"));
    }
  });

  test("the same records always produce the same hashes (determinism)", () => {
    const records = [{ year: 2000 }, { year: 2001 }, { year: 2002 }];
    expect(cut(records, 1).map((f) => f.hash)).toEqual(cut(records, 1).map((f) => f.hash));
  });

  test("no records, no blocks", () => {
    expect(cut([], 100)).toEqual([]);
  });
});
