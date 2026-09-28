import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { compareRecordsForSort, compareSortValues, ExternalSorter, externalSort } from "../src/sort.js";

describe("compareSortValues", () => {
  test("orders numbers ascending", () => {
    expect(compareSortValues(1, 2, "number")).toBeLessThan(0);
    expect(compareSortValues(2, 1, "number")).toBeGreaterThan(0);
    expect(compareSortValues(2, 2, "number")).toBe(0);
  });

  test("orders ISO date strings ascending", () => {
    expect(compareSortValues("2000-01-01", "2010-01-01", "date")).toBeLessThan(0);
    expect(compareSortValues("2010-01-01", "2000-01-01", "date")).toBeGreaterThan(0);
    expect(compareSortValues("2000-01-01", "2000-01-01", "date")).toBe(0);
  });

  test("treats missing values (null/undefined) as sorting after any real value", () => {
    expect(compareSortValues(undefined, 1, "number")).toBeGreaterThan(0);
    expect(compareSortValues(1, undefined, "number")).toBeLessThan(0);
    expect(compareSortValues(null, 1, "number")).toBeGreaterThan(0);
    expect(compareSortValues(undefined, undefined, "number")).toBe(0);
  });

  test("distinguishes null from absent within the missing tail: null sorts before undefined", () => {
    expect(compareSortValues(null, undefined, "number")).toBeLessThan(0);
    expect(compareSortValues(undefined, null, "number")).toBeGreaterThan(0);
    expect(compareSortValues(null, null, "number")).toBe(0);
  });
});

describe("compareRecordsForSort", () => {
  test("falls back to the declared pk when sort-field values tie", () => {
    const a = { year: 2000, id: "b" };
    const b = { year: 2000, id: "a" };
    expect(compareRecordsForSort(a, b, "year", "number", "id")).toBeGreaterThan(0);
    expect(compareRecordsForSort(b, a, "year", "number", "id")).toBeLessThan(0);
  });

  test("without a pk, falls back to a canonical full-record comparison — independent of input order", () => {
    const a = { year: 2000, title: "Zeta" };
    const b = { year: 2000, title: "Alpha" };
    const direct = compareRecordsForSort(a, b, "year", "number");
    const reversed = compareRecordsForSort(b, a, "year", "number");
    expect(direct).not.toBe(0);
    expect(Math.sign(direct)).toBe(-Math.sign(reversed));
  });

  test("identical records tie at 0 regardless of pk", () => {
    const a = { year: 2000, id: "x" };
    const b = { year: 2000, id: "x" };
    expect(compareRecordsForSort(a, b, "year", "number", "id")).toBe(0);
  });
});

describe("externalSort", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "zonedb-sort-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("sorts entirely in memory when the source fits within one run", () => {
    const records = [{ year: 2002 }, { year: 2000 }, { year: 2001 }];
    const sorted = externalSort(records, { sortField: "year", kind: "number", runRecords: 10, tmpDir });
    expect(sorted.map((r) => r.year)).toEqual([2000, 2001, 2002]);
    expect(readdirSync(tmpDir)).toEqual([]);
  });

  test("spills to disk and merges when the source exceeds one run, matching an in-memory sort", () => {
    const records = Array.from({ length: 23 }, (_, i) => ({ year: 1000 - i, id: String(i) }));
    const expected = [...records].sort((a, b) => a.year - b.year);

    const sorted = externalSort(records, { sortField: "year", kind: "number", runRecords: 5, tmpDir });

    expect(sorted).toEqual(expected);
    // temp run files are cleaned up afterward
    expect(readdirSync(tmpDir)).toEqual([]);
  });

  test("merges correctly when a single run's content spans multiple internal read chunks, including multi-byte UTF-8 near chunk boundaries", () => {
    // Each run holds 2,000 records with multi-byte text — several times the reader's internal
    // 64KB buffer — forcing the run reader to refill mid-run, including mid-multi-byte-sequence.
    const recordsPerRun = 2000;
    const runCount = 3;
    const records = Array.from({ length: recordsPerRun * runCount }, (_, i) => ({
      id: recordsPerRun * runCount - i, // descending input order, ascending expected sort
      title: `café 日本語 movie #${i} 🎬`,
    }));
    const expected = [...records].sort((a, b) => a.id - b.id);

    const sorted = externalSort(records, { sortField: "id", kind: "number", runRecords: recordsPerRun, tmpDir });

    expect(sorted).toEqual(expected);
    expect(readdirSync(tmpDir)).toEqual([]);
  });

  test("preserves equal-key contiguity and the pk tiebreak across the run boundary", () => {
    const records = [
      { year: 2000, id: "c" },
      { year: 2000, id: "a" },
      { year: 1999, id: "z" },
      { year: 2000, id: "b" },
      { year: 2001, id: "d" },
    ];
    const sorted = externalSort(records, { sortField: "year", kind: "number", pk: "id", runRecords: 2, tmpDir });
    expect(sorted).toEqual([
      { year: 1999, id: "z" },
      { year: 2000, id: "a" },
      { year: 2000, id: "b" },
      { year: 2000, id: "c" },
      { year: 2001, id: "d" },
    ]);
  });

  test("clusters missing sort values (null before absent) at the high end across a spill", () => {
    const records = [
      { year: 5 },
      { year: undefined },
      { year: 1 },
      { year: null },
      { year: 3 },
      { year: 2 },
      { year: 4 },
    ];
    const sorted = externalSort(records, { sortField: "year", kind: "number", runRecords: 2, tmpDir });
    expect(sorted.map((r) => r.year)).toEqual([1, 2, 3, 4, 5, null, undefined]);
  });

  test("spills on bytes as well as record count, so a few huge records can't fill memory", () => {
    const records = Array.from({ length: 12 }, (_, i) => ({ id: 12 - i, text: "x".repeat(1000) }));
    const sorter = new ExternalSorter({ sortField: "id", kind: "number", runRecords: 1_000_000, runBytes: 3000, tmpDir });
    try {
      for (const record of records) sorter.add(record);
      // Three records of ~1 KB each reach the byte limit — the run files exist before any merging.
      expect(readdirSync(tmpDir).filter((name) => name.startsWith("zonedb-sort-"))).toHaveLength(1);
      expect([...sorter.sorted()].map((item) => item.record.id)).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
    } finally {
      sorter.close();
    }
    expect(readdirSync(tmpDir)).toEqual([]);
  });

  test("hands back each record with its serialized line, whether it was spilled or not", () => {
    const records = [{ id: 2, t: "b" }, { id: 1, t: "a" }, { id: 3, t: "c" }];
    for (const runRecords of [1, 10]) {
      const sorter = new ExternalSorter({ sortField: "id", kind: "number", runRecords, tmpDir });
      for (const record of records) sorter.add(record);
      const items = [...sorter.sorted()];
      sorter.close();
      expect(items.map((item) => item.line)).toEqual(['{"id":1,"t":"a"}', '{"id":2,"t":"b"}', '{"id":3,"t":"c"}']);
      for (const item of items) expect(JSON.stringify(item.record)).toBe(item.line);
    }
  });

  test("merges many runs in exactly the order a single in-memory sort gives, ties included", () => {
    // Heavy key repetition and a pk that doesn't break every tie, so the full-line tie-break decides.
    const records = Array.from({ length: 997 }, (_, i) => ({ year: (i * 7919) % 13, id: i % 5, n: (i * 31) % 97 }));
    const opts = { sortField: "year", kind: "number" as const, pk: "id", tmpDir };
    expect(externalSort(records, { ...opts, runRecords: 7 })).toEqual(externalSort(records, { ...opts, runRecords: 10_000 }));
  });
});
