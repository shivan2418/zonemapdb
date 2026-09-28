import { describe, expect, test } from "vitest";
import { assertNoSchemaDrift, SchemaDriftChecker } from "../src/drift.js";
import type { FieldConfig } from "../src/types.js";

// Every key may be missing here, so each kind-drift test can use a record holding just the field it's about.
const fields: Record<string, FieldConfig> = {
  year: { kind: "number", absent: true },
  title: { kind: "string", absent: true },
  active: { kind: "boolean", absent: true },
  genres: { kind: "string", indexed: true, multi: true, absent: true },
};

const strict: Record<string, FieldConfig> = {
  year: { kind: "number" },
  title: { kind: "string" },
  genres: { kind: "string", indexed: true, multi: true },
  payload: { kind: "json" },
};

describe("assertNoSchemaDrift", () => {
  test("passes when every present value matches its declared kind", () => {
    const records = [{ year: 1999, title: "The Matrix", active: true, genres: ["Action"] }];
    expect(() => assertNoSchemaDrift(records, fields)).not.toThrow();
  });

  test("a non-finite number drifts: JSON can't store it", () => {
    expect(() => assertNoSchemaDrift([{ year: Infinity }], fields)).toThrow(/"year" is declared kind "number", but record 0 has Infinity/);
    expect(() => assertNoSchemaDrift([{ year: Number.NaN }], fields)).toThrow(/record 0 has NaN/);
  });

  test("a missing key fails unless the field is absent, since the generated type says it's always there", () => {
    expect(() => assertNoSchemaDrift([{ year: 1999, genres: [] }], strict)).toThrow(/Add "absent": true to:\n  - "title" \(has no key in 1 record, first record 0\)/);
    expect(() => assertNoSchemaDrift([{ year: 1999 }], fields)).not.toThrow();
  });

  test("a null fails unless the field is nullable, since the generated type says it's never null", () => {
    const records = [{ year: 1999, title: null, genres: [] }];
    expect(() => assertNoSchemaDrift(records, strict)).toThrow(/Add "nullable": true to:\n  - "title" \(is null in 1 record, first record 0\)/);
    expect(() => assertNoSchemaDrift(records, { ...strict, title: { kind: "string", nullable: true } })).not.toThrow();
  });

  test("a null list is a missing value too, allowed only on a nullable list field", () => {
    const records = [{ year: 1999, title: "T", genres: null }];
    expect(() => assertNoSchemaDrift(records, strict)).toThrow(/"nullable": true to:\n  - "genres"/);
    const nullableGenres = { ...strict, genres: { kind: "string" as const, indexed: true, multi: true, nullable: true } };
    expect(() => assertNoSchemaDrift(records, nullableGenres)).not.toThrow();
  });

  test("reports every drifting field in one error, grouped by fix, with counts", () => {
    const records = [
      { year: 1999, genres: [] },
      { year: null, title: null, genres: [] },
      { year: "2001", title: null },
    ];
    let message = "";
    try {
      assertNoSchemaDrift(records, strict);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain(`Add "absent": true to:\n  - "title" (has no key in 1 record, first record 0)\n  - "genres" (has no key in 1 record, first record 2)`);
    expect(message).toContain(`Add "nullable": true to:\n  - "year" (is null in 1 record, first record 1)\n  - "title" (is null in 2 records, first record 1)`);
    expect(message).toContain(`"year" is declared kind "number", but record 2 has a string value ("2001").`);
    expect(message).toContain(`it keeps your sort field, indexed fields and other choices`);
  });

  test("payload-only json fields may be missing or null: they're opaque and always typed optional", () => {
    expect(() => assertNoSchemaDrift([{ year: 1999, title: "T", genres: [] }], strict)).not.toThrow();
    expect(() => assertNoSchemaDrift([{ year: 1999, title: "T", genres: [], payload: null }], strict)).not.toThrow();
  });

  test("throws loud when a declared number field's actual value is a string", () => {
    const records = [{ year: "1999" }];
    expect(() => assertNoSchemaDrift(records, fields)).toThrow(/"year".*number/i);
  });

  test("throws loud when a declared boolean field's actual value is a string", () => {
    const records = [{ active: "true" }];
    expect(() => assertNoSchemaDrift(records, fields)).toThrow(/"active".*boolean/i);
  });

  test("throws loud when a declared multi field's value is no longer a string array", () => {
    const records = [{ genres: "Action" }];
    expect(() => assertNoSchemaDrift(records, fields)).toThrow(/"genres".*multi/i);
  });

  test("throws loud when a declared multi field's array contains a non-string element", () => {
    const records = [{ genres: ["Action", 5] }];
    expect(() => assertNoSchemaDrift(records, fields)).toThrow(/"genres".*multi/i);
  });

  test("identifies the offending record index in the error message", () => {
    const records = [{ year: 1999 }, { year: 2000 }, { year: "2001" }];
    expect(() => assertNoSchemaDrift(records, fields)).toThrow(/2/);
  });

  test("an array on a single-valued field says how to declare it, instead of just 'object'", () => {
    // The common way in: un-indexing a multi-valued field drops `multi` with it, since `multi`
    // requires `indexed`. "has a object value" alone doesn't tell you the way out.
    const records = [{ title: ["G"] }];
    expect(() => assertNoSchemaDrift(records, fields)).toThrow(/array/);
    expect(() => assertNoSchemaDrift(records, fields)).toThrow(/"multi": true.*"indexed": true/);
    expect(() => assertNoSchemaDrift(records, fields)).toThrow(/"kind": "json"/);
  });

  test("names the CLI's real binary when suggesting a fix", () => {
    expect(() => assertNoSchemaDrift([{ year: "1999" }], fields)).toThrow(/"zonemapdb init --reinfer"/);
    expect(() => assertNoSchemaDrift([{ genres: "Action" }], fields)).toThrow(/"zonemapdb init --reinfer"/);
  });

  test("lists drifting fields in config order, whatever order the records reveal them in", () => {
    // Record 0 reveals "title", record 1 reveals "year" — the report still reads year, then title.
    const records = [
      { year: 1999, genres: [] },
      { title: "T", genres: [] },
    ];
    expect(() => assertNoSchemaDrift(records, strict)).toThrow(/Add "absent": true to:\n  - "year" .*\n  - "title"/);
  });

  test("the streaming checker reports nothing until finish, then everything at once", () => {
    const checker = new SchemaDriftChecker(strict);
    expect(() => checker.check({ year: "1999", genres: [] })).not.toThrow();
    expect(() => checker.check({ year: 2000, title: null, genres: [] })).not.toThrow();
    expect(() => checker.finish()).toThrow(/"title".*\n[\s\S]*"nullable": true to:\n  - "title"[\s\S]*"year" is declared kind "number"/);
  });
});

