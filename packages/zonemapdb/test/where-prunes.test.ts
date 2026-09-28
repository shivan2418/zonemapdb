import { describe, expect, test } from "vitest";
import { createClient } from "../src/client.js";
import { ZonemapDbError } from "../src/errors.js";
import { assertWhereHasPruning, compactWhere, wherePrunes } from "../src/types.js";
import type { SchemaMeta } from "../src/types.js";

// The rider rule as a check, for a `where` built from UI input: fall back instead of catching.

const fields = {
  year: { kind: "number", operators: ["equals", "in", "gt", "gte", "lt", "lte", "not"], pruning: ["equals", "in", "gt", "gte", "lt", "lte"] },
  name: { kind: "string", operators: ["equals", "in", "startsWith", "endsWith", "contains", "not"], pruning: ["equals", "in", "startsWith", "contains"] },
  note: { kind: "string", operators: ["equals", "in", "startsWith", "endsWith", "contains", "not"], pruning: [] },
  tags: { kind: "string", multi: true, operators: ["equals", "in", "startsWith", "contains"], pruning: ["equals", "in", "startsWith", "contains"] },
} as const;
const collection = { fields };
const withSortField = { sortField: "year", fields };

describe("wherePrunes", () => {
  test("a filter the sort field or an index answers prunes; riders alone don't", () => {
    expect(wherePrunes({ year: { gte: 2000 } }, collection)).toBe(true);
    expect(wherePrunes({ name: { equals: "Bolt" } }, collection)).toBe(true);
    expect(wherePrunes({ note: { equals: "x" } }, collection)).toBe(false);
    expect(wherePrunes({ name: { not: "Bolt" } }, collection)).toBe(false);
    expect(wherePrunes({ note: { equals: "x" }, year: { lt: 1990 } }, collection)).toBe(true);
  });

  test("contains prunes only with 3 or more characters", () => {
    expect(wherePrunes({ name: { contains: "bol" } }, collection)).toBe(true);
    expect(wherePrunes({ name: { contains: "bo" } }, collection)).toBe(false);
    expect(wherePrunes({ name: { contains: "" } }, collection)).toBe(false);
    expect(wherePrunes({ tags: { some: { contains: "ab" } } }, collection)).toBe(false);
    expect(wherePrunes({ tags: { some: { contains: "abc" } } }, collection)).toBe(true);
  });

  test("a pruning operator whose value matches every block rides", () => {
    expect(wherePrunes({ name: { startsWith: "" } }, collection)).toBe(false);
    expect(wherePrunes({ name: { startsWith: "B" } }, collection)).toBe(true);
    expect(wherePrunes({ year: { equals: undefined } }, collection)).toBe(true); // compacts to the empty where
    expect(wherePrunes({ year: { equals: undefined }, note: { equals: "x" } }, collection)).toBe(false);
    expect(wherePrunes({ tags: { hasEvery: [] } }, collection)).toBe(false);
    expect(wherePrunes({ tags: { hasEvery: ["a"] } }, collection)).toBe(true);
    expect(wherePrunes({ tags: { isEmpty: false } }, collection)).toBe(false);
    expect(wherePrunes({ tags: { isEmpty: true } }, collection)).toBe(true);
    expect(wherePrunes({ tags: { some: { startsWith: "" } } }, collection)).toBe(false);
    expect(wherePrunes({ tags: { some: { not: "a" } } }, collection)).toBe(false);
  });

  test("NEEDS_PRUNING says why an empty value rides", () => {
    expect(() => assertWhereHasPruning({ tags: { hasEvery: [] } }, withSortField)).toThrow(/an empty `hasEvery` and `isEmpty: false` match every block/);
  });

  test("an empty or missing where is allowed, so it counts as pruning", () => {
    expect(wherePrunes(undefined, collection)).toBe(true);
    expect(wherePrunes({}, collection)).toBe(true);
    expect(wherePrunes({ name: undefined }, collection)).toBe(true);
  });

  test("takes a collection's getSchema() as it is", () => {
    const schema = { cards: collection } satisfies SchemaMeta;
    const db = createClient<typeof schema, { cards: Record<string, unknown> }>(schema, { basePath: "/data", fetch: fetch });
    expect(wherePrunes({ name: { contains: "a" } }, db.cards.getSchema())).toBe(false);
  });

  test("assertWhereHasPruning agrees, and names the 3-character rule when a short contains is why", () => {
    expect(() => assertWhereHasPruning({ name: { contains: "bol" } }, withSortField)).not.toThrow();
    let error: unknown;
    try {
      assertWhereHasPruning({ name: { contains: "bo" } }, withSortField);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ZonemapDbError);
    expect((error as ZonemapDbError).code).toBe("NEEDS_PRUNING");
    expect((error as ZonemapDbError).message).toMatch(/`contains` needs at least 3 characters/);
    expect((error as ZonemapDbError).message).toMatch(/wherePrunes\(\)/);

    try {
      assertWhereHasPruning({ note: { equals: "x" } }, withSortField);
    } catch (e) {
      expect((e as ZonemapDbError).message).not.toMatch(/3 characters/);
    }
  });
});

describe("undefined in a where means no filter", () => {
  const queryFields = {
    year: { kind: "number", isDate: false, indexed: true, operators: ["equals", "in", "gt", "gte", "lt", "lte"], pruning: ["equals", "in", "gt", "gte", "lt", "lte"] },
    title: { kind: "string", isDate: false, indexed: true, operators: ["equals", "in", "startsWith"], pruning: ["equals", "in", "startsWith"] },
    note: { kind: "string", isDate: false, operators: ["equals", "in", "startsWith", "not"], pruning: [] },
  } as const;
  const manifest = {
    formatVersion: 0,
    generatorVersion: "0.1.0",
    dataset: { collection: "movies", recordCount: 2, blockCount: 1, sortField: "year" },
    schema: { collection: "movies", sortField: "year", fields: queryFields },
    blocks: [{ hash: "b0", bytes: 0, count: 2 }],
    zonemap: { year: { splitPoints: [1999, 2000] } },
    indexes: {
      title: { operators: ["equals", "in", "startsWith"], chunks: [{ from: "Gladiator", to: "The Matrix", file: "index/title/c0.json" }] },
    },
  };
  const block = '{"year":1999,"title":"The Matrix","note":"a"}\n{"year":2000,"title":"Gladiator","note":"b"}\n';
  const chunk = JSON.stringify({
    entries: [
      { prefixLen: 0, suffix: "Gladiator", postings: [0] },
      { prefixLen: 0, suffix: "The Matrix", postings: [0] },
    ],
  });
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    const body = url.endsWith("manifest.json") ? JSON.stringify(manifest) : url.endsWith(".ndjson") ? block : chunk;
    return { ok: true, status: 200, json: async () => JSON.parse(body), text: async () => body } as Response;
  }) as typeof fetch;
  const schema = { movies: { fields: queryFields } } satisfies SchemaMeta;
  const db = createClient<typeof schema, { movies: Record<string, unknown> }>(schema, { basePath: "/data", fetch: fetchImpl });
  // Untyped, as a where built at runtime would be.
  const raw = db.movies as unknown as {
    findMany(args: { where?: Record<string, unknown>; limit?: number }): Promise<{ records: unknown[] }>;
    count(where?: Record<string, unknown>): Promise<{ count: number; exact: boolean }>;
  };

  test("findMany drops undefined filters and operators on indexed and unindexed fields", async () => {
    const { records } = await raw.findMany({ where: { year: { gte: 1999 }, title: undefined, note: undefined } });
    expect(records).toHaveLength(2);
    const narrowed = await raw.findMany({ where: { year: { gte: 1999, lte: undefined }, title: { equals: undefined }, note: { equals: undefined } } });
    expect(narrowed.records).toHaveLength(2);
  });

  test("count does too, and a where that is all undefined is the empty where", async () => {
    expect(await raw.count({ title: undefined, note: { equals: undefined } })).toEqual({ count: 2, exact: true });
    expect(await raw.count({ year: { equals: 2000 }, note: undefined })).toEqual({ count: 2, exact: false });
  });

  test("compactWhere keeps what is set", () => {
    expect(compactWhere({ a: undefined, b: { equals: undefined }, c: { gte: 1, lte: undefined }, tags: { some: { equals: undefined }, isEmpty: true } })).toEqual({
      c: { gte: 1 },
      tags: { isEmpty: true },
    });
  });
});
