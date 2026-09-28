import { describe, expect, test } from "vitest";
import {
  buildInvertedIndex,
  buildReversedIndex,
  buildTrigramIndex,
  computeColumnBytes,
  computeSecondaryZonemap,
  reverseString,
  truncateStringLower,
  truncateStringUpper,
} from "../src/secondary-index.js";
import type { IndexChunkFile } from "../src/secondary-index.js";

describe("truncateStringLower / truncateStringUpper", () => {
  test("short strings pass through untouched", () => {
    expect(truncateStringLower("Cameron")).toBe("Cameron");
    expect(truncateStringUpper("Cameron")).toBe("Cameron");
  });

  test("long strings are truncated to the max length on the lower bound", () => {
    expect(truncateStringLower("Zwigoff, Terry", 8)).toBe("Zwigoff,");
  });

  test("the upper bound is a next-string-after marker: every string sharing the prefix compares less than it", () => {
    const upper = truncateStringUpper("Zwigoff, Terry", 8);
    expect(upper).not.toBe("Zwigoff,");
    for (const v of ["Zwigoff, Terry", "Zwigoff, Terrylabel", "Zwigoff, Terry Jr", "Zwigoff, T"]) {
      expect(v < upper).toBe(true);
    }
  });
});

describe("computeSecondaryZonemap", () => {
  test("string field: per-block truncated [min,max] pairs, marked truncated", () => {
    const groups = [
      [{ title: "Gladiator" }, { title: "Snatch" }],
      [{ title: "Interstellar" }, { title: "Parasite" }],
    ];
    const zonemap = computeSecondaryZonemap(groups, "title", "string");
    expect(zonemap.truncated).toBe(true);
    expect(zonemap.pairs).toEqual([
      ["Gladiator", "Snatch"],
      ["Interstellar", "Parasite"],
    ]);
  });

  test("number field: raw min/max pairs, no truncation flag", () => {
    const groups = [[{ rating: 8.7 }, { rating: 7.2 }], [{ rating: 9.0 }]];
    const zonemap = computeSecondaryZonemap(groups, "rating", "number");
    expect(zonemap.truncated).toBeUndefined();
    expect(zonemap.pairs).toEqual([
      [7.2, 8.7],
      [9.0, 9.0],
    ]);
  });

  test("ignores null/undefined values when computing min/max", () => {
    const groups = [[{ rating: null }, { rating: 5 }, { rating: 8 }, { rating: undefined }]];
    const zonemap = computeSecondaryZonemap(groups, "rating", "number");
    expect(zonemap.pairs).toEqual([[5, 8]]);
  });
});

/** Independently reconstructs the values a chunk's front-coded dictionary encodes. */
function decodeChunk(content: string): { value: string; blocks: number[] }[] {
  const file = JSON.parse(content) as IndexChunkFile;
  let prevKey = "";
  return file.entries.map((entry) => {
    prevKey = prevKey.slice(0, entry.prefixLen) + entry.suffix;
    let acc = 0;
    const blocks = entry.postings.map((delta) => (acc += delta));
    return { value: prevKey, blocks };
  });
}

describe("buildInvertedIndex", () => {
  test("one chunk: sorted distinct values with correct per-block postings, including a repeated value across blocks", () => {
    const groups = [
      [{ title: "Snatch" }], // block 0
      [{ title: "Gladiator" }, { title: "Memento" }], // block 1
      [{ title: "Gladiator" }], // block 2 — repeats block 1's value
    ];
    const chunks = buildInvertedIndex(groups, "title", "string", 1_000_000);
    expect(chunks).toHaveLength(1);

    const decoded = decodeChunk(chunks[0]!.content);
    expect(decoded.map((d) => d.value)).toEqual(["Gladiator", "Memento", "Snatch"]);
    expect(decoded.find((d) => d.value === "Gladiator")?.blocks).toEqual([1, 2]);
    expect(decoded.find((d) => d.value === "Memento")?.blocks).toEqual([1]);
    expect(decoded.find((d) => d.value === "Snatch")?.blocks).toEqual([0]);
    expect(chunks[0]!.from).toBe("Gladiator");
    expect(chunks[0]!.to).toBe("Snatch");
  });

  test("front-codes a shared prefix between adjacent sorted values", () => {
    const groups = [[{ name: "Cameron, James" }], [{ name: "Cameron, Jane" }]];
    const chunks = buildInvertedIndex(groups, "name", "string", 1_000_000);
    const file = JSON.parse(chunks[0]!.content) as IndexChunkFile;
    expect(file.entries[0]!.prefixLen).toBe(0);
    expect(file.entries[1]!.prefixLen).toBeGreaterThan(0);
    expect(file.entries[1]!.suffix.length).toBeLessThan("Cameron, Jane".length);
  });

  test("splits into multiple byte-target chunks, each self-decodable and covering a contiguous value range", () => {
    const titles = ["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot", "Golf", "Hotel"];
    const groups = titles.map((t) => [{ title: t }]);
    const chunks = buildInvertedIndex(groups, "title", "string", 40);
    expect(chunks.length).toBeGreaterThan(1);

    const allValues: string[] = [];
    for (const chunk of chunks) {
      const file = JSON.parse(chunk.content) as IndexChunkFile;
      expect(file.entries[0]!.prefixLen).toBe(0); // resets per chunk — independently fetchable/decodable

      const decoded = decodeChunk(chunk.content);
      expect(chunk.from).toBe(decoded[0]!.value);
      expect(chunk.to).toBe(decoded[decoded.length - 1]!.value);
      allValues.push(...decoded.map((d) => d.value));
    }
    expect(allValues).toEqual([...titles].sort());
  });

  test("number kind: dictionary values round-trip through the canonical-key encoding", () => {
    const groups = [[{ rating: 8.7 }], [{ rating: 7.2 }, { rating: 9.0 }]];
    const chunks = buildInvertedIndex(groups, "rating", "number", 1_000_000);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.from).toBe(7.2);
    expect(chunks[0]!.to).toBe(9.0);
  });

  test("returns no chunks when the field has no non-null values", () => {
    expect(buildInvertedIndex([[{ title: null }]], "title", "string", 1_000_000)).toEqual([]);
  });
});

describe("reverseString", () => {
  test("reverses a plain ASCII string", () => {
    expect(reverseString("Gladiator")).toBe("rotaidalG");
  });

  test("is codepoint-safe for astral characters", () => {
    expect(reverseString("a😄b")).toBe("b😄a");
  });
});

describe("buildReversedIndex (T6 — endsWith)", () => {
  test("dictionary is keyed on the reversed value, sorted in reversed order", () => {
    const groups = [[{ title: "Gladiator" }], [{ title: "Interstellar" }]];
    const chunks = buildReversedIndex(groups, "title", 1_000_000);
    expect(chunks).toHaveLength(1);
    const decoded = decodeChunk(chunks[0]!.content);
    // "Gladiator" -> "rotaidalG", "Interstellar" -> "ralletsretnI" — sorted lexicographically.
    expect(decoded.map((d) => d.value)).toEqual(["ralletsretnI", "rotaidalG"].sort());
  });

  test("blocks a value's reversed form spans are still tracked per-block, including repeats across blocks", () => {
    const groups = [[{ title: "Snatch" }], [{ title: "Gladiator" }], [{ title: "Gladiator" }]];
    const chunks = buildReversedIndex(groups, "title", 1_000_000);
    const decoded = decodeChunk(chunks[0]!.content);
    expect(decoded.find((d) => d.value === reverseString("Gladiator"))?.blocks).toEqual([1, 2]);
  });

  test("ignores null/undefined values", () => {
    expect(buildReversedIndex([[{ title: null }, { title: undefined }]], "title", 1_000_000)).toEqual([]);
  });
});

describe("buildTrigramIndex (T6 — contains)", () => {
  test("dictionary is keyed on distinct trigrams, sorted, with per-block postings", () => {
    const groups = [[{ title: "cat" }], [{ title: "car" }]];
    const chunks = buildTrigramIndex(groups, "title", 1_000_000);
    const decoded = decodeChunk(chunks[0]!.content);
    // "cat" -> {"cat"}, "car" -> {"car"} — share the "ca" prefix but are distinct trigrams.
    expect(decoded.map((d) => d.value).sort()).toEqual(["car", "cat"]);
    expect(decoded.find((d) => d.value === "cat")?.blocks).toEqual([0]);
    expect(decoded.find((d) => d.value === "car")?.blocks).toEqual([1]);
  });

  test("a value contributes every sliding 3-char window, deduplicated per block", () => {
    const groups = [[{ title: "abcabc" }]];
    const chunks = buildTrigramIndex(groups, "title", 1_000_000);
    const decoded = decodeChunk(chunks[0]!.content);
    // windows: abc, bca, cab, abc(dup) -> distinct trigrams {abc, bca, cab}, each posting [0] once.
    expect(decoded.map((d) => d.value).sort()).toEqual(["abc", "bca", "cab"]);
    for (const entry of decoded) expect(entry.blocks).toEqual([0]);
  });

  test("values shorter than 3 characters contribute no trigrams", () => {
    expect(buildTrigramIndex([[{ title: "ab" }]], "title", 1_000_000)).toEqual([]);
  });

  test("ignores null/undefined values", () => {
    expect(buildTrigramIndex([[{ title: null }, { title: undefined }]], "title", 1_000_000)).toEqual([]);
  });
});

describe("multi-valued (object-array scalar-leaf) fields (T7)", () => {
  test("computeSecondaryZonemap flattens each record's array into the block's min/max", () => {
    const groups = [[{ genres: ["Sci-Fi", "Action"] }, { genres: ["Drama"] }]];
    const zonemap = computeSecondaryZonemap(groups, "genres", "string", true);
    expect(zonemap.pairs).toEqual([[truncateStringLower("Action"), truncateStringUpper("Sci-Fi")]]);
  });

  test("buildInvertedIndex indexes every element, one block-posting per record regardless of element count", () => {
    const groups = [
      [{ genres: ["Sci-Fi", "Action"] }], // block 0 — two elements
      [{ genres: ["Sci-Fi"] }], // block 1 — repeats "Sci-Fi"
    ];
    const chunks = buildInvertedIndex(groups, "genres", "string", 1_000_000, true);
    const decoded = decodeChunk(chunks[0]!.content);
    expect(decoded.map((d) => d.value).sort()).toEqual(["Action", "Sci-Fi"]);
    expect(decoded.find((d) => d.value === "Sci-Fi")?.blocks).toEqual([0, 1]);
    expect(decoded.find((d) => d.value === "Action")?.blocks).toEqual([0]);
  });

  test("a record with an empty array or missing field contributes nothing", () => {
    const groups = [[{ genres: [] }, { other: 1 }]];
    expect(buildInvertedIndex(groups, "genres", "string", 1_000_000, true)).toEqual([]);
  });

  test("buildReversedIndex/buildTrigramIndex also index every element", () => {
    const groups = [[{ genres: ["Sci-Fi", "Action"] }]];
    const reversed = decodeChunk(buildReversedIndex(groups, "genres", 1_000_000, true)[0]!.content);
    expect(reversed.map((d) => d.value).sort()).toEqual([reverseString("Action"), reverseString("Sci-Fi")].sort());

    const trigrams = decodeChunk(buildTrigramIndex(groups, "genres", 1_000_000, true)[0]!.content);
    expect(trigrams.map((d) => d.value)).toContain("Sci");
    expect(trigrams.map((d) => d.value)).toContain("Act");
  });

  test("computeColumnBytes sums every element's bytes", () => {
    const groups = [[{ genres: ["cat", "dog"] }]];
    expect(computeColumnBytes(groups, "genres", true)).toBe(6);
  });
});

describe("computeColumnBytes", () => {
  test("sums UTF-8 byte length of the field's non-null string values across all groups", () => {
    const groups = [[{ title: "cat" }, { title: null }], [{ title: "dog" }]];
    expect(computeColumnBytes(groups, "title")).toBe(6);
  });

  test("counts multi-byte UTF-8 characters correctly", () => {
    expect(computeColumnBytes([[{ title: "😄" }]], "title")).toBe(Buffer.byteLength("😄", "utf8"));
  });

  test("returns 0 for an empty/absent field", () => {
    expect(computeColumnBytes([[{ title: null }]], "title")).toBe(0);
  });
});
