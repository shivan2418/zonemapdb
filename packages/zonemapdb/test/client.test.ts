import { describe, expect, test } from "vitest";
import { createClient } from "../src/client.js";
import { ZonemapDbError } from "../src/errors.js";
import type { Manifest } from "../src/manifest.js";
import type { SchemaMeta } from "../src/types.js";

// 3 blocks, sorted by `year`: block0 [1999], block1 [2000,2000,2000], block2 [2003,2008].
const blockContents: Record<string, string> = {
  s0: '{"year":1999,"title":"The Matrix"}\n',
  s1:
    '{"year":2000,"title":"Gladiator"}\n' +
    '{"year":2000,"title":"Snatch"}\n' +
    '{"year":2000,"title":"Memento"}\n',
  s2: '{"year":2003,"title":"Reloaded"}\n{"year":2008,"title":"Dark Knight"}\n',
};

// Titles sorted: "Dark Knight"(s2), "Gladiator"(s1), "Memento"(s1), "Reloaded"(s2), "Snatch"(s1), "The Matrix"(s0).
const indexChunks: Record<string, string> = {
  c1: JSON.stringify({
    entries: [
      { prefixLen: 0, suffix: "Dark Knight", postings: [2] },
      { prefixLen: 0, suffix: "Gladiator", postings: [1] },
      { prefixLen: 0, suffix: "Memento", postings: [1] },
    ],
  }),
  c2: JSON.stringify({
    entries: [
      { prefixLen: 0, suffix: "Reloaded", postings: [2] },
      { prefixLen: 0, suffix: "Snatch", postings: [1] },
      { prefixLen: 0, suffix: "The Matrix", postings: [0] },
    ],
  }),
};

const manifest: Manifest = {
  formatVersion: 0,
  generatorVersion: "0.1.0",
  dataset: { collection: "movies", recordCount: 6, blockCount: 3, sortField: "year" },
  schema: {
    collection: "movies",
    sortField: "year",
    fields: {
      year: { kind: "number", isDate: false, indexed: true, operators: ["equals", "in", "gt", "gte", "lt", "lte"], pruning: ["equals", "in", "gt", "gte", "lt", "lte"] },
      title: { kind: "string", isDate: false, indexed: true, operators: ["equals", "in", "startsWith"], pruning: ["equals", "in", "startsWith"] },
    },
  },
  blocks: [
    { hash: "s0", bytes: blockContents.s0!.length, count: 1 },
    { hash: "s1", bytes: blockContents.s1!.length, count: 3 },
    { hash: "s2", bytes: blockContents.s2!.length, count: 2 },
  ],
  zonemap: { year: { splitPoints: [1999, 2000, 2003, 2008] } },
  indexes: {
    title: {
      operators: ["equals", "in", "startsWith"],
      chunks: [
        { from: "Dark Knight", to: "Memento", file: "index/title/c1.json" },
        { from: "Reloaded", to: "The Matrix", file: "index/title/c2.json" },
      ],
    },
  },
};

const schema: SchemaMeta = { movies: { fields: manifest.schema.fields } };

function fakeFetch(requests: string[]): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    requests.push(url);
    if (url.endsWith("manifest.json")) {
      return { ok: true, status: 200, json: async () => manifest, text: async () => JSON.stringify(manifest) } as Response;
    }
    const indexMatch = url.match(/index\/title\/(\w+)\.json$/);
    if (indexMatch) {
      const body = indexChunks[indexMatch[1]!];
      if (!body) return { ok: false, status: 404, json: async () => ({}), text: async () => "" } as Response;
      return { ok: true, status: 200, json: async () => JSON.parse(body), text: async () => body } as Response;
    }
    const hash = url.split("/").pop()!.replace(".ndjson", "");
    const body = blockContents[hash];
    if (!body) return { ok: false, status: 404, json: async () => ({}), text: async () => "" } as Response;
    return { ok: true, status: 200, json: async () => JSON.parse(body), text: async () => body } as Response;
  }) as typeof fetch;
}

interface Movie {
  year: number;
  title: string;
}
interface Records {
  movies: Movie;
}

describe("createClient / findMany", () => {
  test("equals prunes to the single containing block", async () => {
    const requests: string[] = [];
    const client = createClient<typeof schema, Records>(schema, { basePath: "/data", fetch: fakeFetch(requests) });
    const { records, hasMore } = await client.movies.findMany({ where: { year: { equals: 2000 } } });
    expect(records.map((r) => r.title).sort()).toEqual(["Gladiator", "Memento", "Snatch"].sort());
    expect(hasMore).toBe(false);
    expect(requests.filter((u) => u.includes("/blocks/"))).toEqual(["/data/blocks/s1.ndjson"]);
  });

  test("range prunes to only the surviving blocks", async () => {
    const requests: string[] = [];
    const client = createClient<typeof schema, Records>(schema, { basePath: "/data", fetch: fakeFetch(requests) });
    const { records } = await client.movies.findMany({ where: { year: { gte: 2003 } } });
    expect(records.map((r) => r.year)).toEqual([2003, 2008]);
    expect(requests.filter((u) => u.includes("/blocks/")).sort()).toEqual(["/data/blocks/s2.ndjson"]);
  });

  test("in unions each value's block", async () => {
    const requests: string[] = [];
    const client = createClient<typeof schema, Records>(schema, { basePath: "/data", fetch: fakeFetch(requests) });
    const { records } = await client.movies.findMany({ where: { year: { in: [1999, 2008] } } });
    expect(records.map((r) => r.year).sort()).toEqual([1999, 2008]);
    expect(requests.filter((u) => u.includes("/blocks/")).sort()).toEqual([
      "/data/blocks/s0.ndjson",
      "/data/blocks/s2.ndjson",
    ]);
  });

  test("results come back sorted ascending by the sort field by construction", async () => {
    const client = createClient<typeof schema, Records>(schema, { basePath: "/data", fetch: fakeFetch([]) });
    const { records } = await client.movies.findMany();
    expect(records.map((r) => r.year)).toEqual([1999, 2000, 2000, 2000, 2003, 2008]);
  });

  test("orderBy desc reverses the result", async () => {
    const client = createClient<typeof schema, Records>(schema, { basePath: "/data", fetch: fakeFetch([]) });
    const { records } = await client.movies.findMany({ orderBy: { year: "desc" } });
    expect(records.map((r) => r.year)).toEqual([2008, 2003, 2000, 2000, 2000, 1999]);
  });

  test("orderBy on a secondary indexed field sorts by that field, not the sort field", async () => {
    const client = createClient<typeof schema, Records>(schema, { basePath: "/data", fetch: fakeFetch([]) });
    const asc = await client.movies.findMany({ orderBy: { title: "asc" } });
    expect(asc.records.map((r) => r.title)).toEqual([
      "Dark Knight",
      "Gladiator",
      "Memento",
      "Reloaded",
      "Snatch",
      "The Matrix",
    ]);
    const desc = await client.movies.findMany({ orderBy: { title: "desc" } });
    expect(desc.records.map((r) => r.title)).toEqual([
      "The Matrix",
      "Snatch",
      "Reloaded",
      "Memento",
      "Gladiator",
      "Dark Knight",
    ]);
  });

  test("multi-key orderBy sorts by the first key, breaking ties with the second", async () => {
    const client = createClient<typeof schema, Records>(schema, { basePath: "/data", fetch: fakeFetch([]) });
    // Primary: year asc (1999, 2000×3, 2003, 2008). Tiebreak: title desc among the three tied 2000s.
    const { records } = await client.movies.findMany({ orderBy: { year: "asc", title: "desc" } });
    expect(records.map((r) => [r.year, r.title])).toEqual([
      [1999, "The Matrix"],
      [2000, "Snatch"],
      [2000, "Memento"],
      [2000, "Gladiator"],
      [2003, "Reloaded"],
      [2008, "Dark Knight"],
    ]);
  });

  test("limit + offset paginate, and hasMore is exact at the limit+1 boundary", async () => {
    const client = createClient<typeof schema, Records>(schema, { basePath: "/data", fetch: fakeFetch([]) });

    const page1 = await client.movies.findMany({ limit: 2 });
    expect(page1.records.map((r) => r.year)).toEqual([1999, 2000]);
    expect(page1.hasMore).toBe(true);

    const page2 = await client.movies.findMany({ limit: 2, offset: 2 });
    expect(page2.records.map((r) => r.year)).toEqual([2000, 2000]);
    expect(page2.hasMore).toBe(true);

    const page3 = await client.movies.findMany({ limit: 2, offset: 4 });
    expect(page3.records.map((r) => r.year)).toEqual([2003, 2008]);
    expect(page3.hasMore).toBe(false);
  });

  test("an exact-fit limit reports hasMore: false", async () => {
    const client = createClient<typeof schema, Records>(schema, { basePath: "/data", fetch: fakeFetch([]) });
    const { records, hasMore } = await client.movies.findMany({ limit: 6 });
    expect(records).toHaveLength(6);
    expect(hasMore).toBe(false);
  });

  test("getSchema returns the collection meta with no network call", () => {
    const requests: string[] = [];
    const client = createClient<typeof schema, Records>(schema, { basePath: "/data", fetch: fakeFetch(requests) });
    expect(client.movies.getSchema()).toEqual(schema.movies);
    expect(requests).toEqual([]);
  });
});

describe("createClient / count — approximate upper bound (T4, ADR-0008)", () => {
  test("no where → { count: recordCount, exact: true } fetching only the manifest", async () => {
    const requests: string[] = [];
    const client = createClient<typeof schema, Records>(schema, { basePath: "/data", fetch: fakeFetch(requests) });
    const result = await client.movies.count();
    expect(result).toEqual({ count: 6, exact: true });
    expect(requests).toEqual(["/data/manifest.json"]);
  });

  test("sort-field constraint sums surviving blocks' counts — an upper bound, exact: false, no block fetches", async () => {
    const requests: string[] = [];
    const client = createClient<typeof schema, Records>(schema, { basePath: "/data", fetch: fakeFetch(requests) });

    // year == 2000 → only block1 survives the zonemap → bound = block1.count (3 records, all matching here).
    await expect(client.movies.count({ year: { equals: 2000 } })).resolves.toEqual({ count: 3, exact: false });
    // year >= 2000 → blocks [1,2] survive → bound = 3 + 2 = 5 ≥ the 5 true matches.
    await expect(client.movies.count({ year: { gte: 2000 } })).resolves.toEqual({ count: 5, exact: false });

    expect(requests.filter((u) => u.includes("/blocks/"))).toEqual([]);
    expect(requests.filter((u) => u.includes("/index/"))).toEqual([]);
  });

  test("secondary-field constraint fetches only the covering chunks — the bound can strictly exceed the truth", async () => {
    const requests: string[] = [];
    const client = createClient<typeof schema, Records>(schema, { basePath: "/data", fetch: fakeFetch(requests) });

    // year >= 2000 → blocks [1,2]; title == "Gladiator" → block [1]. Intersection [1] → bound = 3,
    // strictly above the 1 true match: "block 1 holds the value" ≠ "all of block 1's rows match".
    await expect(client.movies.count({ year: { gte: 2000 }, title: { equals: "Gladiator" } })).resolves.toEqual({
      count: 3,
      exact: false,
    });
    expect(requests.filter((u) => u.includes("/index/"))).toEqual(["/data/index/title/c1.json"]);
    expect(requests.filter((u) => u.includes("/blocks/"))).toEqual([]);
  });

  test("secondary in unions postings across chunks into the bound", async () => {
    const client = createClient<typeof schema, Records>(schema, { basePath: "/data", fetch: fakeFetch([]) });
    // "Dark Knight" → block2, "The Matrix" → block0 → bound = 2 + 1 = 3 ≥ the 2 true matches.
    await expect(client.movies.count({ title: { in: ["Dark Knight", "The Matrix"] } })).resolves.toEqual({
      count: 3,
      exact: false,
    });
  });

  test("pruned-to-zero → { count: 0, exact: true } — a trustworthy existence check, still no block fetches", async () => {
    const requests: string[] = [];
    const client = createClient<typeof schema, Records>(schema, { basePath: "/data", fetch: fakeFetch(requests) });

    // Disjoint AND: year == 1999 → block0, title == "Gladiator" → block1. Empty intersection ⇒ exactly none.
    await expect(client.movies.count({ year: { equals: 1999 }, title: { equals: "Gladiator" } })).resolves.toEqual({
      count: 0,
      exact: true,
    });
    // Zonemap alone can also prune to zero: 3000 is outside the global [1999, 2008] range.
    await expect(client.movies.count({ year: { equals: 3000 } })).resolves.toEqual({ count: 0, exact: true });

    expect(requests.filter((u) => u.includes("/blocks/"))).toEqual([]);
  });

  test("a `not`-only where is accepted (no rider rule for count) and just widens the bound to recordCount", async () => {
    const requests: string[] = [];
    const client = createClient<typeof schema, Records>(schema, { basePath: "/data", fetch: fakeFetch(requests) });

    // ADR-0008 §3: `not` cannot refine an un-fetched count — never wrong, just loose.
    // Unlike findMany, count must NOT throw the rider error: it never full-scans.
    await expect(client.movies.count({ title: { not: "Gladiator" } })).resolves.toEqual({ count: 6, exact: false });
    expect(requests.filter((u) => u.includes("/blocks/") || u.includes("/index/"))).toEqual([]);
  });

  test("contains/endsWith only widen the bound (exact: false) — no chunk routing exists for them in 1.0", async () => {
    const requests: string[] = [];
    const client = createClient<typeof schema, Records>(schema, { basePath: "/data", fetch: fakeFetch(requests) });

    // ADR-0008 §3 names all three non-refining operators; T6 builds their indexes later.
    await expect(client.movies.count({ title: { contains: "atrix" } })).resolves.toEqual({ count: 6, exact: false });
    await expect(client.movies.count({ title: { endsWith: "x" } })).resolves.toEqual({ count: 6, exact: false });
    expect(requests.filter((u) => u.includes("/blocks/") || u.includes("/index/"))).toEqual([]);
  });
});

describe("createClient / findMany — secondary inverted index (T3)", () => {
  test("equals on a secondary field fetches only the covering chunk and the matching block", async () => {
    const requests: string[] = [];
    const client = createClient<typeof schema, Records>(schema, { basePath: "/data", fetch: fakeFetch(requests) });
    const { records } = await client.movies.findMany({ where: { title: { equals: "Gladiator" } } });

    expect(records.map((r) => r.title)).toEqual(["Gladiator"]);
    expect(requests.filter((u) => u.includes("/index/"))).toEqual(["/data/index/title/c1.json"]);
    expect(requests.filter((u) => u.includes("/blocks/"))).toEqual(["/data/blocks/s1.ndjson"]);
  });

  test("in on a secondary field unions blocks across chunks, fetching only what's needed", async () => {
    const requests: string[] = [];
    const client = createClient<typeof schema, Records>(schema, { basePath: "/data", fetch: fakeFetch(requests) });
    const { records } = await client.movies.findMany({ where: { title: { in: ["Dark Knight", "The Matrix"] } } });

    expect(records.map((r) => r.title).sort()).toEqual(["Dark Knight", "The Matrix"]);
    expect(requests.filter((u) => u.includes("/index/")).sort()).toEqual([
      "/data/index/title/c1.json",
      "/data/index/title/c2.json",
    ]);
    expect(requests.filter((u) => u.includes("/blocks/")).sort()).toEqual(["/data/blocks/s0.ndjson", "/data/blocks/s2.ndjson"]);
  });

  test("startsWith on a secondary field selects only overlapping chunks and post-filters exactly", async () => {
    const requests: string[] = [];
    const client = createClient<typeof schema, Records>(schema, { basePath: "/data", fetch: fakeFetch(requests) });
    const { records } = await client.movies.findMany({ where: { title: { startsWith: "S" } } });

    expect(records.map((r) => r.title)).toEqual(["Snatch"]);
    // "S" only overlaps chunk2 (Reloaded..The Matrix) — chunk1 (Dark Knight..Memento) is entirely below "S".
    expect(requests.filter((u) => u.includes("/index/"))).toEqual(["/data/index/title/c2.json"]);
    expect(requests.filter((u) => u.includes("/blocks/"))).toEqual(["/data/blocks/s1.ndjson"]);
  });

  test("multi-field implicit AND intersects the sort-field zonemap prune with the secondary index prune", async () => {
    const requests: string[] = [];
    const client = createClient<typeof schema, Records>(schema, { basePath: "/data", fetch: fakeFetch(requests) });
    // year >= 2000 zonemap-prunes to blocks [1,2]; title equals "Gladiator" index-prunes to block [1] — intersect to [1].
    const { records } = await client.movies.findMany({ where: { year: { gte: 2000 }, title: { equals: "Gladiator" } } });

    expect(records.map((r) => r.title)).toEqual(["Gladiator"]);
    expect(requests.filter((u) => u.includes("/blocks/"))).toEqual(["/data/blocks/s1.ndjson"]);
  });

  test("an AND across fields whose index prunes disjointly returns no results and fetches no blocks", async () => {
    const requests: string[] = [];
    const client = createClient<typeof schema, Records>(schema, { basePath: "/data", fetch: fakeFetch(requests) });
    // year == 1999 → block 0 only; title == "Gladiator" → block 1 only. Disjoint ⇒ empty, no block fetch needed.
    const { records } = await client.movies.findMany({ where: { year: { equals: 1999 }, title: { equals: "Gladiator" } } });

    expect(records).toEqual([]);
    expect(requests.filter((u) => u.includes("/blocks/"))).toEqual([]);
  });
});

describe("createClient / findMany — reversed & trigram indexes (T6, endsWith/contains)", () => {
  // Reversed dictionary of the fixture's titles, sorted lexicographically on the reversed string:
  // "Reloaded"->dedaoleR(s2), "Snatch"->hctanS(s1), "Memento"->otnemeM(s1), "Gladiator"->rotaidalG(s1),
  // "Dark Knight"->thginK kraD(s2), "The Matrix"->xirtaM ehT(s0).
  const reversedChunk = JSON.stringify({
    entries: [
      { prefixLen: 0, suffix: "dedaoleR", postings: [2] },
      { prefixLen: 0, suffix: "hctanS", postings: [1] },
      { prefixLen: 0, suffix: "otnemeM", postings: [1] },
      { prefixLen: 0, suffix: "rotaidalG", postings: [1] },
      { prefixLen: 0, suffix: "thginK kraD", postings: [2] },
      { prefixLen: 0, suffix: "xirtaM ehT", postings: [0] },
    ],
  });
  // Trigram dictionary covering "Gla" (fabricated as present in blocks 1 AND 2, to prove AND-intersection
  // narrows rather than unions) and "lad" (block 1 only) — contains("Glad") must intersect down to block 1.
  const trigramChunk = JSON.stringify({
    entries: [
      { prefixLen: 0, suffix: "Gla", postings: [1, 1] },
      { prefixLen: 0, suffix: "lad", postings: [1] },
    ],
  });

  const t6Manifest: Manifest = {
    ...manifest,
    // The endsWith/contains opt-ins make those operators prune (ADR-0013).
    schema: {
      ...manifest.schema,
      fields: {
        ...manifest.schema.fields,
        title: {
          ...manifest.schema.fields.title!,
          operators: ["equals", "in", "startsWith", "endsWith", "contains", "not"],
          pruning: ["equals", "in", "startsWith", "endsWith", "contains"],
        },
      },
    },
    indexes: {
      title: {
        ...manifest.indexes.title!,
        reversed: { chunks: [{ from: "dedaoleR", to: "xirtaM ehT", file: "index/title/reversed/r1.json" }] },
        trigram: { chunks: [{ from: "Gla", to: "lad", file: "index/title/trigram/tg1.json" }] },
      },
    },
  };
  const t6Schema: SchemaMeta = { movies: { fields: t6Manifest.schema.fields } };

  function t6Fetch(requests: string[]): typeof fetch {
    return (async (input: RequestInfo | URL) => {
      const url = String(input);
      requests.push(url);
      if (url.endsWith("manifest.json")) {
        return { ok: true, status: 200, json: async () => t6Manifest, text: async () => JSON.stringify(t6Manifest) } as Response;
      }
      if (url.endsWith("index/title/reversed/r1.json")) {
        return { ok: true, status: 200, json: async () => JSON.parse(reversedChunk), text: async () => reversedChunk } as Response;
      }
      if (url.endsWith("index/title/trigram/tg1.json")) {
        return { ok: true, status: 200, json: async () => JSON.parse(trigramChunk), text: async () => trigramChunk } as Response;
      }
      const indexMatch = url.match(/index\/title\/(\w+)\.json$/);
      if (indexMatch) {
        const body = indexChunks[indexMatch[1]!];
        if (!body) return { ok: false, status: 404, json: async () => ({}), text: async () => "" } as Response;
        return { ok: true, status: 200, json: async () => JSON.parse(body), text: async () => body } as Response;
      }
      const hash = url.split("/").pop()!.replace(".ndjson", "");
      const body = blockContents[hash];
      if (!body) return { ok: false, status: 404, json: async () => ({}), text: async () => "" } as Response;
      return { ok: true, status: 200, json: async () => JSON.parse(body), text: async () => body } as Response;
    }) as typeof fetch;
  }

  test("endsWith prunes via the reversed index to the one block whose value truly ends with the suffix", async () => {
    const requests: string[] = [];
    const client = createClient<typeof t6Schema, Records>(t6Schema, { basePath: "/data", fetch: t6Fetch(requests) });
    const { records } = await client.movies.findMany({ where: { title: { endsWith: "x" } } });

    expect(records.map((r) => r.title)).toEqual(["The Matrix"]);
    expect(requests.filter((u) => u.includes("/index/"))).toEqual(["/data/index/title/reversed/r1.json"]);
    expect(requests.filter((u) => u.includes("/blocks/"))).toEqual(["/data/blocks/s0.ndjson"]);
  });

  test("contains prunes via trigram AND-intersection, fetching the shared chunk file only once", async () => {
    const requests: string[] = [];
    const client = createClient<typeof t6Schema, Records>(t6Schema, { basePath: "/data", fetch: t6Fetch(requests) });
    const { records } = await client.movies.findMany({ where: { title: { contains: "Glad" } } });

    expect(records.map((r) => r.title)).toEqual(["Gladiator"]);
    // Both "Gla" and "lad" route to the same chunk file — the shared chunk cache must dedupe the fetch.
    expect(requests.filter((u) => u.includes("/index/"))).toEqual(["/data/index/title/trigram/tg1.json"]);
    expect(requests.filter((u) => u.includes("/blocks/"))).toEqual(["/data/blocks/s1.ndjson"]);
  });

  test("contains as the SOLE constraint is valid (not a rider) and still prunes", async () => {
    const client = createClient<typeof t6Schema, Records>(t6Schema, { basePath: "/data", fetch: t6Fetch([]) });
    await expect(client.movies.findMany({ where: { title: { contains: "Glad" } } })).resolves.not.toThrow();
  });

  test("endsWith AND a sort-field range intersect both prunes", async () => {
    const requests: string[] = [];
    const client = createClient<typeof t6Schema, Records>(t6Schema, { basePath: "/data", fetch: t6Fetch(requests) });
    // year >= 2000 zonemap-prunes to blocks [1,2]; endsWith("x") index-prunes to block [0] — disjoint.
    const { records } = await client.movies.findMany({ where: { year: { gte: 2000 }, title: { endsWith: "x" } } });
    expect(records).toEqual([]);
    expect(requests.filter((u) => u.includes("/blocks/"))).toEqual([]);
  });
});

describe("createClient / failure contract — hard-fail + shared abort (T5, ADR-0007)", () => {
  function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  const okJson = (body: unknown): Response =>
    ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) }) as Response;
  const notOk = (status: number): Response =>
    ({ ok: false, status, json: async () => ({}), text: async () => "" }) as Response;

  test("one block's 404 rejects the whole findMany (never a silently-incomplete array) and aborts the outstanding parallel fetches", async () => {
    // All three blocks are candidates for an unfiltered findMany. s1 404s
    // immediately; s0/s2 hang forever behind a deferred — first failure must
    // win WITHOUT waiting for them, and their shared signal must fire.
    const hanging = deferred<Response>();
    const blockSignals: (AbortSignal | undefined)[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("manifest.json")) return okJson(manifest);
      blockSignals.push(init?.signal);
      if (url.includes("/blocks/s1.")) return notOk(404);
      return hanging.promise;
    }) as typeof fetch;

    const client = createClient<typeof schema, Records>(schema, { basePath: "/data", fetch: fetchImpl });
    const error = await client.movies.findMany().then(
      () => {
        throw new Error("expected findMany to reject, but it resolved");
      },
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(ZonemapDbError);
    expect((error as ZonemapDbError).code).toBe("DEPLOY_INTEGRITY");
    expect((error as ZonemapDbError).url).toBe("/data/blocks/s1.ndjson");
    expect((error as ZonemapDbError).status).toBe(404);
    // The query rejected while s0/s2 were still hanging — first-failure-wins,
    // and the ONE shared AbortController's signal fired for every in-flight fetch.
    expect(blockSignals).toHaveLength(3);
    const distinctSignals = new Set(blockSignals);
    expect(distinctSignals.size).toBe(1);
    for (const signal of blockSignals) expect(signal?.aborted).toBe(true);
  });

  test("a fetch rejection (network-level) surfaces as NETWORK with no status and aborts the rest", async () => {
    const hanging = deferred<Response>();
    const blockSignals: (AbortSignal | undefined)[] = [];
    const cause = new TypeError("fetch failed");
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("manifest.json")) return okJson(manifest);
      blockSignals.push(init?.signal);
      if (url.includes("/blocks/s2.")) throw cause;
      return hanging.promise;
    }) as typeof fetch;

    const client = createClient<typeof schema, Records>(schema, { basePath: "/data", fetch: fetchImpl });
    const error = await client.movies.findMany().then(
      () => {
        throw new Error("expected findMany to reject");
      },
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(ZonemapDbError);
    expect((error as ZonemapDbError).code).toBe("NETWORK");
    expect((error as ZonemapDbError).url).toBe("/data/blocks/s2.ndjson");
    expect("status" in (error as ZonemapDbError)).toBe(false);
    expect((error as ZonemapDbError).cause).toBe(cause);
    for (const signal of blockSignals) expect(signal?.aborted).toBe(true);
  });

  test("a chunk fetch failure rejects count() the same way — no partial upper bound", async () => {
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("manifest.json")) return okJson(manifest);
      if (url.includes("/index/")) return notOk(404);
      return okJson({});
    }) as typeof fetch;

    const client = createClient<typeof schema, Records>(schema, { basePath: "/data", fetch: fetchImpl });
    const error = await client.movies.count({ title: { equals: "Gladiator" } }).then(
      () => {
        throw new Error("expected count to reject");
      },
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ZonemapDbError);
    expect((error as ZonemapDbError).code).toBe("DEPLOY_INTEGRITY");
    expect((error as ZonemapDbError).url).toBe("/data/index/title/c1.json");
  });

  test("a corrupt block body mid-fan-out surfaces as CORRUPT_DATA, not a raw SyntaxError", async () => {
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("manifest.json")) return okJson(manifest);
      if (url.includes("/blocks/")) {
        return { ok: true, status: 200, text: async () => "definitely not ndjson\n" } as Response;
      }
      return notOk(404);
    }) as typeof fetch;

    const client = createClient<typeof schema, Records>(schema, { basePath: "/data", fetch: fetchImpl });
    const error = await client.movies.findMany({ where: { year: { equals: 1999 } } }).then(
      () => {
        throw new Error("expected findMany to reject");
      },
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ZonemapDbError);
    expect((error as ZonemapDbError).code).toBe("CORRUPT_DATA");
    expect((error as ZonemapDbError).cause).toBeInstanceOf(SyntaxError);
  });

  test("a structurally-corrupt index chunk (JSON-valid, not a chunk) surfaces as CORRUPT_DATA AND aborts the other field's in-flight chunk fetch", async () => {
    // Two indexed secondary fields, queried together → their chunk fetches run
    // in parallel. genre's chunk hangs; title's chunk decodes to garbage — the
    // decode failure must reject the query AND fire the shared abort (ADR-0007 §7).
    const twoFieldManifest: Manifest = {
      ...manifest,
      zonemap: { year: { splitPoints: [1999, 2000, 2003, 2008] } },
      indexes: {
        title: { operators: ["equals"], chunks: [{ from: "Gladiator", to: "Gladiator", file: "index/title/t1.json" }] },
        genre: { operators: ["equals"], chunks: [{ from: "drama", to: "drama", file: "index/genre/g1.json" }] },
      },
      schema: {
        ...manifest.schema,
        fields: {
          ...manifest.schema.fields,
          genre: { kind: "string", isDate: false, indexed: true, operators: ["equals"], pruning: ["equals"] },
        },
      },
    };
    const twoFieldSchema: SchemaMeta = { movies: { fields: twoFieldManifest.schema.fields } };
    interface TwoFieldRecords {
      movies: Movie & { genre: string };
    }

    const hanging = deferred<Response>();
    const genreSignals: (AbortSignal | undefined)[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("manifest.json")) return okJson(twoFieldManifest);
      if (url.endsWith("index/title/t1.json")) return okJson({ oops: "not a chunk" });
      if (url.endsWith("index/genre/g1.json")) {
        genreSignals.push(init?.signal);
        return hanging.promise;
      }
      return notOk(404);
    }) as typeof fetch;

    const client = createClient<typeof twoFieldSchema, TwoFieldRecords>(twoFieldSchema, {
      basePath: "/data",
      fetch: fetchImpl,
    });
    const error = await client.movies
      .findMany({ where: { title: { equals: "Gladiator" }, genre: { equals: "drama" } } })
      .then(
        () => {
          throw new Error("expected findMany to reject");
        },
        (e: unknown) => e,
      );

    expect(error).toBeInstanceOf(ZonemapDbError);
    expect((error as ZonemapDbError).code).toBe("CORRUPT_DATA");
    expect((error as ZonemapDbError).url).toBe("/data/index/title/t1.json");
    expect(genreSignals).toHaveLength(1);
    expect(genreSignals[0]?.aborted).toBe(true);
  });
});

describe("createClient / maxResults guardrail — fail-loud, never truncating (T5, ADR-0004/0007)", () => {
  const limitExceeded = async (promise: Promise<unknown>, message: RegExp): Promise<ZonemapDbError> => {
    const error = await promise.then(
      () => {
        throw new Error("expected the query to reject, but it resolved");
      },
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ZonemapDbError);
    const blockError = error as ZonemapDbError;
    expect(blockError.code).toBe("LIMIT_EXCEEDED");
    expect(blockError.message).toMatch(message);
    // No file was being fetched — url/status are absent, and the query object is never attached (PII).
    expect("url" in blockError).toBe(false);
    expect("status" in blockError).toBe(false);
    expect((blockError as unknown as Record<string, unknown>).query).toBeUndefined();
    return blockError;
  };

  test("an explicit limit above the ceiling throws LIMIT_EXCEEDED before ANY fetch", async () => {
    const requests: string[] = [];
    const client = createClient<typeof schema, Records>(schema, { basePath: "/data", fetch: fakeFetch(requests), maxResults: 5 });
    await limitExceeded(client.movies.findMany({ limit: 6 }), /limit 6.*maxResults.*5/);
    expect(requests).toEqual([]); // not even the manifest — pure client-side validation
  });

  test("an explicit limit equal to the ceiling is allowed", async () => {
    const client = createClient<typeof schema, Records>(schema, { basePath: "/data", fetch: fakeFetch([]), maxResults: 3 });
    const { records } = await client.movies.findMany({ limit: 3 });
    expect(records).toHaveLength(3);
  });

  test("an unbounded query that would exceed the ceiling throws rather than truncating", async () => {
    const client = createClient<typeof schema, Records>(schema, { basePath: "/data", fetch: fakeFetch([]), maxResults: 5 });
    // The fixture holds 6 movies; no limit ⇒ all 6 match > 5 ⇒ throw, not a silent 5-record array.
    await limitExceeded(client.movies.findMany(), /unbounded|limit/);
  });

  test("an unbounded query within the ceiling resolves normally", async () => {
    const client = createClient<typeof schema, Records>(schema, { basePath: "/data", fetch: fakeFetch([]), maxResults: 6 });
    const { records, hasMore } = await client.movies.findMany();
    expect(records).toHaveLength(6);
    expect(hasMore).toBe(false);
  });

  test("a bounded query never trips the ceiling even when total matches exceed it", async () => {
    const client = createClient<typeof schema, Records>(schema, { basePath: "/data", fetch: fakeFetch([]), maxResults: 2 });
    const { records, hasMore } = await client.movies.findMany({ limit: 2 });
    expect(records).toHaveLength(2);
    expect(hasMore).toBe(true); // paging through 6 matches two at a time is the intended use
  });

  test("the default ceiling is 10_000 (ADR-0004)", async () => {
    const client = createClient<typeof schema, Records>(schema, { basePath: "/data", fetch: fakeFetch([]) });
    await limitExceeded(client.movies.findMany({ limit: 10_001 }), /10_?000|10000/);
    const { records } = await client.movies.findMany({ limit: 10_000 });
    expect(records).toHaveLength(6);
  });

  test("count() is unaffected by the ceiling — it never materializes records", async () => {
    const client = createClient<typeof schema, Records>(schema, { basePath: "/data", fetch: fakeFetch([]), maxResults: 1 });
    await expect(client.movies.count()).resolves.toEqual({ count: 6, exact: true });
  });
});

describe("createClient / secondary zonemap sidecars (T13, ADR-0003 §3)", () => {
  // Same blocks/index as the shared fixture, plus a `title` zonemap spilled to a sidecar —
  // per-block [min,max]: block0 "The Matrix", block1 "Gladiator".."Snatch", block2 "Dark Knight".."Reloaded".
  const sidecarBody = JSON.stringify({
    pairs: [
      ["The Matrix", "The Matrix"],
      ["Gladiator", "Snatch"],
      ["Dark Knight", "Reloaded"],
    ],
    truncated: true,
  });
  const manifestWithSidecar: Manifest = {
    ...manifest,
    zonemap: { ...manifest.zonemap, title: { sidecar: "zonemap/title-abc123.json" } },
  };

  function fakeFetchWithSidecar(requests: string[], sidecarResponse: { status: number; body: string }): typeof fetch {
    return (async (input: RequestInfo | URL) => {
      const url = String(input);
      requests.push(url);
      if (url.endsWith("manifest.json")) {
        return { ok: true, status: 200, json: async () => manifestWithSidecar, text: async () => JSON.stringify(manifestWithSidecar) } as Response;
      }
      if (url.endsWith("zonemap/title-abc123.json")) {
        const { status, body } = sidecarResponse;
        return { ok: status >= 200 && status < 300, status, json: async () => JSON.parse(body), text: async () => body } as Response;
      }
      const indexMatch = url.match(/index\/title\/(\w+)\.json$/);
      if (indexMatch) {
        const body = indexChunks[indexMatch[1]!];
        if (!body) return { ok: false, status: 404, json: async () => ({}), text: async () => "" } as Response;
        return { ok: true, status: 200, json: async () => JSON.parse(body), text: async () => body } as Response;
      }
      const hash = url.split("/").pop()!.replace(".ndjson", "");
      const body = blockContents[hash];
      if (!body) return { ok: false, status: 404, json: async () => ({}), text: async () => "" } as Response;
      return { ok: true, status: 200, json: async () => JSON.parse(body), text: async () => body } as Response;
    }) as typeof fetch;
  }

  test("a query touching a spilled field lazily fetches its zonemap sidecar and still returns correct results", async () => {
    const requests: string[] = [];
    const client = createClient<typeof schema, Records>(schema, {
      basePath: "/data",
      fetch: fakeFetchWithSidecar(requests, { status: 200, body: sidecarBody }),
    });
    const { records } = await client.movies.findMany({ where: { title: { equals: "Gladiator" } } });

    expect(records.map((r) => r.title)).toEqual(["Gladiator"]);
    expect(requests).toContain("/data/zonemap/title-abc123.json");
  });

  test("a query NOT touching the spilled field never fetches its sidecar", async () => {
    const requests: string[] = [];
    const client = createClient<typeof schema, Records>(schema, {
      basePath: "/data",
      fetch: fakeFetchWithSidecar(requests, { status: 200, body: sidecarBody }),
    });
    await client.movies.findMany({ where: { year: { equals: 1999 } } });

    expect(requests.some((u) => u.includes("zonemap/"))).toBe(false);
  });

  test("a missing zonemap sidecar surfaces DEPLOY_INTEGRITY through findMany, same as any other manifest-referenced file (ADR-0007 §6)", async () => {
    const requests: string[] = [];
    const client = createClient<typeof schema, Records>(schema, {
      basePath: "/data",
      fetch: fakeFetchWithSidecar(requests, { status: 404, body: "" }),
    });

    const error = await client.movies.findMany({ where: { title: { equals: "Gladiator" } } }).then(
      () => {
        throw new Error("expected rejection");
      },
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ZonemapDbError);
    expect((error as ZonemapDbError).code).toBe("DEPLOY_INTEGRITY");
    expect((error as ZonemapDbError).url).toBe("/data/zonemap/title-abc123.json");
  });
});

// ---------------------------------------------------------------------------
// ADR-0008 §5: findMany walks candidate blocks in sort order accumulating
// matches until it has limit + 1, rather than fetching every candidate.
// 12 blocks x 5 records, one year per block — big enough that "stopped early"
// is distinguishable from "fetched everything".
// ---------------------------------------------------------------------------

const WALK_BLOCKS = 12;
const WALK_PER_BLOCK = 5;

const walkBlockContents: Record<string, string> = {};
for (let s = 0; s < WALK_BLOCKS; s++) {
  const lines: string[] = [];
  for (let r = 0; r < WALK_PER_BLOCK; r++) {
    lines.push(JSON.stringify({ year: 2000 + s, title: `t${s}-${r}`, rating: (s * WALK_PER_BLOCK + r) % 7 }));
  }
  walkBlockContents[`w${s}`] = lines.join("\n") + "\n";
}

const walkManifest: Manifest = {
  formatVersion: 0,
  generatorVersion: "0.1.0",
  dataset: { collection: "movies", recordCount: WALK_BLOCKS * WALK_PER_BLOCK, blockCount: WALK_BLOCKS, sortField: "year" },
  schema: {
    collection: "movies",
    sortField: "year",
    fields: {
      year: { kind: "number", isDate: false, indexed: true, operators: ["equals", "in", "gt", "gte", "lt", "lte"], pruning: ["equals", "in", "gt", "gte", "lt", "lte"] },
      title: { kind: "string", isDate: false, indexed: false, operators: [], pruning: [] },
      rating: { kind: "number", isDate: false, indexed: false, operators: [], pruning: [] },
    },
  },
  blocks: Array.from({ length: WALK_BLOCKS }, (_, s) => ({
    hash: `w${s}`,
    bytes: walkBlockContents[`w${s}`]!.length,
    count: WALK_PER_BLOCK,
  })),
  zonemap: { year: { splitPoints: [...Array.from({ length: WALK_BLOCKS }, (_, s) => 2000 + s), 2000 + WALK_BLOCKS - 1] } },
  indexes: {},
};

const walkSchema: SchemaMeta = { movies: { fields: walkManifest.schema.fields } };

interface WalkMovie {
  year: number;
  title: string;
  rating: number;
}
interface WalkRecords {
  movies: WalkMovie;
}

function walkFetch(requests: string[]): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    requests.push(url);
    if (url.endsWith("manifest.json")) {
      return { ok: true, status: 200, json: async () => walkManifest, text: async () => JSON.stringify(walkManifest) } as Response;
    }
    const hash = url.split("/").pop()!.replace(".ndjson", "");
    const body = walkBlockContents[hash];
    if (!body) return { ok: false, status: 404, json: async () => ({}), text: async () => "" } as Response;
    return { ok: true, status: 200, json: async () => JSON.parse(body), text: async () => body } as Response;
  }) as typeof fetch;
}

function walkClient(requests: string[]) {
  return createClient<typeof walkSchema, WalkRecords>(walkSchema, { basePath: "/data", fetch: walkFetch(requests) });
}
const blocksFetched = (requests: string[]): string[] => requests.filter((u) => u.includes("/blocks/"));

describe("findMany — bounded queries stop fetching once the page is filled (ADR-0008 §5)", () => {
  test("a small limit over many candidate blocks reads only the leading blocks", async () => {
    const requests: string[] = [];
    const { records, hasMore } = await walkClient(requests).movies.findMany({ where: { year: { gte: 2000 } }, limit: 3 });

    expect(records.map((r) => r.title)).toEqual(["t0-0", "t0-1", "t0-2"]);
    expect(hasMore).toBe(true);
    // the whole page lives in block 0; reading all 12 candidates would be the bug
    expect(blocksFetched(requests).length).toBeLessThan(WALK_BLOCKS);
    expect(blocksFetched(requests)).toContain("/data/blocks/w0.ndjson");
    expect(blocksFetched(requests)).not.toContain("/data/blocks/w11.ndjson");
  });

  test("returns exactly what the unbounded query's first page would be", async () => {
    const boundedReqs: string[] = [];
    const fullReqs: string[] = [];
    const bounded = await walkClient(boundedReqs).movies.findMany({ where: { year: { gte: 2000 } }, limit: 7 });
    const full = await walkClient(fullReqs).movies.findMany({ where: { year: { gte: 2000 } } });

    expect(bounded.records).toEqual(full.records.slice(0, 7));
    expect(bounded.hasMore).toBe(true);
    // ...for strictly less traffic
    expect(blocksFetched(boundedReqs).length).toBeLessThan(blocksFetched(fullReqs).length);
    expect(blocksFetched(fullReqs).length).toBe(WALK_BLOCKS);
  });

  test("offset composes — the page is offset + limit deep into the same ordering", async () => {
    const requests: string[] = [];
    const { records, hasMore } = await walkClient(requests).movies.findMany({
      where: { year: { gte: 2000 } },
      offset: 6,
      limit: 3,
    });
    expect(records.map((r) => r.title)).toEqual(["t1-1", "t1-2", "t1-3"]);
    expect(hasMore).toBe(true);
    expect(blocksFetched(requests).length).toBeLessThan(WALK_BLOCKS);
  });

  test("hasMore is exact at the boundary: false when the page ends the result set", async () => {
    const requests: string[] = [];
    // 60 records total; a limit that exactly consumes them must report no next page
    const { records, hasMore } = await walkClient(requests).movies.findMany({
      where: { year: { gte: 2000 } },
      limit: WALK_BLOCKS * WALK_PER_BLOCK,
    });
    expect(records).toHaveLength(WALK_BLOCKS * WALK_PER_BLOCK);
    expect(hasMore).toBe(false);
  });

  test("orderBy on the sort field descending walks from the last block instead", async () => {
    const requests: string[] = [];
    const { records, hasMore } = await walkClient(requests).movies.findMany({
      where: { year: { gte: 2000 } },
      orderBy: { year: "desc" },
      limit: 3,
    });
    expect(records.map((r) => r.year)).toEqual([2011, 2011, 2011]);
    expect(hasMore).toBe(true);
    expect(blocksFetched(requests)).toContain("/data/blocks/w11.ndjson");
    expect(blocksFetched(requests)).not.toContain("/data/blocks/w0.ndjson");
    expect(blocksFetched(requests).length).toBeLessThan(WALK_BLOCKS);
  });

  test("orderBy on a NON-sort field must still read every candidate — global order needs every match", async () => {
    const requests: string[] = [];
    const { records } = await walkClient(requests).movies.findMany({
      where: { year: { gte: 2000 } },
      orderBy: { rating: "desc" },
      limit: 3,
    });
    // rating maxes at 6; correctness here is the point, not traffic
    expect(records.map((r) => r.rating)).toEqual([6, 6, 6]);
    expect(blocksFetched(requests).length).toBe(WALK_BLOCKS);
  });

  test("an unbounded query still reads every candidate", async () => {
    const requests: string[] = [];
    const { records, hasMore } = await walkClient(requests).movies.findMany({ where: { year: { gte: 2000 } } });
    expect(records).toHaveLength(WALK_BLOCKS * WALK_PER_BLOCK);
    expect(hasMore).toBe(false);
    expect(blocksFetched(requests).length).toBe(WALK_BLOCKS);
  });

  test("a filter too selective to fill the page reads every candidate, and says there is no next page", async () => {
    const requests: string[] = [];
    // only 5 records match; a limit of 40 can never be filled, so early exit is impossible
    const { records, hasMore } = await walkClient(requests).movies.findMany({
      where: { year: { gte: 2000 }, title: { startsWith: "t7-" } },
      limit: 40,
    });
    expect(records).toHaveLength(WALK_PER_BLOCK);
    expect(hasMore).toBe(false);
    expect(blocksFetched(requests).length).toBe(WALK_BLOCKS);
  });
});
