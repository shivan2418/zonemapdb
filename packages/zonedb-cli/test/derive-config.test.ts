import { describe, expect, test } from "vitest";
import { resolveConfig } from "../src/config.js";
import type { FieldConfig, ZoneDbConfig } from "../src/types.js";

const base = (fields: Record<string, FieldConfig>): ZoneDbConfig => ({
  collection: "cards",
  input: { path: "cards.ndjson" },
  schema: { sortField: "name", fields: { name: { kind: "string" }, power: { kind: "string" }, ...fields } },
});

const resolve = (fields: Record<string, FieldConfig>) => () => resolveConfig(base(fields), "/tmp");

describe("derive validation (ADR-0009)", () => {
  test("accepts a well-formed derived field", () => {
    expect(resolve({ power_num: { kind: "number", indexed: true, derive: { from: "power", using: "numeric" } } })).not.toThrow();
  });

  test("rejects an unknown normalizer, listing the ones that exist", () => {
    const bad = { power_num: { kind: "number", derive: { from: "power", using: "uppercase" } } } as unknown as Record<string, FieldConfig>;
    expect(resolve(bad)).toThrow(/uppercase[\s\S]*numeric/);
  });

  test("rejects a source field that is not declared", () => {
    expect(resolve({ p: { kind: "number", derive: { from: "nope", using: "numeric" } } })).toThrow(/"nope"/);
  });

  test("rejects a kind that disagrees with the normalizer's output", () => {
    // `numeric` yields numbers; declaring the field a string would mis-sort and mis-index it.
    expect(resolve({ p: { kind: "string", derive: { from: "power", using: "numeric" } } })).toThrow(
      /numeric[\s\S]*number/,
    );
  });

  test("rejects deriving from a derived field, which would make the order of one pass matter", () => {
    expect(
      resolve({
        a: { kind: "string", derive: { from: "power", using: "trim" } },
        b: { kind: "string", derive: { from: "a", using: "lowercase" } },
      }),
    ).toThrow(/"a"[\s\S]*derived/);
  });

  test("rejects a field deriving from itself", () => {
    expect(resolve({ power: { kind: "string", derive: { from: "power", using: "trim" } } })).toThrow(/itself|derived/);
  });

  test("a derived field may be the sort field — by then it is an ordinary column", () => {
    const config = base({ power_num: { kind: "number", derive: { from: "power", using: "numeric" } } });
    config.schema.sortField = "power_num";
    expect(() => resolveConfig(config, "/tmp")).not.toThrow();
  });
});

describe("--reinfer preserves derived fields", () => {
  // A derived field has no key in the input file, so inference cannot observe it. Losing it on
  // --reinfer would silently drop the field AND every index built on it.
  test("carries the derive declaration over, and drops it only when its source is gone", async () => {
    const { mkdtempSync, rmSync, writeFileSync, readFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const nodePath = (await import("node:path")).default;
    const { init } = await import("../src/init.js");

    const dir = mkdtempSync(nodePath.join(tmpdir(), "zonedb-derive-"));
    try {
      const configPath = nodePath.join(dir, "zonedb.config.json");
      writeFileSync(
        nodePath.join(dir, "cards.ndjson"),
        [{ name: "a", power: "2" }, { name: "b", power: "*" }].map((r) => JSON.stringify(r)).join("\n") + "\n",
      );

      init({ cwd: dir, configPath, yes: true, inputPath: "cards.ndjson" });
      const written = JSON.parse(readFileSync(configPath, "utf8"));
      written.schema.fields.power_num = {
        kind: "number",
        indexed: true,
        absent: true,
        derive: { from: "power", using: "numeric" },
      };
      writeFileSync(configPath, JSON.stringify(written, null, 2));

      init({ cwd: dir, configPath, yes: true, reinfer: true });
      const after = JSON.parse(readFileSync(configPath, "utf8"));
      expect(after.schema.fields.power_num).toEqual({
        kind: "number",
        indexed: true,
        absent: true,
        derive: { from: "power", using: "numeric" },
      });

      // Source column removed from the data — keeping the derived field would fail validation.
      writeFileSync(nodePath.join(dir, "cards.ndjson"), JSON.stringify({ name: "a" }) + "\n");
      init({ cwd: dir, configPath, yes: true, reinfer: true });
      const gone = JSON.parse(readFileSync(configPath, "utf8"));
      expect(gone.schema.fields.power_num).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
