import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { countInputRecords, expandInputFiles, readInputRecords } from "../src/input.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), "zonedb-input-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

const FIELDS = {
  year: { kind: "number" as const },
  title: { kind: "string" as const },
  rating: { kind: "number" as const },
  isClassic: { kind: "boolean" as const },
};

describe("expandInputFiles", () => {
  test("a literal path with no glob magic resolves to itself", () => {
    expect(expandInputFiles(path.join(tmpDir, "movies.ndjson"))).toEqual([path.join(tmpDir, "movies.ndjson")]);
  });

  test("a glob pattern expands to every matching file, sorted", () => {
    writeFileSync(path.join(tmpDir, "b.ndjson"), "");
    writeFileSync(path.join(tmpDir, "a.ndjson"), "");
    writeFileSync(path.join(tmpDir, "c.json"), "");
    expect(expandInputFiles(path.join(tmpDir, "*.ndjson"))).toEqual([
      path.join(tmpDir, "a.ndjson"),
      path.join(tmpDir, "b.ndjson"),
    ]);
  });

  test("a glob pattern with no matches expands to an empty list", () => {
    expect(expandInputFiles(path.join(tmpDir, "*.nope"))).toEqual([]);
  });

  test("** matches nested directories recursively", () => {
    mkdirSync(path.join(tmpDir, "sub"), { recursive: true });
    writeFileSync(path.join(tmpDir, "top.ndjson"), "");
    writeFileSync(path.join(tmpDir, "sub", "nested.ndjson"), "");
    expect(expandInputFiles(path.join(tmpDir, "**", "*.ndjson"))).toEqual([
      path.join(tmpDir, "sub", "nested.ndjson"),
      path.join(tmpDir, "top.ndjson"),
    ]);
  });
});

describe("readInputRecords — ndjson", () => {
  test("reads one record per non-blank line", () => {
    writeFileSync(
      path.join(tmpDir, "movies.ndjson"),
      [{ year: 1999, title: "The Matrix" }, { year: 2000, title: "Gladiator" }].map((r) => JSON.stringify(r)).join("\n") + "\n",
    );
    const records = readInputRecords(path.join(tmpDir, "movies.ndjson"), {
      format: "ndjson",
      delimiter: ",",
      fields: FIELDS,
    });
    expect(records).toEqual([
      { year: 1999, title: "The Matrix" },
      { year: 2000, title: "Gladiator" },
    ]);
  });
});

describe("readInputRecords — json record selectors", () => {
  test("array element selector: top-level array, each element is a record", () => {
    writeFileSync(
      path.join(tmpDir, "movies.json"),
      JSON.stringify([
        { year: 1999, title: "The Matrix" },
        { year: 2000, title: "Gladiator" },
      ]),
    );
    const records = readInputRecords(path.join(tmpDir, "movies.json"), {
      format: "json",
      delimiter: ",",
      fields: FIELDS,
    });
    expect(records).toEqual([
      { year: 1999, title: "The Matrix" },
      { year: 2000, title: "Gladiator" },
    ]);
  });

  test("map value selector: top-level object, each value is a record (keys discarded)", () => {
    writeFileSync(
      path.join(tmpDir, "movies.json"),
      JSON.stringify({
        matrix: { year: 1999, title: "The Matrix" },
        gladiator: { year: 2000, title: "Gladiator" },
      }),
    );
    const records = readInputRecords(path.join(tmpDir, "movies.json"), {
      format: "json",
      delimiter: ",",
      fields: FIELDS,
    });
    expect(records).toEqual(
      expect.arrayContaining([
        { year: 1999, title: "The Matrix" },
        { year: 2000, title: "Gladiator" },
      ]),
    );
    expect(records).toHaveLength(2);
  });

  test("records path selector: navigates a nested array, doesn't flatten deeper arrays inside a record", () => {
    writeFileSync(
      path.join(tmpDir, "movies.json"),
      JSON.stringify({
        meta: { generatedAt: "2026-01-01" },
        data: {
          records: [
            { year: 1999, title: "The Matrix", genres: ["Sci-Fi", "Action"] },
            { year: 2000, title: "Gladiator", genres: ["Action", "Drama"] },
          ],
        },
      }),
    );
    const records = readInputRecords(path.join(tmpDir, "movies.json"), {
      format: "json",
      delimiter: ",",
      recordsPath: "data.records",
      fields: FIELDS,
    });
    // exactly 2 records (the nested genres arrays are NOT flattened into extra records)
    expect(records).toHaveLength(2);
    expect(records[0]).toEqual({ year: 1999, title: "The Matrix", genres: ["Sci-Fi", "Action"] });
    expect(records[1]).toEqual({ year: 2000, title: "Gladiator", genres: ["Action", "Drama"] });
  });

  test("records path selector landing on a map also works (map value under a nested path)", () => {
    writeFileSync(
      path.join(tmpDir, "movies.json"),
      JSON.stringify({
        data: {
          records: {
            matrix: { year: 1999, title: "The Matrix" },
          },
        },
      }),
    );
    const records = readInputRecords(path.join(tmpDir, "movies.json"), {
      format: "json",
      delimiter: ",",
      recordsPath: "data.records",
      fields: FIELDS,
    });
    expect(records).toEqual([{ year: 1999, title: "The Matrix" }]);
  });

  test("throws a clear error when the records path doesn't land on an array or object", () => {
    writeFileSync(path.join(tmpDir, "movies.json"), JSON.stringify({ data: { records: "not-a-collection" } }));
    expect(() =>
      readInputRecords(path.join(tmpDir, "movies.json"), {
        format: "json",
        delimiter: ",",
        recordsPath: "data.records",
        fields: FIELDS,
      }),
    ).toThrow(/records/);
  });
});

describe("readInputRecords — csv/tsv", () => {
  test("parses a header row into typed records per the declared field kinds", () => {
    writeFileSync(path.join(tmpDir, "movies.csv"), "year,title,rating\n1999,The Matrix,8.7\n2000,Gladiator,8.5\n");
    const records = readInputRecords(path.join(tmpDir, "movies.csv"), {
      format: "csv",
      delimiter: ",",
      fields: FIELDS,
    });
    expect(records).toEqual([
      { year: 1999, title: "The Matrix", rating: 8.7 },
      { year: 2000, title: "Gladiator", rating: 8.5 },
    ]);
  });

  test("handles quoted fields containing the delimiter, embedded newlines, and escaped quotes", () => {
    writeFileSync(
      path.join(tmpDir, "movies.csv"),
      'year,title,rating\n1999,"The Matrix, Reloaded",7.2\n2000,"Multi\nline ""Title""",8.5\n',
    );
    const records = readInputRecords(path.join(tmpDir, "movies.csv"), {
      format: "csv",
      delimiter: ",",
      fields: FIELDS,
    });
    expect(records).toEqual([
      { year: 1999, title: "The Matrix, Reloaded", rating: 7.2 },
      { year: 2000, title: 'Multi\nline "Title"', rating: 8.5 },
    ]);
  });

  test("tsv is tab-delimited by default", () => {
    writeFileSync(path.join(tmpDir, "movies.tsv"), "year\ttitle\trating\n1999\tThe Matrix\t8.7\n");
    const records = readInputRecords(path.join(tmpDir, "movies.tsv"), {
      format: "tsv",
      delimiter: "\t",
      fields: FIELDS,
    });
    expect(records).toEqual([{ year: 1999, title: "The Matrix", rating: 8.7 }]);
  });

  test("coerces boolean-kind cells from literal true/false", () => {
    writeFileSync(path.join(tmpDir, "movies.csv"), "year,title,rating,isClassic\n1999,The Matrix,8.7,true\n2000,Gladiator,8.5,false\n");
    const records = readInputRecords(path.join(tmpDir, "movies.csv"), {
      format: "csv",
      delimiter: ",",
      fields: FIELDS,
    });
    expect(records).toEqual([
      { year: 1999, title: "The Matrix", rating: 8.7, isClassic: true },
      { year: 2000, title: "Gladiator", rating: 8.5, isClassic: false },
    ]);
  });

  test("fails loud on a boolean-kind cell that isn't literal true/false, rather than admitting a string", () => {
    writeFileSync(path.join(tmpDir, "movies.csv"), "year,title,rating,isClassic\n1999,The Matrix,8.7,yes\n");
    expect(() =>
      readInputRecords(path.join(tmpDir, "movies.csv"), { format: "csv", delimiter: ",", fields: FIELDS }),
    ).toThrow(/isClassic.*boolean/i);
  });

  test("fails loud on a number-kind cell that isn't a valid number, rather than admitting NaN", () => {
    writeFileSync(path.join(tmpDir, "movies.csv"), "year,title,rating\nnineteen-ninety-nine,The Matrix,8.7\n");
    expect(() =>
      readInputRecords(path.join(tmpDir, "movies.csv"), { format: "csv", delimiter: ",", fields: FIELDS }),
    ).toThrow(/year.*number/i);
  });

  test("fails loud on a number-kind cell that parses to Infinity, which JSON would store as null", () => {
    for (const cell of ["Infinity", "-Infinity", "1e999"]) {
      writeFileSync(path.join(tmpDir, "movies.csv"), `year,title,rating\n${cell},The Matrix,8.7\n`);
      expect(() =>
        readInputRecords(path.join(tmpDir, "movies.csv"), { format: "csv", delimiter: ",", fields: FIELDS }),
      ).toThrow(/year.*isn't a finite number/i);
    }
  });

  test("an empty cell is treated as an absent field, not coerced to NaN/empty-string", () => {
    writeFileSync(path.join(tmpDir, "movies.csv"), "year,title,rating\n1999,The Matrix,\n");
    const records = readInputRecords(path.join(tmpDir, "movies.csv"), {
      format: "csv",
      delimiter: ",",
      fields: FIELDS,
    });
    expect(records).toEqual([{ year: 1999, title: "The Matrix" }]);
    expect(records[0]).not.toHaveProperty("rating");
  });
});

describe("readInputRecords — glob merges same-format files as one dataset", () => {
  test("concatenates records from every matched file, in filename order", () => {
    writeFileSync(path.join(tmpDir, "1990s.ndjson"), JSON.stringify({ year: 1999, title: "The Matrix" }) + "\n");
    writeFileSync(path.join(tmpDir, "2000s.ndjson"), JSON.stringify({ year: 2000, title: "Gladiator" }) + "\n");
    const records = readInputRecords(path.join(tmpDir, "*.ndjson"), {
      format: "ndjson",
      delimiter: ",",
      fields: FIELDS,
    });
    expect(records).toEqual([
      { year: 1999, title: "The Matrix" },
      { year: 2000, title: "Gladiator" },
    ]);
  });

  test("throws a clear error when the glob matches nothing", () => {
    expect(() =>
      readInputRecords(path.join(tmpDir, "*.ndjson"), { format: "ndjson", delimiter: ",", fields: FIELDS }),
    ).toThrow(/no input files matched/i);
  });
});

describe("readInputRecords — datasets past the argument-spread limit", () => {
  // `push(...array)` throws "Maximum call stack size exceeded" somewhere above ~100k elements, so a
  // dataset of exactly the size this tool targets used to fail outright. Records are kept tiny so
  // the guard costs little; the count is what's under test.
  const BIG = 200_000;

  test("reads an NDJSON file with more records than can be spread as arguments", () => {
    const file = path.join(tmpDir, "big.ndjson");
    writeFileSync(file, Array.from({ length: BIG }, (_, i) => `{"year":${i}}`).join("\n") + "\n");
    const records = readInputRecords(file, { format: "ndjson", delimiter: ",", fields: FIELDS });
    expect(records).toHaveLength(BIG);
    expect(records[BIG - 1]).toEqual({ year: BIG - 1 });
  });

  test("reads a JSON document with more records than can be spread as arguments", () => {
    const file = path.join(tmpDir, "big.json");
    writeFileSync(file, JSON.stringify(Array.from({ length: BIG }, (_, i) => ({ year: i }))));
    const records = readInputRecords(file, { format: "json", delimiter: ",", fields: FIELDS });
    expect(records).toHaveLength(BIG);
  });

  test("reads a CSV file with more records than can be spread as arguments", () => {
    const file = path.join(tmpDir, "big.csv");
    writeFileSync(file, "year\n" + Array.from({ length: BIG }, (_, i) => String(i)).join("\n") + "\n");
    const records = readInputRecords(file, { format: "csv", delimiter: ",", fields: FIELDS });
    expect(records).toHaveLength(BIG);
  });

  test("merges a glob whose files together exceed the spread limit", () => {
    const half = BIG / 2;
    for (const name of ["a.ndjson", "b.ndjson"]) {
      writeFileSync(path.join(tmpDir, name), Array.from({ length: half }, (_, i) => `{"year":${i}}`).join("\n") + "\n");
    }
    const records = readInputRecords(path.join(tmpDir, "*.ndjson"), { format: "ndjson", delimiter: ",", fields: FIELDS });
    expect(records).toHaveLength(BIG);
  });
});

describe("countInputRecords", () => {
  test("counts every NDJSON record and its payload bytes, ignoring blank lines", () => {
    const line1 = JSON.stringify({ year: 1999, title: "The Matrix" });
    const line2 = JSON.stringify({ year: 2000, title: "Gladiator" });
    writeFileSync(path.join(tmpDir, "movies.ndjson"), `${line1}\n\n${line2}\n`);
    const stats = countInputRecords(path.join(tmpDir, "movies.ndjson"), { format: "ndjson", delimiter: ",", fields: FIELDS });
    expect(stats.recordCount).toBe(2);
    expect(stats.datasetBytes).toBe(Buffer.byteLength(line1, "utf8") + Buffer.byteLength(line2, "utf8"));
  });

  test("counts the FULL dataset even though inference reads only a sample (limit)", () => {
    const lines = Array.from({ length: 5000 }, (_, i) => JSON.stringify({ year: 2000 + i, title: `M${i}` }));
    writeFileSync(path.join(tmpDir, "big.ndjson"), lines.join("\n") + "\n");
    const opts = { format: "ndjson" as const, delimiter: ",", fields: FIELDS };
    expect(readInputRecords(path.join(tmpDir, "big.ndjson"), { ...opts, limit: 1000 })).toHaveLength(1000);
    expect(countInputRecords(path.join(tmpDir, "big.ndjson"), opts).recordCount).toBe(5000);
  });

  test("sums record counts across a glob of NDJSON files", () => {
    writeFileSync(path.join(tmpDir, "a.ndjson"), `${JSON.stringify({ year: 1 })}\n${JSON.stringify({ year: 2 })}\n`);
    writeFileSync(path.join(tmpDir, "b.ndjson"), `${JSON.stringify({ year: 3 })}\n`);
    expect(countInputRecords(path.join(tmpDir, "*.ndjson"), { format: "ndjson", delimiter: ",", fields: FIELDS }).recordCount).toBe(3);
  });
});
