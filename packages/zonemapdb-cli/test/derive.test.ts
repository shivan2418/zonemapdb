import { describe, expect, test } from "vitest";
import { applyDerivedFields } from "../src/derive.js";
import type { FieldConfig } from "../src/types.js";

const fields = (extra: Record<string, FieldConfig>): Record<string, FieldConfig> => ({
  name: { kind: "string" },
  power: { kind: "string" },
  ...extra,
});

const POWER_NUM: Record<string, FieldConfig> = {
  power_num: { kind: "number", indexed: true, derive: { from: "power", using: "numeric" } },
};

describe("applyDerivedFields", () => {
  test("writes the derived value onto every record that has one", () => {
    const records = [{ power: "7" }, { power: "10" }, { power: "0" }];
    applyDerivedFields(records, fields(POWER_NUM));
    expect(records).toEqual([
      { power: "7", power_num: 7 },
      { power: "10", power_num: 10 },
      { power: "0", power_num: 0 },
    ]);
  });

  test("omits the key entirely when the source has no derivable value", () => {
    // Absent (not null) is the honest encoding: the field genuinely has no numeric value here, and
    // omitting it keeps the record out of every range query rather than pinning it to a fake 0.
    const records: Record<string, unknown>[] = [{ power: "*" }, { power: "1+*" }, { power: "3" }];
    applyDerivedFields(records, fields(POWER_NUM));
    expect(records[0]).toEqual({ power: "*" });
    expect(records[1]).toEqual({ power: "1+*" });
    expect(records[2]).toEqual({ power: "3", power_num: 3 });
    expect("power_num" in records[0]!).toBe(false);
  });

  test("a record missing the source field simply gets no derived field", () => {
    const records: Record<string, unknown>[] = [{ name: "Black Lotus" }];
    applyDerivedFields(records, fields(POWER_NUM));
    expect(records[0]).toEqual({ name: "Black Lotus" });
  });

  test("the source field is left untouched, so it stays queryable and renderable as printed", () => {
    const records = [{ power: "1+*" }, { power: "7" }];
    applyDerivedFields(records, fields(POWER_NUM));
    expect(records[0]!.power).toBe("1+*");
    expect(records[1]!.power).toBe("7");
  });

  test("a multi-valued source derives elementwise, dropping only the elements with no value", () => {
    const records: Record<string, unknown>[] = [{ tags: ["Flying", "trample", "HASTE"] }, { tags: [] }];
    applyDerivedFields(records, {
      tags: { kind: "string", multi: true },
      tags_lower: { kind: "string", indexed: true, multi: true, derive: { from: "tags", using: "lowercase" } },
    });
    expect(records[0]!.tags_lower).toEqual(["flying", "trample", "haste"]);
    // An empty result is no value at all, not an empty array — same rule as the scalar case.
    expect("tags_lower" in records[1]!).toBe(false);
  });

  test("several derived fields on one record are all applied", () => {
    const records: Record<string, unknown>[] = [{ power: "4", name: "Lim-Dûl's Vault" }];
    applyDerivedFields(records, {
      ...fields(POWER_NUM),
      name_fold: { kind: "string", indexed: true, derive: { from: "name", using: "fold" } },
    });
    expect(records[0]).toEqual({
      power: "4",
      name: "Lim-Dûl's Vault",
      power_num: 4,
      name_fold: "lim-dul's vault",
    });
  });

  test("a config with no derived fields leaves the records byte-identical", () => {
    const records = [{ power: "7" }];
    applyDerivedFields(records, fields({}));
    expect(records).toEqual([{ power: "7" }]);
  });

  test("refuses to overwrite a key the input data already carries", () => {
    // Silently clobbering a real column would make the build's output disagree with its input.
    const records = [{ power: "7", power_num: 99 }];
    expect(() => applyDerivedFields(records, fields(POWER_NUM))).toThrow(/power_num/);
  });
});
