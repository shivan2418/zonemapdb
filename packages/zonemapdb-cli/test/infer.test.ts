import { describe, expect, test } from "vitest";
import { MAX_ENUM_VALUES, SchemaInferrer, inferSchema } from "../src/infer.js";

describe("inferSchema — field kind detection", () => {
  test("infers number/string/boolean from consistent sample values", () => {
    const records = [
      { year: 1999, title: "The Matrix", active: true },
      { year: 2000, title: "Gladiator", active: false },
      { year: 2000, title: "Snatch", active: true },
    ];
    const result = inferSchema(records);
    expect(result.fields.year!.kind).toBe("number");
    expect(result.fields.title!.kind).toBe("string");
    expect(result.fields.active!.kind).toBe("boolean");
  });

  test("infers date for ISO-8601-shaped strings", () => {
    const records = [{ releasedAt: "1999-03-31" }, { releasedAt: "2000-05-05T00:00:00Z" }];
    expect(inferSchema(records).fields.releasedAt!.kind).toBe("date");
  });

  test("a field that is null in every record falls back to kind string", () => {
    const records = [{ year: 1999, notes: null }, { year: 2000, notes: null }];
    expect(inferSchema(records).fields.notes!.kind).toBe("string");
  });

  test("null values are ignored for kind detection alongside real values", () => {
    const records = [{ rating: 8.5 }, { rating: null }, { rating: 7.2 }];
    expect(inferSchema(records).fields.rating!.kind).toBe("number");
  });

  test("carries a field with inconsistent, non-coercible scalar types as payload-only json", () => {
    const records = [
      { id: 1, code: 5 },
      { id: 2, code: "five" },
    ];
    expect(inferSchema(records).fields.code!.kind).toBe("json");
  });

  test("carries a nested-object field as payload-only json", () => {
    const records = [
      { id: 1, prices: { usd: "1.50", eur: "1.20" } },
      { id: 2, prices: { usd: "2.00" } },
    ];
    const field = inferSchema(records).fields.prices!;
    expect(field.kind).toBe("json");
    expect(field.multi).toBe(false);
  });
});

describe("inferSchema — cardinality / absent / multi", () => {
  test("computes distinct-value cardinality per field", () => {
    const records = [
      { year: 1999, genre: "action" },
      { year: 2000, genre: "drama" },
      { year: 2001, genre: "action" },
    ];
    expect(inferSchema(records).fields.genre!.cardinality).toBe(2);
  });

  test("flags a field absent when its key is missing from at least one record but present in another", () => {
    const records = [{ year: 1999, tagline: "hello" }, { year: 2000 }];
    expect(inferSchema(records).fields.tagline!.absent).toBe(true);
    expect(inferSchema(records).fields.year!.absent).toBe(false);
  });

  test("a null value counts as present, not absent", () => {
    const records = [
      { year: 1999, tagline: "hello" },
      { year: 2000, tagline: null },
    ];
    expect(inferSchema(records).fields.tagline!.absent).toBe(false);
    expect(inferSchema(records).fields.tagline!.nullable).toBe(true);
  });

  test("flags a field nullable only when some record holds null, independent of absent", () => {
    const records = [{ year: 1999, tagline: "hello", score: 1 }, { year: 2000, score: null }];
    const { fields } = inferSchema(records);
    expect(fields.tagline).toMatchObject({ absent: true, nullable: false });
    expect(fields.score).toMatchObject({ absent: false, nullable: true, kind: "number" });
    expect(fields.year!.nullable).toBe(false);
  });

  test("a list field with some null lists stays a list field, flagged nullable", () => {
    const records = [{ year: 1999, tags: ["a", "b"] }, { year: 2000, tags: null }, { year: 2001, tags: [] }];
    expect(inferSchema(records).fields.tags).toMatchObject({ kind: "string", multi: true, nullable: true, absent: false });
  });

  test("detects a multi-valued field from consistent string-array values", () => {
    const records = [
      { year: 1999, genres: ["Action", "Drama"] },
      { year: 2000, genres: ["Comedy"] },
    ];
    const field = inferSchema(records).fields.genres!;
    expect(field.multi).toBe(true);
    expect(field.kind).toBe("string");
  });

  test("multi-field cardinality counts distinct elements across all arrays, not distinct array combos", () => {
    const records = [
      { year: 1999, genres: ["Action", "Drama"] },
      { year: 2000, genres: ["Action"] },
    ];
    expect(inferSchema(records).fields.genres!.cardinality).toBe(2);
  });

  test("carries a field that mixes array and scalar shapes as payload-only json", () => {
    const records = [
      { year: 1999, tags: ["a", "b"] },
      { year: 2000, tags: "c" },
    ];
    const field = inferSchema(records).fields.tags!;
    expect(field.kind).toBe("json");
    expect(field.multi).toBe(false);
  });

  test("carries a non-string array (number[] / object[]) as payload-only json, not a multi field", () => {
    const records = [
      { year: 1999, multiverseIds: [668564], parts: [{ id: "a" }] },
      { year: 2000, multiverseIds: [12, 34], parts: [{ id: "b" }] },
    ];
    const fields = inferSchema(records).fields;
    expect(fields.multiverseIds!.kind).toBe("json");
    expect(fields.multiverseIds!.multi).toBe(false);
    expect(fields.parts!.kind).toBe("json");
  });
});

describe("inferSchema — enum-like value sets", () => {
  const rarities = ["common", "uncommon", "rare", "mythic"];

  test("collects sorted distinct values for a low-cardinality string field", () => {
    const records = Array.from({ length: 40 }, (_, i) => ({ id: `c${i}`, cmc: i, rarity: rarities[i % 4]! }));
    expect(inferSchema(records).fields.rarity!.values).toEqual(["common", "mythic", "rare", "uncommon"]);
  });

  test("collects the distinct ELEMENTS of a multi-valued field, not the distinct arrays", () => {
    const records = [
      { id: "a", cmc: 1, colors: ["W", "U"] },
      { id: "b", cmc: 2, colors: ["U"] },
      { id: "c", cmc: 3, colors: ["B", "W"] },
    ];
    const field = inferSchema(records).fields.colors!;
    expect(field.multi).toBe(true);
    expect(field.values).toEqual(["B", "U", "W"]);
  });

  test("omits values once a field exceeds the enum threshold — a growing field must stay wide", () => {
    const wide = Array.from({ length: 200 }, (_, i) => ({ id: `c${i}`, cmc: i, setCode: `s${i % (MAX_ENUM_VALUES + 1)}` }));
    expect(inferSchema(wide).fields.setCode!.values).toBeUndefined();

    const atLimit = Array.from({ length: 200 }, (_, i) => ({ id: `c${i}`, cmc: i, code: `s${i % MAX_ENUM_VALUES}` }));
    expect(inferSchema(atLimit).fields.code!.values).toHaveLength(MAX_ENUM_VALUES);
  });

  test("omits values for non-string kinds — numbers, booleans and dates are never enums", () => {
    const records = [
      { id: "a", cmc: 1, live: true, released: "2020-01-01" },
      { id: "b", cmc: 2, live: false, released: "2021-01-01" },
    ];
    const fields = inferSchema(records).fields;
    expect(fields.cmc!.values).toBeUndefined();
    expect(fields.live!.values).toBeUndefined();
    expect(fields.released!.kind).toBe("date");
    expect(fields.released!.values).toBeUndefined();
  });

  test("ignores nulls when collecting values", () => {
    const records = [
      { id: "a", cmc: 1, rarity: "rare" },
      { id: "b", cmc: 2, rarity: null },
      { id: "c", cmc: 3, rarity: "common" },
    ];
    expect(inferSchema(records).fields.rarity!.values).toEqual(["common", "rare"]);
  });
});

describe("inferSchema — sort field recommendation", () => {
  test("recommends the number/date field with the highest cardinality", () => {
    const records = [
      { year: 1999, rank: 1, title: "a" },
      { year: 2000, rank: 1, title: "b" },
      { year: 2001, rank: 1, title: "c" },
    ];
    // year has cardinality 3, rank has cardinality 1 — year wins.
    expect(inferSchema(records).sortField).toBe("year");
  });

  test("prefers a date field over a lower-cardinality number field", () => {
    const records = [
      { releasedAt: "1999-01-01", views: 5 },
      { releasedAt: "2000-01-01", views: 5 },
      { releasedAt: "2001-01-01", views: 5 },
    ];
    expect(inferSchema(records).sortField).toBe("releasedAt");
  });

  test("never recommends a multi-valued or absentable field as the sort field", () => {
    const records = [
      { score: 1, genres: ["a"], year: 1999 },
      { score: 2, genres: ["b"], year: 2000 },
    ];
    expect(["score", "year"]).toContain(inferSchema(records).sortField);
  });

  test("falls back to a string field when the sample has no number/date candidate", () => {
    // Previously this threw, which made a string-only dataset unusable outright: --sort-field
    // couldn't rescue it either, because config validation rejected string sort fields too.
    const records = [{ title: "a" }, { title: "b" }];
    expect(inferSchema(records).sortField).toBe("title");
  });

  test("still prefers a number/date field over a higher-cardinality string one", () => {
    // The guard that keeps `init --yes` stable now that strings are candidates: ranking purely by
    // cardinality would hand the sort field to a unique identifier column (the worst possible
    // locality), so kind outranks cardinality.
    const records = [
      { uuid: "f47ac10b-58cc", year: 1999 },
      { uuid: "9c858901-8a57", year: 1999 },
      { uuid: "7c9e6679-7425", year: 2000 },
    ];
    expect(inferSchema(records).sortField).toBe("year");
  });

  test("throws a clear, actionable error when no sortable field exists at all", () => {
    const records = [{ ok: true, payload: { a: 1 } }, { ok: false, payload: { a: 2 } }];
    expect(() => inferSchema(records)).toThrow(/sort field|--sort-field/i);
  });

  test("tiebreaks toward a candidate that is itself unique and id-like named, not just similar cardinality", () => {
    // Both "id" and "rank" have cardinality 3 (tied); "id" additionally looks PK-shaped.
    const records = [
      { id: 1, rank: 10 },
      { id: 2, rank: 20 },
      { id: 3, rank: 30 },
    ];
    expect(inferSchema(records).sortField).toBe("id");
  });
});

describe("inferSchema — pk recommendation", () => {
  test("never recommends a field holding null as pk", () => {
    const records = [{ id: "p1", year: 1999 }, { id: null, year: 2000 }, { id: "p3", year: 2001 }];
    expect(inferSchema(records).pk).toBeUndefined();
  });

  test("recommends an id-named field that is unique across the sample", () => {
    const records = [
      { id: "p1", year: 1999 },
      { id: "p2", year: 2000 },
      { id: "p3", year: 2001 },
    ];
    expect(inferSchema(records).pk).toBe("id");
  });

  test("may recommend the sort field itself as pk when it is also unique and id-like named (ADR-0002 §4 free path)", () => {
    const records = [{ id: 1 }, { id: 2 }, { id: 3 }];
    const result = inferSchema(records);
    expect(result.sortField).toBe("id");
    expect(result.pk).toBe("id");
  });

  test("does not recommend a pk when no field both looks id-like and is unique", () => {
    const records = [
      { year: 1999, title: "a" },
      { year: 2000, title: "a" },
    ];
    expect(inferSchema(records).pk).toBeUndefined();
  });

  test("does not recommend a uniquely-valued field as pk unless it looks id-like by name", () => {
    const records = [
      { year: 1999, title: "The Matrix" },
      { year: 2000, title: "Gladiator" },
    ];
    // title is unique across the sample but isn't id-shaped by name — no guess.
    expect(inferSchema(records).pk).toBeUndefined();
  });
});

describe("inferSchema — default indexed-set recommendation", () => {
  test("recommends a small set of categorical (low-cardinality, non-constant) fields, excluding the sort field", () => {
    const records = [
      { year: 1999, category: "action", price: 10, title: "a" },
      { year: 2000, category: "action", price: 20, title: "b" },
      { year: 2001, category: "drama", price: 30, title: "c" },
      { year: 2002, category: "drama", price: 40, title: "d" },
    ];
    const result = inferSchema(records);
    expect(result.indexedFields).toContain("category");
    expect(result.indexedFields).not.toContain("year");
  });

  test("excludes a constant field (cardinality 1) from the default indexed set", () => {
    const records = [
      { year: 1999, kind: "movie" },
      { year: 2000, kind: "movie" },
    ];
    expect(inferSchema(records).indexedFields).not.toContain("kind");
  });

  test("excludes a fully-unique-looking field from the default indexed set", () => {
    const records = [
      { year: 1999, uuid: "a1" },
      { year: 2000, uuid: "b2" },
      { year: 2001, uuid: "c3" },
    ];
    expect(inferSchema(records).indexedFields).not.toContain("uuid");
  });

  test("caps the default indexed set at a small number of categorical fields", () => {
    const records = Array.from({ length: 20 }, (_, i) => ({
      year: 1990 + i,
      a: `a${i % 2}`,
      b: `b${i % 2}`,
      c: `c${i % 2}`,
      d: `d${i % 2}`,
      e: `e${i % 2}`,
    }));
    expect(inferSchema(records).indexedFields.length).toBeLessThanOrEqual(3);
  });

  test("always includes a detected multi-valued field in the indexed set (required to declare it correctly)", () => {
    const records = Array.from({ length: 10 }, (_, i) => ({ year: 1990 + i, genres: [`g${i}`, `h${i}`] }));
    expect(inferSchema(records).indexedFields).toContain("genres");
  });
});

describe("inferSchema — progress reporting", () => {
  const records = Array.from({ length: 50 }, (_, i) => ({
    id: `r${i}`,
    year: 2000 + i,
    title: `t${i}`,
    tier: i % 2 === 0 ? "gold" : "silver",
  }));

  test("reports advancing progress by records inferred, reaching the total", () => {
    // Inference is one pass over the records, so progress counts records, not fields.
    const many = Array.from({ length: 25_000 }, (_, i) => ({ id: i, tier: i % 2 === 0 ? "gold" : "silver" }));
    const events: { phase: string; done?: number; total?: number }[] = [];
    inferSchema(many, { onProgress: (e) => events.push({ phase: e.phase, done: e.done, total: e.total }) });

    expect(events.length).toBeGreaterThan(1);
    for (const e of events) {
      expect(e.phase).toMatch(/inferring/i);
      expect(e.total).toBe(many.length);
    }
    const done = events.map((e) => e.done ?? -1);
    expect(done).toEqual([...done].sort((a, b) => a - b));
    expect(done[done.length - 1]).toBe(many.length);
  });

  test("works, and infers identically, with no reporter supplied", () => {
    expect(inferSchema(records)).toEqual(
      inferSchema(records, { onProgress: () => {} }),
    );
  });
});

describe("inferSchema — default indexed set is facet-shaped, not merely small", () => {
  test("prefers the most selective grouping fields, not two-value booleans", () => {
    // Ascending cardinality picked the least useful filters available: on 116k real records the three
    // winners were all two-value booleans while `set`, `artist` and `type_line` went unindexed. That
    // also contradicted ADR-0003 §6 step 4, which treats higher cardinality as the pruning proxy.
    const records = Array.from({ length: 600 }, (_, i) => ({
      id: `r${i}`,
      rank: i,
      flag: i % 2 === 0,          // 2 distinct — cheap, and useless as a filter
      tier: `t${i % 4}`,          // 4 distinct
      family: `f${i % 60}`,       // 60 distinct — the best real facet
      label: `l${i % 20}`,        // 20 distinct
      serial: `s${i}`,            // unique — an identifier, never a facet
    }));
    const indexed = inferSchema(records).indexedFields;

    expect(indexed).toContain("family");
    expect(indexed).toContain("label");
    expect(indexed).not.toContain("flag");
    // and never an identifier-shaped column, however it is ranked
    expect(indexed).not.toContain("serial");
  });

  test("falls back to plain not-unique on a sample too small for the facet band to mean anything", () => {
    // recordCount / 10 rounds to zero on a handful of records, which would reject every field.
    const records = [
      { id: "p1", category: "electronics", price: 100 },
      { id: "p2", category: "electronics", price: 200 },
      { id: "p3", category: "books", price: 15 },
    ];
    expect(inferSchema(records).indexedFields).toContain("category");
  });
});

describe("inferSchema — value shape detection", () => {
  const many = (make: (i: number) => unknown) => Array.from({ length: 30 }, (_, i) => ({ rank: i, v: make(i) }));

  test("recognises URLs, whatever the scheme", () => {
    expect(inferSchema(many((i) => `https://api.example.com/cards/${i}?utm_source=api`)).fields.v!.shape).toBe("url");
    expect(inferSchema(many((i) => `s3://bucket/object-${i}`)).fields.v!.shape).toBe("url");
  });

  test("recognises hex UUIDs", () => {
    const uuid = (i: number) => `f47ac10b-58cc-4372-a567-0e02b2c3d${String(i).padStart(3, "0")}`;
    expect(inferSchema(many(uuid)).fields.v!.shape).toBe("uuid");
  });

  test("everything else is plain text, including near-misses", () => {
    expect(inferSchema(many((i) => `Lightning Bolt ${i}`)).fields.v!.shape).toBe("text");
    expect(inferSchema(many((i) => `set-code-${i}`)).fields.v!.shape).toBe("text");
    // not a URL: no scheme separator
    expect(inferSchema(many((i) => `api.example.com/${i}`)).fields.v!.shape).toBe("text");
    // not a UUID: wrong group lengths
    expect(inferSchema(many((i) => `abc-def-${i}`)).fields.v!.shape).toBe("text");
  });

  test("a stray outlier doesn't hide the shape, but a real mix isn't claimed", () => {
    const urls = Array.from({ length: 30 }, (_, i) => ({ rank: i, v: i === 0 ? "n/a" : `https://x.test/${i}` }));
    expect(inferSchema(urls).fields.v!.shape).toBe("url");

    const half = Array.from({ length: 30 }, (_, i) => ({ rank: i, v: i % 2 ? `https://x.test/${i}` : `plain ${i}` }));
    expect(inferSchema(half).fields.v!.shape).toBe("text");
  });

  test("a multi-valued field's shape comes from its elements", () => {
    const rows = Array.from({ length: 30 }, (_, i) => ({ rank: i, links: [`https://x.test/a${i}`, `https://x.test/b${i}`] }));
    expect(inferSchema(rows).fields.links!.shape).toBe("url");
  });
});

describe("SchemaInferrer — bounded memory past the exact-count cap (#29)", () => {
  const CAP = 1000;
  const N = 20_000;
  const inferCapped = (records: Record<string, unknown>[]) => {
    const inferrer = new SchemaInferrer({ exactDistinctMax: CAP });
    for (const record of records) inferrer.add(record);
    return inferrer.finish();
  };

  test("below the cap, streaming and in-memory inference agree exactly", () => {
    const records = Array.from({ length: 500 }, (_, i) => ({ id: `r${i}`, year: 2000 + (i % 20), tier: i % 3 === 0 ? "gold" : "silver" }));
    expect(inferCapped(records)).toEqual(inferSchema(records));
  });

  test("past the cap, cardinality is estimated within a few percent", () => {
    const records = Array.from({ length: N }, (_, i) => ({ id: i, code: `c${i % 12_000}` }));
    const { fields } = inferCapped(records);
    expect(fields.id!.cardinality / N).toBeGreaterThan(0.97);
    expect(fields.id!.cardinality).toBeLessThanOrEqual(N);
    expect(fields.code!.cardinality / 12_000).toBeGreaterThan(0.97);
    expect(fields.code!.cardinality / 12_000).toBeLessThan(1.03);
  });

  test("a unique id-like field past the cap is still recommended as the pk", () => {
    const records = Array.from({ length: N }, (_, i) => ({ id: `id-${i}`, year: 2000 + (i % 30) }));
    const result = inferCapped(records);
    expect(result.fields.id!.unique).toBe(true);
    expect(result.pk).toBe("id");
  });

  test("a late repeat of an early value disqualifies the pk, even past the cap", () => {
    const records = Array.from({ length: N }, (_, i) => ({ id: `id-${i}`, year: 2000 + (i % 30) }));
    records.push({ id: "id-7", year: 2001 }); // a duplicate of a value seen while counting exactly
    const result = inferCapped(records);
    expect(result.fields.id!.unique).toBe(false);
    expect(result.pk).toBeUndefined();
  });

  test("a field with many duplicates past the cap is not unique", () => {
    // Every value appears twice, the second time long after the exact set froze.
    const records = Array.from({ length: N }, (_, i) => ({ id: `id-${i % (N / 2)}`, year: 2000 }));
    expect(inferCapped(records).fields.id!.unique).toBe(false);
  });

  test("enum value sets and kinds don't depend on the cap", () => {
    const records = Array.from({ length: N }, (_, i) => ({ id: i, rarity: ["common", "rare", "mythic"][i % 3], at: "2020-01-01" }));
    const { fields } = inferCapped(records);
    expect(fields.rarity!.values).toEqual(["common", "mythic", "rare"]);
    expect(fields.at!.kind).toBe("date");
  });
});
