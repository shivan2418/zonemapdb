import { describe, expect, test } from "vitest";
import { candidateBlockIndices, pairCandidateBlockIndices } from "../src/zonemap.js";

// 3 blocks: block0 [1900,1950), block1 [1950,2000), block2 [2000,2020] (inclusive both ends, last block).
const splitPoints = [1900, 1950, 2000, 2020];

describe("candidateBlockIndices", () => {
  test("no filter (or empty filter) selects every block", () => {
    expect(candidateBlockIndices(splitPoints, undefined)).toEqual([0, 1, 2]);
    expect(candidateBlockIndices(splitPoints, {})).toEqual([0, 1, 2]);
  });

  test("equals selects exactly the one containing block", () => {
    expect(candidateBlockIndices(splitPoints, { equals: 1925 })).toEqual([0]);
    expect(candidateBlockIndices(splitPoints, { equals: 1950 })).toEqual([1]); // boundary → next block
    expect(candidateBlockIndices(splitPoints, { equals: 2020 })).toEqual([2]); // last block is closed both ends
  });

  test("equals outside the global range selects nothing", () => {
    expect(candidateBlockIndices(splitPoints, { equals: 1800 })).toEqual([]);
    expect(candidateBlockIndices(splitPoints, { equals: 2025 })).toEqual([]);
  });

  test("in selects the union of each value's block, deduplicated and sorted", () => {
    expect(candidateBlockIndices(splitPoints, { in: [1925, 2010] })).toEqual([0, 2]);
    expect(candidateBlockIndices(splitPoints, { in: [1925, 1930] })).toEqual([0]);
  });

  test("range (gte/lte) selects the contiguous covering block span", () => {
    expect(candidateBlockIndices(splitPoints, { gte: 1950, lte: 2000 })).toEqual([1, 2]);
  });

  test("an open-ended lower range selects from the start", () => {
    expect(candidateBlockIndices(splitPoints, { lt: 1950 })).toEqual([0]);
  });

  test("an open-ended upper range selects through the end", () => {
    expect(candidateBlockIndices(splitPoints, { gt: 1950 })).toEqual([1, 2]);
  });

  test("an empty manifest (no blocks) selects nothing", () => {
    expect(candidateBlockIndices([], { equals: 2000 })).toEqual([]);
  });

  describe("string split-points (a string sort field range-partitions lexicographically)", () => {
    // 3 blocks: ["Alice","Frank"), ["Frank","Nina"), ["Nina","Zoe"]
    const names = ["Alice", "Frank", "Nina", "Zoe"];

    test("equals selects exactly the one containing block, with boundaries falling forward", () => {
      expect(candidateBlockIndices(names, { equals: "Charlie" })).toEqual([0]);
      expect(candidateBlockIndices(names, { equals: "Frank" })).toEqual([1]);
      expect(candidateBlockIndices(names, { equals: "Zoe" })).toEqual([2]);
    });

    test("values outside the global range select nothing", () => {
      expect(candidateBlockIndices(names, { equals: "Aaron" })).toEqual([]);
      expect(candidateBlockIndices(names, { equals: "Zzz" })).toEqual([]);
    });

    test("a prefix-style range selects the contiguous covering span", () => {
      // The startsWith-becomes-a-range trick the sort field gets for free: ["N", "N￿"].
      // Block 1 spans ["Frank","Nina") and so may hold "Nadia" — including it is the zonemap
      // over-approximating, which is always allowed; excluding a real match never is.
      expect(candidateBlockIndices(names, { gte: "N", lte: "N￿" })).toEqual([1, 2]);
      expect(candidateBlockIndices(names, { gte: "Frank", lte: "Paul" })).toEqual([1, 2]);
      // A prefix at or past a boundary narrows to that block alone ("Nina" <= "Nina").
      expect(candidateBlockIndices(names, { gte: "Nina", lte: "Nina￿" })).toEqual([2]);
    });

    test("in selects the union of each value's block, deduplicated and sorted", () => {
      expect(candidateBlockIndices(names, { in: ["Bob", "Tom"] })).toEqual([0, 2]);
    });

    test("startsWith prunes for free on a string sort field — sorted values make a prefix a contiguous range", () => {
      // The reason a string sort field is worth having: no inverted index, no chunk fetch, just the
      // split-points already in the manifest.
      expect(candidateBlockIndices(names, { startsWith: "Nina" })).toEqual([2]);
      expect(candidateBlockIndices(names, { startsWith: "B" })).toEqual([0]);
      // Over-approximates across a boundary rather than missing: block 1 spans ["Frank","Nina") and
      // could hold "Nadia".
      expect(candidateBlockIndices(names, { startsWith: "N" })).toEqual([1, 2]);
      // A prefix below every stored value prunes to nothing at all.
      expect(candidateBlockIndices(names, { startsWith: "Aa" })).toEqual([]);
      // But a prefix that merely happens to be unused still selects the block whose range brackets
      // it — split-points bound each block, they don't enumerate its contents, so "Qqx" could sit in
      // block 2's ["Nina","Zoe"] span. Over-approximating is always allowed.
      expect(candidateBlockIndices(names, { startsWith: "Qq" })).toEqual([2]);
      // An empty prefix constrains nothing.
      expect(candidateBlockIndices(names, { startsWith: "" })).toEqual([0, 1, 2]);
    });
  });
});

describe("pairCandidateBlockIndices", () => {
  // block0 [Alpha,Golf], block1 [Hotel,Papa], block2 [Quebec,Zulu]
  const pairs: [string, string][] = [
    ["Alpha", "Golf"],
    ["Hotel", "Papa"],
    ["Quebec", "Zulu"],
  ];

  test("equals selects every block whose pair could contain the value", () => {
    expect(pairCandidateBlockIndices(pairs, { equals: "Kilo" })).toEqual(new Set([1]));
  });

  test("equals outside every pair's range selects nothing", () => {
    expect(pairCandidateBlockIndices(pairs, { equals: "0" })).toEqual(new Set());
  });

  test("in selects the union across values", () => {
    expect(pairCandidateBlockIndices(pairs, { in: ["Bravo", "Romeo"] })).toEqual(new Set([0, 2]));
  });

  test("a filter shape with neither equals nor in returns undefined (no zonemap signal)", () => {
    expect(pairCandidateBlockIndices(pairs, {})).toBeUndefined();
  });

  test("skips a block with no bound (zero non-null values for the field)", () => {
    const withGap: [unknown, unknown][] = [
      ["Alpha", "Golf"],
      [undefined, undefined],
      ["Quebec", "Zulu"],
    ];
    expect(pairCandidateBlockIndices(withGap, { equals: "Charlie" })).toEqual(new Set([0]));
  });

  // Range pruning keeps a block iff its [min,max] OVERLAPS the query interval. For number/date the
  // pairs are exact (only string pairs are truncated), so this prunes precisely at block granularity.
  describe("range operators (ADR-0003 §6, secondary number/date fields)", () => {
    // block0 [0,8], block1 [3,12], block2 [20,40] — deliberately overlapping, as real data is.
    const numeric: [number, number][] = [
      [0, 8],
      [3, 12],
      [20, 40],
    ];

    test("gte keeps every block that could still hold a value at or above the bound", () => {
      expect(pairCandidateBlockIndices(numeric, { gte: 10 })).toEqual(new Set([1, 2]));
    });

    test("lte keeps every block reaching at or below the bound", () => {
      expect(pairCandidateBlockIndices(numeric, { lte: 2 })).toEqual(new Set([0]));
    });

    test("gt/lt exclude a block that only touches the bound exactly", () => {
      // block0's max is 8, so `gt: 8` cannot be satisfied there, while `gte: 8` can.
      expect(pairCandidateBlockIndices(numeric, { gte: 8 })).toEqual(new Set([0, 1, 2]));
      expect(pairCandidateBlockIndices(numeric, { gt: 8 })).toEqual(new Set([1, 2]));
      expect(pairCandidateBlockIndices(numeric, { lt: 3 })).toEqual(new Set([0]));
    });

    test("a two-sided range intersects both bounds rather than unioning them", () => {
      expect(pairCandidateBlockIndices(numeric, { gte: 9, lte: 15 })).toEqual(new Set([1]));
    });

    test("a range no block overlaps selects nothing", () => {
      expect(pairCandidateBlockIndices(numeric, { gte: 13, lte: 19 })).toEqual(new Set());
    });

    test("a point and a range on one field are ANDed, pruning more than either alone", () => {
      // `in` alone would admit all three (5 is in block0 and block1, 25 in block2); the range cuts it to one.
      expect(pairCandidateBlockIndices(numeric, { in: [5, 25] })).toEqual(new Set([0, 1, 2]));
      expect(pairCandidateBlockIndices(numeric, { in: [5, 25], gte: 20 })).toEqual(new Set([2]));
    });

    test("pruning reasons per-constraint, so an unsatisfiable combination may still admit a block", () => {
      // Nothing is both ==5 and >=10, but block1 [3,12] could hold a 5 AND could hold something >=10.
      // A pair cannot see that no single value does both. Over-approximating is the contract
      // (ADR-0003 §2) — matchesWhere rejects the records post-fetch.
      expect(pairCandidateBlockIndices(numeric, { equals: 5, gte: 10 })).toEqual(new Set([1]));
    });

    test("ISO date strings compare correctly, since date pairs are stored untruncated", () => {
      const dates: [string, string][] = [
        ["2019-01-01", "2019-06-30"],
        ["2020-01-01", "2020-12-31"],
      ];
      expect(pairCandidateBlockIndices(dates, { gte: "2020-06-01" })).toEqual(new Set([1]));
    });

    test("a block with no bound is skipped by a range too", () => {
      const withGap: [unknown, unknown][] = [[0, 8], [undefined, undefined], [20, 40]];
      expect(pairCandidateBlockIndices(withGap, { gte: 1 })).toEqual(new Set([0, 2]));
    });
  });
});
