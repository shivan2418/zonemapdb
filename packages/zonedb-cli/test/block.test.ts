import { describe, expect, test } from "vitest";
import { cutIntoBlocks, blockRelPath } from "../src/block.js";

function records(years: number[]): Record<string, unknown>[] {
  return years.map((year, i) => ({ id: i, year, title: `Movie ${i}` }));
}

describe("cutIntoBlocks", () => {
  test("puts everything in one block when under the byte target", () => {
    const blocks = cutIntoBlocks(records([2000, 2001, 2002]), "year", 1_000_000);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toHaveLength(3);
  });

  test("cuts into multiple blocks once the byte target is exceeded", () => {
    // Each record line is small; pick a tiny target to force multiple cuts.
    const blocks = cutIntoBlocks(records([2000, 2001, 2002, 2003, 2004, 2005]), "year", 40);
    expect(blocks.length).toBeGreaterThan(1);
    // Every record must appear exactly once, in original sorted order.
    const flatYears = blocks.flat().map((r) => r.year);
    expect(flatYears).toEqual([2000, 2001, 2002, 2003, 2004, 2005]);
  });

  test("keeps equal-key runs contiguous even when they exceed the byte target", () => {
    const recs = records([2000, 2000, 2000, 2000, 2001]);
    const blocks = cutIntoBlocks(recs, "year", 10); // tiny target — would split every record
    // All four 2000s must land in the same block.
    const blockOf2000 = blocks.find((s) => s.some((r) => r.year === 2000));
    expect(blockOf2000?.every((r) => r.year === 2000 || r.year === 2001)).toBe(true);
    const countOf2000 = blocks.flatMap((s) => s).filter((r) => r.year === 2000).length;
    expect(countOf2000).toBe(4);
    // and no block has both 2000 and 2001 split with another block also holding 2000
    const blocksWith2000 = blocks.filter((s) => s.some((r) => r.year === 2000));
    expect(blocksWith2000).toHaveLength(1);
  });

  test("never produces an empty block", () => {
    const blocks = cutIntoBlocks(records([2000, 2001, 2002]), "year", 1);
    for (const block of blocks) {
      expect(block.length).toBeGreaterThan(0);
    }
  });
});

describe("blockRelPath", () => {
  test("stays flat at or under the ~1,000-block threshold", () => {
    expect(blockRelPath("abc123", 1)).toBe("blocks/abc123.ndjson");
    expect(blockRelPath("abc123", 1000)).toBe("blocks/abc123.ndjson");
  });

  test("nests under a 2-hex-char prefix subdir past the threshold", () => {
    expect(blockRelPath("abc123", 1001)).toBe("blocks/ab/abc123.ndjson");
  });
});
