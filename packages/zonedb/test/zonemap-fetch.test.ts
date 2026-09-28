import { describe, expect, test } from "vitest";
import { ZoneDbError } from "../src/errors.js";
import { fetchZonemapSidecar } from "../src/zonemap-fetch.js";

function fakeFetch(responses: Record<string, { status: number; body: string }>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    const entry = responses[url];
    if (!entry) throw new Error(`fakeFetch: no response registered for ${url}`);
    return {
      ok: entry.status >= 200 && entry.status < 300,
      status: entry.status,
      json: async () => JSON.parse(entry.body),
      text: async () => entry.body,
    } as Response;
  }) as typeof fetch;
}

describe("fetchZonemapSidecar", () => {
  test("fetches and parses a zonemap sidecar file relative to basePath", async () => {
    const body = JSON.stringify({ pairs: [["Alpha", "Zeta"]], truncated: true });
    const fetchImpl = fakeFetch({ "/data/zonemap/director-abc123.json": { status: 200, body } });
    const entry = await fetchZonemapSidecar("/data", "zonemap/director-abc123.json", fetchImpl);
    expect(entry).toEqual({ pairs: [["Alpha", "Zeta"]], truncated: true });
  });

  test("a missing sidecar 404 → DEPLOY_INTEGRITY with url + status (ADR-0007 §6)", async () => {
    const fetchImpl = fakeFetch({ "/data/zonemap/director-missing.json": { status: 404, body: "" } });
    const error = await fetchZonemapSidecar("/data", "zonemap/director-missing.json", fetchImpl).then(
      () => {
        throw new Error("expected rejection");
      },
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ZoneDbError);
    expect((error as ZoneDbError).code).toBe("DEPLOY_INTEGRITY");
    expect((error as ZoneDbError).url).toBe("/data/zonemap/director-missing.json");
    expect((error as ZoneDbError).status).toBe(404);
  });

  test("a 2xx sidecar body that won't parse → CORRUPT_DATA", async () => {
    const fetchImpl = fakeFetch({ "/data/zonemap/director-bad.json": { status: 200, body: "}{" } });
    const error = await fetchZonemapSidecar("/data", "zonemap/director-bad.json", fetchImpl).then(
      () => {
        throw new Error("expected rejection");
      },
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ZoneDbError);
    expect((error as ZoneDbError).code).toBe("CORRUPT_DATA");
    expect((error as ZoneDbError).cause).toBeInstanceOf(SyntaxError);
  });
});
