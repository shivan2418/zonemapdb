import { describe, expect, test } from "vitest";
import { createClient } from "../src/client.js";
import { ZonemapDbError } from "../src/errors.js";
import type { Manifest } from "../src/manifest.js";
import type { SchemaMeta } from "../src/types.js";

// `scan: "block-order"`: a rider-only where, allowed because the walk stops at the first full page.

const fields = {
  year: { kind: "number", isDate: false, operators: ["equals", "in", "gt", "gte", "lt", "lte", "not"], pruning: ["equals", "in", "gt", "gte", "lt", "lte"] },
  note: { kind: "string", isDate: false, operators: ["equals", "in", "startsWith", "not"], pruning: [] },
} as const;

/** Six blocks of two records, years 2000..2011; `note` is "common" on every record but 2011's, which is "rare". */
const BLOCKS = 6;
const manifest: Manifest = {
  formatVersion: 0,
  generatorVersion: "0.1.0",
  dataset: { collection: "films", recordCount: BLOCKS * 2, blockCount: BLOCKS, sortField: "year" },
  schema: { collection: "films", sortField: "year", fields },
  blocks: Array.from({ length: BLOCKS }, (_, i) => ({ hash: `b${i}`, bytes: 0, count: 2 })),
  zonemap: { year: { splitPoints: [...Array.from({ length: BLOCKS }, (_, i) => 2000 + 2 * i), 2011] } },
  indexes: {},
};
const blockBody = (i: number) =>
  [2000 + 2 * i, 2001 + 2 * i].map((year) => JSON.stringify({ year, note: year === 2011 ? "rare" : "common" })).join("\n") + "\n";

function host() {
  const blockRequests: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    let body: string;
    if (url.endsWith("manifest.json")) body = JSON.stringify(manifest);
    else {
      blockRequests.push(url);
      body = blockBody(Number(/b(\d+)\.ndjson$/.exec(url)![1]));
    }
    return { ok: true, status: 200, json: async () => JSON.parse(body), text: async () => body } as Response;
  }) as typeof fetch;
  return { fetchImpl, blockRequests };
}

const schema = { films: { fields } } satisfies SchemaMeta;
interface Records {
  films: { year: number; note: string };
}
const connect = (fetchImpl: typeof fetch) => createClient<typeof schema, Records>(schema, { basePath: "/data", fetch: fetchImpl });

async function caught(promise: Promise<unknown>): Promise<ZonemapDbError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ZonemapDbError);
    return error as ZonemapDbError;
  }
  throw new Error("expected the query to reject");
}

describe('findMany({ scan: "block-order" })', () => {
  test("accepts a rider-only where and stops walking once the page is full", async () => {
    const { fetchImpl, blockRequests } = host();
    const { records, hasMore } = await connect(fetchImpl).films.findMany({ where: { note: { equals: "common" } }, scan: "block-order", limit: 1 });
    expect(records).toEqual([{ year: 2000, note: "common" }]);
    expect(hasMore).toBe(true);
    expect(blockRequests.length).toBeLessThan(BLOCKS);
  });

  test("a rare rider walks until it finds a match, which can be most of the dataset", async () => {
    const { fetchImpl, blockRequests } = host();
    const { records } = await connect(fetchImpl).films.findMany({ where: { note: { equals: "rare" } }, scan: "block-order", limit: 1 });
    expect(records).toEqual([{ year: 2011, note: "rare" }]);
    expect(blockRequests).toHaveLength(BLOCKS);
  });

  test("walks descending for orderBy on the sort field", async () => {
    const { fetchImpl } = host();
    const { records } = await connect(fetchImpl).films.findMany({
      where: { note: { equals: "common" } },
      scan: "block-order",
      orderBy: { year: "desc" },
      limit: 2,
    });
    expect(records.map((r) => r.year)).toEqual([2010, 2009]);
  });

  test("without the opt-in, the same where still throws NEEDS_PRUNING", async () => {
    const { fetchImpl } = host();
    const where = { note: { equals: "common" } } as Record<string, unknown>;
    const untyped = connect(fetchImpl).films as unknown as { findMany(args: object): Promise<unknown> };
    expect((await caught(untyped.findMany({ where, limit: 1 }))).code).toBe("NEEDS_PRUNING");
  });

  test("needs a limit and block order, and names what's missing", async () => {
    const { fetchImpl, blockRequests } = host();
    const untyped = connect(fetchImpl).films as unknown as { findMany(args: object): Promise<unknown> };
    const where = { note: { equals: "common" } };
    const noLimit = await caught(untyped.findMany({ where, scan: "block-order" }));
    expect(noLimit.code).toBe("NEEDS_PRUNING");
    expect(noLimit.message).toMatch(/no limit/);
    const otherOrder = await caught(untyped.findMany({ where, scan: "block-order", limit: 1, orderBy: { note: "asc" } }));
    expect(otherOrder.code).toBe("NEEDS_PRUNING");
    expect(otherOrder.message).toMatch(/orderBy can't be answered in block order/);
    const unknownMode = await caught(untyped.findMany({ where, scan: "everything", limit: 1 }));
    expect(unknownMode.code).toBe("CONFIG");
    expect(blockRequests).toEqual([]);
  });
});
