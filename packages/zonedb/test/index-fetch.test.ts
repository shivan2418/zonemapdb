import { gzipSync } from "node:zlib";
import { describe, expect, test } from "vitest";
import { ZoneDbError } from "../src/errors.js";
import { fetchIndexChunk } from "../src/index-fetch.js";

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

describe("fetchIndexChunk", () => {
  test("fetches and parses an index chunk file relative to basePath", async () => {
    const body = JSON.stringify({ entries: [{ prefixLen: 0, suffix: "Gladiator", postings: [1] }] });
    const fetchImpl = fakeFetch({ "/data/index/title/abc123.json": { status: 200, body } });
    const chunk = await fetchIndexChunk("/data", "index/title/abc123.json", fetchImpl);
    expect(chunk).toEqual({ entries: [{ prefixLen: 0, suffix: "Gladiator", postings: [1] }] });
  });

  test("a manifest-referenced chunk 404 → DEPLOY_INTEGRITY with url + status (ADR-0007 §6)", async () => {
    const fetchImpl = fakeFetch({ "/data/index/title/missing.json": { status: 404, body: "" } });
    const error = await fetchIndexChunk("/data", "index/title/missing.json", fetchImpl).then(
      () => {
        throw new Error("expected rejection");
      },
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ZoneDbError);
    expect((error as ZoneDbError).code).toBe("DEPLOY_INTEGRITY");
    expect((error as ZoneDbError).url).toBe("/data/index/title/missing.json");
    expect((error as ZoneDbError).status).toBe(404);
  });

  test("a 2xx chunk body that won't parse → CORRUPT_DATA", async () => {
    const fetchImpl = fakeFetch({ "/data/index/title/bad.json": { status: 200, body: "}{" } });
    const error = await fetchIndexChunk("/data", "index/title/bad.json", fetchImpl).then(
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

describe("fetchIndexChunk — build-time gzipped chunks (ADR-0002 §8)", () => {
  /** A gzipped body must be read as a stream, so it needs a `body`, not `.json()`/`.text()`. */
  function fakeGzipFetch(url: string, bytes: Uint8Array): typeof fetch {
    return (async (input: RequestInfo | URL) => {
      if (String(input) !== url) throw new Error(`fakeGzipFetch: no response registered for ${input}`);
      return {
        ok: true,
        status: 200,
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(bytes);
            controller.close();
          },
        }),
      } as unknown as Response;
    }) as typeof fetch;
  }

  const chunk = { entries: [{ prefixLen: 0, suffix: "Gladiator", postings: [1] }] };

  test("a .json.gz path is decompressed — the path itself says how it was built, no manifest flag", async () => {
    const fetchImpl = fakeGzipFetch("/data/index/title/abc123.json.gz", gzipSync(JSON.stringify(chunk)));
    expect(await fetchIndexChunk("/data", "index/title/abc123.json.gz", fetchImpl)).toEqual(chunk);
  });

  test("a plain .json path in the same deploy still reads uncompressed", async () => {
    const body = JSON.stringify(chunk);
    const fetchImpl = (async () => ({ ok: true, status: 200, json: async () => JSON.parse(body), text: async () => body }) as Response) as typeof fetch;
    expect(await fetchIndexChunk("/data", "index/title/abc123.json", fetchImpl)).toEqual(chunk);
  });

  test("a .json.gz body that isn't valid gzip → CORRUPT_DATA", async () => {
    const fetchImpl = fakeGzipFetch("/data/index/title/bad.json.gz", new TextEncoder().encode("not gzip"));
    const error = await fetchIndexChunk("/data", "index/title/bad.json.gz", fetchImpl).then(
      () => {
        throw new Error("expected rejection");
      },
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ZoneDbError);
    expect((error as ZoneDbError).code).toBe("CORRUPT_DATA");
  });

  test("valid gzip whose payload isn't JSON → CORRUPT_DATA", async () => {
    const fetchImpl = fakeGzipFetch("/data/index/title/bad.json.gz", gzipSync("{not json"));
    const error = await fetchIndexChunk("/data", "index/title/bad.json.gz", fetchImpl).then(
      () => {
        throw new Error("expected rejection");
      },
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ZoneDbError);
    expect((error as ZoneDbError).code).toBe("CORRUPT_DATA");
  });
});
