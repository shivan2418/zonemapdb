import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { scanInput } from "../src/init.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), "zonedb-scan-"));
  // A glob read in filename order: the first file alone would say every record is from "AK".
  for (const state of ["ak", "mn", "tx"]) {
    const lines = Array.from({ length: 3000 }, (_, i) => JSON.stringify({ id: `${state}-${i}`, state: state.toUpperCase() }));
    writeFileSync(path.join(tmpDir, `${state}.ndjson`), lines.join("\n") + "\n");
  }
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

const readOpts = { format: "ndjson" as const, delimiter: ",", fields: {} };

describe("scanInput (#29)", () => {
  test("infers from every file of a glob, and samples all of them for the estimates", () => {
    const scan = scanInput(path.join(tmpDir, "*.ndjson"), readOpts, { estimateSample: 300, measureBytes: true });

    expect(scan.inferred.recordCount).toBe(9000);
    expect(scan.inferred.fields.state!.values).toEqual(["AK", "MN", "TX"]);
    expect(scan.inferred.pk).toBe("id");

    expect(scan.sample).toHaveLength(300);
    const states = new Set(scan.sample.map((r) => r.state));
    expect(states).toEqual(new Set(["AK", "MN", "TX"]));

    expect(scan.population.recordCount).toBe(9000);
    expect(scan.population.datasetBytes).toBeGreaterThan(9000 * 20);
  });

  test("an explicit sample limit reads only the head", () => {
    const scan = scanInput(path.join(tmpDir, "*.ndjson"), { ...readOpts, limit: 100 });
    expect(scan.inferred.recordCount).toBe(100);
    expect(scan.inferred.fields.state!.values).toEqual(["AK"]);
    expect(scan.population.datasetBytes).toBe(0); // not asked to measure
  });

  test("an empty input fails loud", () => {
    writeFileSync(path.join(tmpDir, "empty.ndjson"), "");
    expect(() => scanInput(path.join(tmpDir, "empty.ndjson"), readOpts)).toThrow(/no records/);
  });
});
