import { describe, expect, test } from "vitest";
import { createClient } from "../src/client.js";
import { ZoneDbError } from "../src/errors.js";
import { manifestReferences, type Manifest } from "../src/manifest.js";
import type { SchemaMeta } from "../src/types.js";

// #32: a host that caches manifest.json (GitHub Pages sends max-age=600 on everything) can hand a
// browser the previous deploy's manifest, which names content-hashed files the new deploy removed.

const fields = {
  year: { kind: "number", isDate: false, indexed: true, operators: ["equals", "in", "gt", "gte", "lt", "lte"], pruning: ["equals", "in", "gt", "gte", "lt", "lte"] },
  title: { kind: "string", isDate: false, indexed: true, operators: ["equals", "in", "startsWith"], pruning: ["equals", "in", "startsWith"] },
} as const;

/** One block, one index chunk — the redeploy renames both, as a content change would. */
function deployManifest(blockHash: string, chunkFile: string): Manifest {
  return {
    formatVersion: 0,
    generatorVersion: "0.1.0",
    dataset: { collection: "movies", recordCount: 2, blockCount: 1, sortField: "year" },
    schema: { collection: "movies", sortField: "year", fields },
    blocks: [{ hash: blockHash, bytes: 0, count: 2 }],
    zonemap: { year: { splitPoints: [1999, 2000] } },
    indexes: {
      title: { operators: ["equals", "in", "startsWith"], chunks: [{ from: "Gladiator", to: "The Matrix", file: chunkFile }] },
    },
  };
}

const oldDeploy = deployManifest("old0", "index/title/old.json");
const newDeploy = deployManifest("new0", "index/title/new.json");

/** What the host currently serves: only the NEW deploy's files. */
const served: Record<string, string> = {
  "/data/blocks/new0.ndjson": '{"year":1999,"title":"The Matrix"}\n{"year":2000,"title":"Gladiator"}\n',
  "/data/index/title/new.json": JSON.stringify({
    entries: [
      { prefixLen: 0, suffix: "Gladiator", postings: [0] },
      { prefixLen: 0, suffix: "The Matrix", postings: [0] },
    ],
  }),
};

const schema: SchemaMeta = { movies: { fields, pk: "title" } };
interface Records {
  movies: { year: number; title: string };
}

interface Seen {
  url: string;
  cache: RequestCache | undefined;
}

/**
 * A browser in front of a caching host: a plain or `no-cache` manifest request gets `cached` (the
 * copy it already holds — a host that won't revalidate properly), a `reload` gets `current`.
 */
function hostFetch(seen: Seen[], cached: Manifest, current: Manifest | "error" = newDeploy): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    seen.push({ url, cache: init?.cache });
    if (url.endsWith("manifest.json")) {
      const body = init?.cache === "reload" ? current : cached;
      if (body === "error") return { ok: false, status: 503, json: async () => ({}), text: async () => "" } as Response;
      return { ok: true, status: 200, json: async () => structuredClone(body), text: async () => JSON.stringify(body) } as Response;
    }
    const body = served[url];
    if (body === undefined) return { ok: false, status: 404, json: async () => ({}), text: async () => "" } as Response;
    return { ok: true, status: 200, json: async () => JSON.parse(body), text: async () => body } as Response;
  }) as typeof fetch;
}

const manifestRequests = (seen: Seen[]) => seen.filter((s) => s.url.endsWith("manifest.json"));

async function caught(promise: Promise<unknown>): Promise<ZoneDbError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ZoneDbError);
    return error as ZoneDbError;
  }
  throw new Error("expected the query to throw");
}

describe("stale cached manifest after a redeploy (#32)", () => {
  test("the manifest is requested with cache: no-cache; content-hashed files carry no cache mode", async () => {
    const seen: Seen[] = [];
    const client = createClient<typeof schema, Records>(schema, { basePath: "/data", fetch: hostFetch(seen, newDeploy) });
    await client.movies.findMany({ where: { title: { equals: "Gladiator" } } });
    expect(manifestRequests(seen)).toEqual([{ url: "/data/manifest.json", cache: "no-cache" }]);
    for (const s of seen.filter((s) => !s.url.endsWith("manifest.json"))) expect(s.cache).toBeUndefined();
  });

  test("an index chunk 404 from a stale manifest: refetches with cache: reload and the retry succeeds", async () => {
    const seen: Seen[] = [];
    const client = createClient<typeof schema, Records>(schema, { basePath: "/data", fetch: hostFetch(seen, oldDeploy) });
    const { records } = await client.movies.findMany({ where: { title: { equals: "Gladiator" } } });
    expect(records).toEqual([{ year: 2000, title: "Gladiator" }]);
    expect(manifestRequests(seen).map((s) => s.cache)).toEqual(["no-cache", "reload"]);
    expect(seen.map((s) => s.url)).toContain("/data/index/title/old.json");

    // The fresh manifest replaced the cached one: the next query goes straight to the new files.
    seen.length = 0;
    await client.movies.findMany({ where: { title: { equals: "The Matrix" } } });
    expect(seen.map((s) => s.url)).toEqual(["/data/index/title/new.json", "/data/blocks/new0.ndjson"]);
  });

  test("a block 404 from a stale manifest recovers the same way, through get()", async () => {
    const seen: Seen[] = [];
    const client = createClient<typeof schema, Records>(schema, { basePath: "/data", fetch: hostFetch(seen, oldDeploy) });
    // year is the sort field, so this reads the (renamed) block without touching an index chunk.
    const { records } = await client.movies.findMany({ where: { year: { equals: 1999 } } });
    expect(records).toEqual([{ year: 1999, title: "The Matrix" }]);
    expect(seen.map((s) => s.url)).toContain("/data/blocks/old0.ndjson");

    const other = createClient<typeof schema, Records>(schema, { basePath: "/data", fetch: hostFetch([], oldDeploy) });
    expect(await (other.movies as unknown as { get(id: string): Promise<unknown> }).get("Gladiator")).toEqual({ year: 2000, title: "Gladiator" });
  });

  test("concurrent queries failing on the same stale manifest share one refetch", async () => {
    const seen: Seen[] = [];
    const client = createClient<typeof schema, Records>(schema, { basePath: "/data", fetch: hostFetch(seen, oldDeploy) });
    const results = await Promise.all([
      client.movies.findMany({ where: { title: { equals: "Gladiator" } } }),
      client.movies.findMany({ where: { title: { equals: "The Matrix" } } }),
      client.movies.findMany({ where: { year: { equals: 2000 } } }),
    ]);
    expect(results.map((r) => r.records.length)).toEqual([1, 1, 1]);
    expect(manifestRequests(seen).map((s) => s.cache)).toEqual(["no-cache", "reload"]);
  });

  test("the fresh manifest still names the missing file → DEPLOY_INTEGRITY, without rerunning the query", async () => {
    const partial = deployManifest("new0", "index/title/never-uploaded.json");
    const seen: Seen[] = [];
    const client = createClient<typeof schema, Records>(schema, { basePath: "/data", fetch: hostFetch(seen, oldDeploy, partial) });
    // The stale manifest's chunk 404s; the fresh one names a different file, which also 404s. That
    // second 404 comes from a manifest that was just fetched fresh, so it is thrown as-is.
    const firstError = await caught(client.movies.findMany({ where: { title: { equals: "Gladiator" } } }));
    expect(firstError.code).toBe("DEPLOY_INTEGRITY");
    expect(firstError.url).toBe("/data/index/title/never-uploaded.json");
    expect(manifestRequests(seen).map((s) => s.cache)).toEqual(["no-cache", "reload"]);

    // Now the cached manifest IS the fresh one, and it names the missing file: one reload confirms
    // it, and the query isn't rerun.
    seen.length = 0;
    const error = await caught(client.movies.findMany({ where: { title: { equals: "Gladiator" } } }));
    expect(error.code).toBe("DEPLOY_INTEGRITY");
    expect(error.status).toBe(404);
    expect(error.message).toMatch(/stale cache/);
    expect(error.message).toMatch(/redeploy/);
    expect(seen.map((s) => `${s.url} ${s.cache ?? ""}`.trim())).toEqual([
      "/data/index/title/never-uploaded.json",
      "/data/manifest.json reload",
    ]);
  });

  test("an unchanged manifest → DEPLOY_INTEGRITY after exactly one refetch, no loop", async () => {
    const partial = deployManifest("new0", "index/title/never-uploaded.json");
    const seen: Seen[] = [];
    const client = createClient<typeof schema, Records>(schema, { basePath: "/data", fetch: hostFetch(seen, partial, partial) });
    const error = await caught(client.movies.findMany({ where: { title: { equals: "Gladiator" } } }));
    expect(error.code).toBe("DEPLOY_INTEGRITY");
    expect(error.url).toBe("/data/index/title/never-uploaded.json");
    expect(manifestRequests(seen).map((s) => s.cache)).toEqual(["no-cache", "reload"]);
    expect(seen.filter((s) => s.url.endsWith("never-uploaded.json"))).toHaveLength(1);
  });

  test("a refetch that itself fails surfaces its own error, and the next failing query tries again", async () => {
    const seen: Seen[] = [];
    const client = createClient<typeof schema, Records>(schema, { basePath: "/data", fetch: hostFetch(seen, oldDeploy, "error") });
    const error = await caught(client.movies.findMany({ where: { title: { equals: "Gladiator" } } }));
    expect(error.code).toBe("NETWORK");
    expect(error.status).toBe(503);

    seen.length = 0;
    await caught(client.movies.findMany({ where: { title: { equals: "Gladiator" } } }));
    expect(manifestRequests(seen).map((s) => s.cache)).toEqual(["reload"]);
  });

  test("a single-page-app host (200 + index.html for a missing file) gets the same recovery", async () => {
    const seen: Seen[] = [];
    const inner = hostFetch(seen, oldDeploy);
    const html = { ok: true, status: 200, headers: new Headers({ "content-type": "text/html; charset=utf-8" }), text: async () => "<!doctype html>" };
    const spaFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await inner(input, init);
      return response.status === 404 ? ({ ...html, json: async () => JSON.parse("<") } as unknown as Response) : response;
    }) as typeof fetch;
    const client = createClient<typeof schema, Records>(schema, { basePath: "/data", fetch: spaFetch });
    const { records } = await client.movies.findMany({ where: { title: { equals: "Gladiator" } } });
    expect(records.map((r) => r.title)).toEqual(["Gladiator"]);
    expect(manifestRequests(seen).map((s) => s.cache)).toEqual(["no-cache", "reload"]);

    const stuck = createClient<typeof schema, Records>(schema, {
      basePath: "/data",
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) =>
        String(input).endsWith("manifest.json") ? spaFetch(input, init) : ({ ...html } as unknown as Response)) as typeof fetch,
    });
    const error = await caught(stuck.movies.findMany({ where: { title: { equals: "Gladiator" } } }));
    expect(error.code).toBe("DEPLOY_INTEGRITY");
    expect(error.message).toMatch(/HTML page/);
  });

  test("a first manifest fetch that fails isn't cached: the next query fetches it again", async () => {
    let failNext = true;
    const inner = hostFetch([], newDeploy);
    let manifestFetches = 0;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("manifest.json")) {
        manifestFetches++;
        if (failNext) {
          failNext = false;
          return { ok: false, status: 503, json: async () => ({}), text: async () => "" } as Response;
        }
      }
      return inner(input, init);
    }) as typeof fetch;
    const client = createClient<typeof schema, Records>(schema, { basePath: "/data", fetch: fetchImpl });
    expect((await caught(client.movies.count())).code).toBe("NETWORK");
    expect(await client.movies.count()).toEqual({ count: 2, exact: true });
    expect(manifestFetches).toBe(2);
  });
});

describe("manifestReferences", () => {
  test("recognises blocks, index chunks (base/reversed/trigram) and zonemap sidecars by served url", () => {
    const manifest: Manifest = {
      ...newDeploy,
      dataset: { ...newDeploy.dataset, compression: "gzip" },
      zonemap: { ...newDeploy.zonemap, title: { sidecar: "zonemaps/title.json.gz" } },
      indexes: {
        title: {
          ...newDeploy.indexes.title!,
          reversed: { chunks: [{ from: "a", to: "z", file: "index/title.rev/r.json" }] },
          trigram: { chunks: [{ from: "a", to: "z", file: "index/title.tri/t.json" }] },
        },
      },
    };
    for (const path of [
      "blocks/new0.ndjson.gz",
      "index/title/new.json",
      "index/title.rev/r.json",
      "index/title.tri/t.json",
      "zonemaps/title.json.gz",
    ]) {
      expect(manifestReferences(manifest, "/data", `/data/${path}`)).toBe(true);
    }
    expect(manifestReferences(manifest, "/data", "/data/blocks/new0.ndjson")).toBe(false);
    expect(manifestReferences(manifest, "/data", "/data/index/title/old.json")).toBe(false);
    expect(manifestReferences(manifest, "/other", "/data/index/title/new.json")).toBe(false);
  });
});
