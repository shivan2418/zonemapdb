import { describe, expect, test } from "vitest";
import { resolveConfig } from "../src/config.js";
import type { ZoneDbConfig } from "../src/types.js";

const base: ZoneDbConfig = {
  collection: "movies",
  input: { path: "data/movies.ndjson" },
  schema: {
    sortField: "year",
    fields: {
      year: { kind: "number" },
      title: { kind: "string" },
    },
  },
};

describe("resolveConfig", () => {
  test("fills in defaults for output, clientOut, basePath, blockBytes", () => {
    const resolved = resolveConfig(base, "/repo");
    expect(resolved.output).toBe("/repo/public/zonedb");
    expect(resolved.clientOut).toBe("/repo/src/zonedb");
    expect(resolved.basePath).toBe("/zonedb");
    expect(resolved.blockBytes).toBeGreaterThan(0);
    expect(resolved.inputPath).toBe("/repo/data/movies.ndjson");
    expect(resolved.inputFormat).toBe("ndjson");
    expect(resolved.compression).toBe("none");
  });

  test("honors the deprecated gzip: true as compression: gzip (ADR-0002 §8)", () => {
    expect(resolveConfig({ ...base, gzip: true }, "/repo").compression).toBe("gzip");
    expect(resolveConfig({ ...base, gzip: false }, "/repo").compression).toBe("none");
  });

  test("honors an explicit compression setting, brotli included", () => {
    expect(resolveConfig({ ...base, compression: "brotli" }, "/repo").compression).toBe("brotli");
    expect(resolveConfig({ ...base, compression: "none" }, "/repo").compression).toBe("none");
  });

  test("rejects a compression/gzip pair that disagrees rather than picking a winner silently", () => {
    expect(() => resolveConfig({ ...base, compression: "brotli", gzip: false }, "/repo")).toThrow(/disagree/);
    // ...but the redundant-and-consistent combination is fine
    expect(resolveConfig({ ...base, compression: "gzip", gzip: true }, "/repo").compression).toBe("gzip");
  });

  test("rejects an unknown compression value", () => {
    expect(() => resolveConfig({ ...base, compression: "lz4" as never }, "/repo")).toThrow(/compression/);
  });

  test("honors explicit output/clientOut/basePath/blockBytes overrides", () => {
    const resolved = resolveConfig(
      { ...base, output: "dist/data", clientOut: "dist/client", basePath: "https://cdn.example.com/data", blockBytes: 1024 },
      "/repo",
    );
    expect(resolved.output).toBe("/repo/dist/data");
    expect(resolved.clientOut).toBe("/repo/dist/client");
    expect(resolved.basePath).toBe("https://cdn.example.com/data");
    expect(resolved.blockBytes).toBe(1024);
  });

  test("rejects a sortField not declared in schema.fields", () => {
    const bad: ZoneDbConfig = { ...base, schema: { sortField: "missing", fields: base.schema.fields } };
    expect(() => resolveConfig(bad, "/repo")).toThrow(/sortField/);
  });

  test("accepts a string sortField — it range-partitions lexicographically (ADR-0002 §2)", () => {
    const stringSorted: ZoneDbConfig = {
      ...base,
      schema: { sortField: "title", fields: base.schema.fields },
    };
    expect(resolveConfig(stringSorted, "/repo").sortField).toBe("title");
  });

  test("accepts tsType on a json field and carries it through resolveConfig", () => {
    const withPayloadType: ZoneDbConfig = {
      ...base,
      schema: {
        ...base.schema,
        fields: {
          ...base.schema.fields,
          images: { kind: "json", tsType: "ImageUris", tsImport: 'import type { ImageUris } from "./types.js";' },
        },
      },
    };
    expect(resolveConfig(withPayloadType, "/repo").fields.images!.tsType).toBe("ImageUris");
  });

  test("rejects tsType on a scalar field — its type already follows its kind", () => {
    const bad: ZoneDbConfig = {
      ...base,
      schema: { ...base.schema, fields: { ...base.schema.fields, title: { kind: "string", tsType: "Brand<string>" } } },
    };
    expect(() => resolveConfig(bad, "/repo")).toThrow(/tsType[\s\S]*json|json[\s\S]*tsType/);
  });

  test("rejects tsImport without tsType", () => {
    const bad: ZoneDbConfig = {
      ...base,
      schema: {
        ...base.schema,
        fields: { ...base.schema.fields, images: { kind: "json", tsImport: 'import type { X } from "./x.js";' } },
      },
    };
    expect(() => resolveConfig(bad, "/repo")).toThrow(/tsImport[\s\S]*tsType/);
  });

  test("accepts values on a string sort field, which is implicitly indexed", () => {
    const sortedEnum: ZoneDbConfig = {
      ...base,
      schema: {
        sortField: "tier",
        fields: { ...base.schema.fields, tier: { kind: "string", values: ["bronze", "gold", "silver"] } },
      },
    };
    expect(resolveConfig(sortedEnum, "/repo").fields.tier!.values).toEqual(["bronze", "gold", "silver"]);
  });

  test("rejects endsWith/contains on the sort field rather than silently dropping them", () => {
    for (const op of ["endsWith", "contains"] as const) {
      const bad: ZoneDbConfig = {
        ...base,
        schema: { sortField: "title", fields: { ...base.schema.fields, title: { kind: "string", [op]: true } } },
      };
      expect(() => resolveConfig(bad, "/repo")).toThrow(new RegExp(`${op}[\\s\\S]*split-points|split-points[\\s\\S]*${op}`));
    }
  });

  test("rejects a sortField whose kind has no useful order (boolean / json)", () => {
    for (const kind of ["boolean", "json"] as const) {
      const bad: ZoneDbConfig = {
        ...base,
        schema: { sortField: "flag", fields: { ...base.schema.fields, flag: { kind } } },
      };
      expect(() => resolveConfig(bad, "/repo")).toThrow(/sortField/);
    }
  });

  test("rejects an unsupported input format", () => {
    const bad: ZoneDbConfig = { ...base, input: { path: "x.xml", format: "xml" as never } };
    expect(() => resolveConfig(bad, "/repo")).toThrow(/unsupported input format/);
  });
});

describe("resolveConfig — input formats (T9)", () => {
  test("json/csv/tsv are accepted, defaulting delimiter per format", () => {
    expect(resolveConfig({ ...base, input: { path: "x.json", format: "json" } }, "/repo").inputFormat).toBe("json");

    const csv = resolveConfig({ ...base, input: { path: "x.csv", format: "csv" } }, "/repo");
    expect(csv.inputFormat).toBe("csv");
    expect(csv.inputDelimiter).toBe(",");

    const tsv = resolveConfig({ ...base, input: { path: "x.tsv", format: "tsv" } }, "/repo");
    expect(tsv.inputFormat).toBe("tsv");
    expect(tsv.inputDelimiter).toBe("\t");
  });

  test("honors an explicit delimiter override for csv/tsv", () => {
    const resolved = resolveConfig({ ...base, input: { path: "x.csv", format: "csv", delimiter: ";" } }, "/repo");
    expect(resolved.inputDelimiter).toBe(";");
  });

  test("rejects a delimiter override on ndjson/json input", () => {
    const bad: ZoneDbConfig = { ...base, input: { path: "x.ndjson", delimiter: ";" } };
    expect(() => resolveConfig(bad, "/repo")).toThrow(/delimiter.*json|json.*delimiter/i);
  });

  test("carries a records selector path through for json input", () => {
    const resolved = resolveConfig({ ...base, input: { path: "x.json", format: "json", records: "data.records" } }, "/repo");
    expect(resolved.inputRecordsPath).toBe("data.records");
  });

  test("omits inputRecordsPath entirely when not configured", () => {
    const resolved = resolveConfig(base, "/repo");
    expect(resolved.inputRecordsPath).toBeUndefined();
  });

  test("rejects a records selector on a non-json format", () => {
    const bad: ZoneDbConfig = { ...base, input: { path: "x.ndjson", records: "data.records" } };
    expect(() => resolveConfig(bad, "/repo")).toThrow(/records.*json|json.*records/i);
  });
});

describe("resolveConfig — endsWith/contains opt-ins (T6)", () => {
  const indexedString: ZoneDbConfig = {
    ...base,
    schema: {
      sortField: "year",
      fields: { ...base.schema.fields, title: { kind: "string", indexed: true } },
    },
  };

  test("accepts endsWith/contains on an indexed string field", () => {
    const resolved = resolveConfig(
      { ...indexedString, schema: { ...indexedString.schema, fields: { ...indexedString.schema.fields, title: { kind: "string", indexed: true, endsWith: true, contains: true } } } },
      "/repo",
    );
    expect(resolved.fields.title).toEqual({ kind: "string", indexed: true, endsWith: true, contains: true });
  });

  test("rejects endsWith on a non-indexed field", () => {
    const bad: ZoneDbConfig = {
      ...base,
      schema: { sortField: "year", fields: { ...base.schema.fields, title: { kind: "string", endsWith: true } } },
    };
    expect(() => resolveConfig(bad, "/repo")).toThrow(/title.*indexed|indexed.*title/i);
  });

  test("rejects contains on a non-indexed field", () => {
    const bad: ZoneDbConfig = {
      ...base,
      schema: { sortField: "year", fields: { ...base.schema.fields, title: { kind: "string", contains: true } } },
    };
    expect(() => resolveConfig(bad, "/repo")).toThrow(/title.*indexed|indexed.*title/i);
  });

  test("rejects endsWith on a non-string indexed field", () => {
    const bad: ZoneDbConfig = {
      ...base,
      schema: {
        sortField: "year",
        fields: { ...base.schema.fields, rating: { kind: "number", indexed: true, endsWith: true } },
      },
    };
    expect(() => resolveConfig(bad, "/repo")).toThrow(/rating.*string|string.*rating/i);
  });

  test("rejects contains on a non-string indexed field", () => {
    const bad: ZoneDbConfig = {
      ...base,
      schema: {
        sortField: "year",
        fields: { ...base.schema.fields, rating: { kind: "number", indexed: true, contains: true } },
      },
    };
    expect(() => resolveConfig(bad, "/repo")).toThrow(/rating.*string|string.*rating/i);
  });

  test("rejects endsWith/contains on the sort field itself (always number/date, never string)", () => {
    const bad: ZoneDbConfig = {
      ...base,
      schema: { sortField: "year", fields: { ...base.schema.fields, year: { kind: "number", endsWith: true } } },
    };
    expect(() => resolveConfig(bad, "/repo")).toThrow(/year.*string|string.*year/i);
  });
});

describe("resolveConfig — multi/absent opt-ins (T7)", () => {
  test("accepts multi on an indexed string field", () => {
    const resolved = resolveConfig(
      { ...base, schema: { sortField: "year", fields: { ...base.schema.fields, title: { kind: "string", indexed: true, multi: true } } } },
      "/repo",
    );
    expect(resolved.fields.title).toEqual({ kind: "string", indexed: true, multi: true });
  });

  test("accepts absent on an indexed field of any kind", () => {
    const resolved = resolveConfig(
      { ...base, schema: { sortField: "year", fields: { ...base.schema.fields, title: { kind: "string", indexed: true, absent: true } } } },
      "/repo",
    );
    expect(resolved.fields.title).toEqual({ kind: "string", indexed: true, absent: true });
  });

  test("rejects multi on a non-indexed field", () => {
    const bad: ZoneDbConfig = {
      ...base,
      schema: { sortField: "year", fields: { ...base.schema.fields, title: { kind: "string", multi: true } } },
    };
    expect(() => resolveConfig(bad, "/repo")).toThrow(/title.*indexed|indexed.*title/i);
  });

  test("rejects multi on a non-string indexed field", () => {
    const bad: ZoneDbConfig = {
      ...base,
      schema: { sortField: "year", fields: { ...base.schema.fields, rating: { kind: "number", indexed: true, multi: true } } },
    };
    expect(() => resolveConfig(bad, "/repo")).toThrow(/rating.*string|string.*rating/i);
  });

  test("rejects multi on the sort field itself", () => {
    const bad: ZoneDbConfig = {
      ...base,
      schema: { sortField: "year", fields: { ...base.schema.fields, year: { kind: "number", multi: true } } },
    };
    expect(() => resolveConfig(bad, "/repo")).toThrow(/year.*sort field/i);
  });

  // absent/nullable describe the data (they shape the generated record type), so they're valid on
  // any field; which missing-value operators they unlock is decided from the field's role.
  test("accepts absent and nullable on a non-indexed field, the sort field and a multi field", () => {
    const ok: ZoneDbConfig = {
      ...base,
      schema: {
        sortField: "year",
        fields: {
          ...base.schema.fields,
          year: { kind: "number", absent: true, nullable: true },
          title: { kind: "string", absent: true, nullable: true },
          tags: { kind: "string", indexed: true, multi: true, absent: true, nullable: true },
        },
      },
    };
    expect(() => resolveConfig(ok, "/repo")).not.toThrow();
  });
});

describe("resolveConfig — pk opt-in (T8)", () => {
  test("accepts pk on the sort field itself (the free zonemap path)", () => {
    const resolved = resolveConfig({ ...base, schema: { sortField: "year", pk: "year", fields: base.schema.fields } }, "/repo");
    expect(resolved.pk).toBe("year");
  });

  test("accepts pk on a non-sort field that is indexed", () => {
    const resolved = resolveConfig(
      { ...base, schema: { sortField: "year", pk: "title", fields: { ...base.schema.fields, title: { kind: "string", indexed: true } } } },
      "/repo",
    );
    expect(resolved.pk).toBe("title");
  });

  test("omits pk entirely when not configured", () => {
    const resolved = resolveConfig(base, "/repo");
    expect(resolved.pk).toBeUndefined();
  });

  test("rejects a pk not declared in schema.fields", () => {
    const bad: ZoneDbConfig = { ...base, schema: { sortField: "year", pk: "missing", fields: base.schema.fields } };
    expect(() => resolveConfig(bad, "/repo")).toThrow(/pk.*missing|missing.*pk/i);
  });

  test("rejects pk on a non-sort field that is NOT indexed (no index to look it up by)", () => {
    const bad: ZoneDbConfig = { ...base, schema: { sortField: "year", pk: "title", fields: base.schema.fields } };
    expect(() => resolveConfig(bad, "/repo")).toThrow(/title.*indexed|indexed.*title/i);
  });

  test("rejects pk on a multi-valued field", () => {
    const bad: ZoneDbConfig = {
      ...base,
      schema: {
        sortField: "year",
        pk: "title",
        fields: { ...base.schema.fields, title: { kind: "string", indexed: true, multi: true } },
      },
    };
    expect(() => resolveConfig(bad, "/repo")).toThrow(/title.*multi|multi.*title/i);
  });

  test("rejects pk on an absentable field", () => {
    const bad: ZoneDbConfig = {
      ...base,
      schema: {
        sortField: "year",
        pk: "title",
        fields: { ...base.schema.fields, title: { kind: "string", indexed: true, absent: true } },
      },
    };
    expect(() => resolveConfig(bad, "/repo")).toThrow(/title.*present|present.*title/i);
  });

  test("rejects pk on a nullable field", () => {
    const bad: ZoneDbConfig = {
      ...base,
      schema: {
        sortField: "year",
        pk: "title",
        fields: { ...base.schema.fields, title: { kind: "string", indexed: true, nullable: true } },
      },
    };
    expect(() => resolveConfig(bad, "/repo")).toThrow(/title.*null/i);
  });
});

describe("resolveConfig — enum-like value unions", () => {
  const withField = (title: Record<string, unknown>): ZoneDbConfig => ({
    ...base,
    schema: { sortField: "year", fields: { ...base.schema.fields, title: title as never } },
  });

  test("accepts a values array on an indexed string field", () => {
    const resolved = resolveConfig(withField({ kind: "string", indexed: true, values: ["a", "b"] }), "/repo");
    expect(resolved.fields.title).toEqual({ kind: "string", indexed: true, values: ["a", "b"] });
  });

  test("rejects values on a non-string field — only strings can be an enum", () => {
    expect(() => resolveConfig(withField({ kind: "number", indexed: true, values: ["a"] }), "/repo")).toThrow(
      /"values".*kind "number"|kind "number".*"values"/,
    );
  });

  test("accepts values on an unindexed field: every field is queryable (ADR-0013), so the union narrows its filters too", () => {
    expect(() => resolveConfig(withField({ kind: "string", values: ["a"] }), "/repo")).not.toThrow();
  });

  test("rejects an empty values array rather than emitting an uninhabitable union", () => {
    expect(() => resolveConfig(withField({ kind: "string", indexed: true, values: [] }), "/repo")).toThrow(/empty/);
  });

  test("rejects duplicate values", () => {
    expect(() => resolveConfig(withField({ kind: "string", indexed: true, values: ["a", "b", "a"] }), "/repo")).toThrow(
      /duplicate/,
    );
  });
});

describe("resolveConfig — valuesType", () => {
  const enumField = (values: string[], valuesType?: string) => ({
    kind: "string" as const, indexed: true, values, ...(valuesType ? { valuesType } : {}),
  });

  test("accepts many fields sharing one name, and many distinct names side by side", () => {
    const cfg: ZoneDbConfig = {
      ...base,
      schema: {
        ...base.schema,
        fields: {
          ...base.schema.fields,
          colors: enumField(["B", "W"], "Color"),
          color_identity: enumField(["B", "W"], "Color"),
          rarity: enumField(["common", "rare"], "Rarity"),
        },
      },
    };
    const r = resolveConfig(cfg, "/repo");
    expect(r.fields.colors!.valuesType).toBe("Color");
    expect(r.fields.rarity!.valuesType).toBe("Rarity");
  });

  test("rejects fields that share a name but disagree on values — the shared type would lie for one", () => {
    // The real trap: `colors` and `produced_mana` look alike until produced_mana gains C and T.
    const cfg: ZoneDbConfig = {
      ...base,
      schema: {
        ...base.schema,
        fields: {
          ...base.schema.fields,
          colors: enumField(["B", "W"], "Color"),
          produced_mana: enumField(["B", "C", "W"], "Color"),
        },
      },
    };
    expect(() => resolveConfig(cfg, "/repo")).toThrow(/valuesType "Color"[\s\S]*differ|differ[\s\S]*Color/);
  });

  test("rejects valuesType without values, and a name that isn't a valid type name", () => {
    const withField = (f: Record<string, unknown>): ZoneDbConfig => ({
      ...base,
      schema: { ...base.schema, fields: { ...base.schema.fields, x: f as never } },
    });
    expect(() => resolveConfig(withField({ kind: "string", indexed: true, valuesType: "Color" }), "/repo")).toThrow(/no "values"/);
    expect(() =>
      resolveConfig(withField({ kind: "string", indexed: true, values: ["a"], valuesType: "not a type" }), "/repo"),
    ).toThrow(/valid TypeScript type name/);
  });
});
