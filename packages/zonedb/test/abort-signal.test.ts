import { describe, expect, test, vi } from "vitest";
import { createClient } from "../src/client.js";
import { ZoneDbError } from "../src/errors.js";
import type { Manifest } from "../src/manifest.js";
import type { SchemaMeta } from "../src/types.js";

// A caller's `signal` cancels a query: search-as-you-type aborts the previous keystroke's query so its
// block fetches stop competing with the one the user is waiting for.

const fields = {
  year: { kind: "number", isDate: false, indexed: true, operators: ["equals", "in", "gt", "gte", "lt", "lte"], pruning: ["equals", "in", "gt", "gte", "lt", "lte"] },
  title: { kind: "string", isDate: false, indexed: true, operators: ["equals", "in", "startsWith"], pruning: ["equals", "in", "startsWith"] },
} as const;

const manifest: Manifest = {
  formatVersion: 0,
  generatorVersion: "0.1.0",
  dataset: { collection: "movies", recordCount: 2, blockCount: 1, sortField: "year" },
  schema: { collection: "movies", sortField: "year", fields },
  blocks: [{ hash: "b0", bytes: 0, count: 2 }],
  zonemap: { year: { splitPoints: [1999, 2000] } },
  indexes: {
    title: { operators: ["equals", "in", "startsWith"], chunks: [{ from: "Gladiator", to: "The Matrix", file: "index/title/c0.json" }] },
  },
};
const block = '{"year":1999,"title":"The Matrix"}\n{"year":2000,"title":"Gladiator"}\n';
const chunk = JSON.stringify({
  entries: [
    { prefixLen: 0, suffix: "Gladiator", postings: [0] },
    { prefixLen: 0, suffix: "The Matrix", postings: [0] },
  ],
});

const schema: SchemaMeta = { movies: { fields, pk: "title" } };
interface Records {
  movies: { year: number; title: string };
}

interface Request {
  url: string;
  signal: AbortSignal | undefined;
}

const ok = (body: string): Response =>
  ({ ok: true, status: 200, json: async () => JSON.parse(body), text: async () => body }) as Response;

/**
 * Serves the deploy, holding back any URL in `held` until `release()` — or until the request's signal
 * aborts, which rejects it with an AbortError the way a real fetch does. `honorSignal: false` models an
 * injected fetch that ignores its signal.
 */
function slowHost(held: string[], opts: { honorSignal?: boolean } = {}) {
  const requests: Request[] = [];
  const waiting: (() => void)[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, signal: init?.signal ?? undefined });
    const body = url.endsWith("manifest.json") ? JSON.stringify(manifest) : url.endsWith(".ndjson") ? block : chunk;
    if (!held.some((h) => url.endsWith(h))) return ok(body);
    return new Promise<Response>((resolve, reject) => {
      waiting.push(() => resolve(ok(body)));
      const signal = init?.signal;
      if (opts.honorSignal !== false && signal) {
        signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      }
    });
  }) as typeof fetch;
  return { fetchImpl, requests, release: () => waiting.splice(0).forEach((go) => go()) };
}

function connect(fetchImpl: typeof fetch) {
  return createClient<typeof schema, Records>(schema, { basePath: "/data", fetch: fetchImpl });
}

async function caught(promise: Promise<unknown>): Promise<ZoneDbError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ZoneDbError);
    return error as ZoneDbError;
  }
  throw new Error("expected the query to reject");
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("findMany/count/get take a caller signal", () => {
  test("aborting mid-query cancels its pending block fetch and rejects with ABORTED", async () => {
    const host = slowHost([".ndjson"]);
    const db = connect(host.fetchImpl);
    const controller = new AbortController();
    const query = db.movies.findMany({ where: { year: { gte: 1999 } }, signal: controller.signal });
    await tick();
    const blockRequest = host.requests.find((r) => r.url.endsWith(".ndjson"))!;
    expect(blockRequest.signal?.aborted).toBe(false);

    const reason = new Error("newer keystroke");
    controller.abort(reason);
    const error = await caught(query);
    expect(error.code).toBe("ABORTED");
    expect(error.cause).toBe(reason);
    expect(error.url).toBeUndefined();
    expect(blockRequest.signal?.aborted).toBe(true);
  });

  test("an already-aborted signal fetches nothing", async () => {
    const host = slowHost([]);
    const controller = new AbortController();
    controller.abort();
    const error = await caught(connect(host.fetchImpl).movies.findMany({ where: { year: { gte: 1999 } }, signal: controller.signal }));
    expect(error.code).toBe("ABORTED");
    expect(host.requests.filter((r) => !r.url.endsWith("manifest.json"))).toEqual([]);
  });

  test("aborting one query never cancels the manifest fetch another query shares", async () => {
    const host = slowHost(["manifest.json"]);
    const db = connect(host.fetchImpl);
    const controller = new AbortController();
    const cancelled = db.movies.findMany({ where: { year: { gte: 1999 } }, signal: controller.signal });
    const other = db.movies.findMany({ where: { year: { equals: 2000 } } });
    await tick();
    controller.abort();
    expect((await caught(cancelled)).code).toBe("ABORTED");

    host.release();
    const { records } = await other;
    expect(records.map((r) => r.title)).toEqual(["Gladiator"]);
    const manifestRequests = host.requests.filter((r) => r.url.endsWith("manifest.json"));
    expect(manifestRequests).toHaveLength(1);
    expect(manifestRequests[0]!.signal?.aborted ?? false).toBe(false);
  });

  test("a fetch that ignores its signal can't hold a cancelled query open", async () => {
    const host = slowHost([".ndjson"], { honorSignal: false });
    const controller = new AbortController();
    const query = connect(host.fetchImpl).movies.findMany({ where: { year: { gte: 1999 } }, signal: controller.signal });
    await tick();
    controller.abort();
    expect((await caught(query)).code).toBe("ABORTED");
  });

  test("a cancelled query doesn't take the stale-manifest retry (#32)", async () => {
    // The block answers 404 once the query is cancelled: the DEPLOY_INTEGRITY a stale manifest would
    // raise, arriving after the abort. The query must still end as ABORTED, with no manifest refetch.
    const manifestUrls: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("manifest.json")) {
        manifestUrls.push(url);
        return ok(JSON.stringify(manifest));
      }
      return new Promise<Response>((resolve) => {
        init?.signal?.addEventListener("abort", () => resolve({ ok: false, status: 404, json: async () => ({}), text: async () => "" } as Response), {
          once: true,
        });
      });
    }) as typeof fetch;
    const controller = new AbortController();
    const query = connect(fetchImpl).movies.findMany({ where: { year: { gte: 1999 } }, signal: controller.signal });
    await tick();
    controller.abort();
    expect((await caught(query)).code).toBe("ABORTED");
    await tick();
    expect(manifestUrls).toHaveLength(1);
  });

  test("get and count take the signal too", async () => {
    const host = slowHost(["index/title/c0.json"]);
    const db = connect(host.fetchImpl);
    const controller = new AbortController();
    const lookup = db.movies.get("Gladiator", { signal: controller.signal });
    await tick();
    controller.abort();
    expect((await caught(lookup)).code).toBe("ABORTED");

    const aborted = new AbortController();
    aborted.abort();
    expect((await caught(db.movies.count(undefined, { signal: aborted.signal }))).code).toBe("ABORTED");
  });

  test("a query that finishes leaves no listener on a long-lived signal", async () => {
    const host = slowHost([]);
    const db = connect(host.fetchImpl);
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, "addEventListener");
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    for (let i = 0; i < 3; i++) await db.movies.findMany({ where: { year: { gte: 1999 } }, signal: controller.signal });
    expect(add.mock.calls.length).toBeGreaterThan(0);
    expect(remove.mock.calls.length).toBe(add.mock.calls.length);
  });

  test("without a signal nothing changes", async () => {
    const host = slowHost([]);
    const { records } = await connect(host.fetchImpl).movies.findMany({ where: { year: { gte: 1999 } } });
    expect(records).toHaveLength(2);
  });
});
