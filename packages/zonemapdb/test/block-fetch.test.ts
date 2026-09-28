import { gzipSync } from "node:zlib";
import { describe, expect, test } from "vitest";
import { ZonemapDbError } from "../src/errors.js";
import { fetchBlockRecords } from "../src/block-fetch.js";

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

/** A fake fetch whose response exposes a real (Web Streams) `.body`, for `DecompressionStream` piping. */
function fakeBinaryFetch(url: string, bytes: Uint8Array): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    if (String(input) !== url) throw new Error(`fakeBinaryFetch: no response registered for ${input}`);
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

describe("fetchBlockRecords", () => {
  test("parses NDJSON lines into records", async () => {
    const body = '{"year":2000,"title":"A"}\n{"year":2001,"title":"B"}\n';
    const fetchImpl = fakeFetch({ "/data/blocks/abc123.ndjson": { status: 200, body } });
    const records = await fetchBlockRecords("/data", "abc123", 1, "none", fetchImpl);
    expect(records).toEqual([
      { year: 2000, title: "A" },
      { year: 2001, title: "B" },
    ]);
  });

  test("a manifest-referenced block 404 → DEPLOY_INTEGRITY with a rebuild-and-redeploy remediation (ADR-0007 §6)", async () => {
    const fetchImpl = fakeFetch({ "/data/blocks/missing.ndjson": { status: 404, body: "" } });
    const error = await fetchBlockRecords("/data", "missing", 1, "none", fetchImpl).then(
      () => {
        throw new Error("expected rejection");
      },
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ZonemapDbError);
    expect((error as ZonemapDbError).code).toBe("DEPLOY_INTEGRITY");
    expect((error as ZonemapDbError).url).toBe("/data/blocks/missing.ndjson");
    expect((error as ZonemapDbError).status).toBe(404);
    expect((error as ZonemapDbError).message).toMatch(/redeploy/);
  });

  test("a 2xx block body with an unparseable NDJSON line → CORRUPT_DATA with the parse error as cause", async () => {
    const body = '{"year":2000,"title":"A"}\nnot-json\n';
    const fetchImpl = fakeFetch({ "/data/blocks/bad.ndjson": { status: 200, body } });
    const error = await fetchBlockRecords("/data", "bad", 1, "none", fetchImpl).then(
      () => {
        throw new Error("expected rejection");
      },
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ZonemapDbError);
    expect((error as ZonemapDbError).code).toBe("CORRUPT_DATA");
    expect((error as ZonemapDbError).url).toBe("/data/blocks/bad.ndjson");
    expect((error as ZonemapDbError).cause).toBeInstanceOf(SyntaxError);
  });

  test("passes the query's abort signal through to the injected fetch (ADR-0007 §7)", async () => {
    let seenSignal: AbortSignal | null | undefined;
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      seenSignal = init?.signal;
      return { ok: true, status: 200, text: async () => '{"a":1}\n' } as Response;
    }) as typeof fetch;
    const controller = new AbortController();
    await fetchBlockRecords("/data", "abc", 1, "none", fetchImpl, controller.signal);
    expect(seenSignal).toBe(controller.signal);
  });

  test("nests under a 2-hex-char prefix subdir once blockCount exceeds ~1,000 (ADR-0002 §8)", async () => {
    const body = '{"year":2000,"title":"A"}\n';
    const fetchImpl = fakeFetch({ "/data/blocks/ab/abc123.ndjson": { status: 200, body } });
    const records = await fetchBlockRecords("/data", "abc123", 1001, "none", fetchImpl);
    expect(records).toEqual([{ year: 2000, title: "A" }]);
  });

  test("stays flat at exactly the threshold (1000 blocks)", async () => {
    const body = '{"year":2000,"title":"A"}\n';
    const fetchImpl = fakeFetch({ "/data/blocks/abc123.ndjson": { status: 200, body } });
    const records = await fetchBlockRecords("/data", "abc123", 1000, "none", fetchImpl);
    expect(records).toEqual([{ year: 2000, title: "A" }]);
  });

  describe("gzip (ADR-0002 §8: opt-in build-time gzip, decompressed via native DecompressionStream)", () => {
    test("fetches a .ndjson.gz block, decompresses, and parses NDJSON", async () => {
      const body = '{"year":2000,"title":"A"}\n{"year":2001,"title":"B"}\n';
      const fetchImpl = fakeBinaryFetch("/data/blocks/abc123.ndjson.gz", gzipSync(body));
      const records = await fetchBlockRecords("/data", "abc123", 1, "gzip", fetchImpl);
      expect(records).toEqual([
        { year: 2000, title: "A" },
        { year: 2001, title: "B" },
      ]);
    });

    test("nests under a hash-prefix subdir with the .gz extension once past the block-count threshold", async () => {
      const body = '{"year":2000,"title":"A"}\n';
      const fetchImpl = fakeBinaryFetch("/data/blocks/ab/abc123.ndjson.gz", gzipSync(body));
      const records = await fetchBlockRecords("/data", "abc123", 1001, "gzip", fetchImpl);
      expect(records).toEqual([{ year: 2000, title: "A" }]);
    });

    test("a 2xx body that isn't valid gzip → CORRUPT_DATA", async () => {
      const fetchImpl = fakeBinaryFetch("/data/blocks/bad.ndjson.gz", new TextEncoder().encode("not gzip"));
      const error = await fetchBlockRecords("/data", "bad", 1, "gzip", fetchImpl).then(
        () => {
          throw new Error("expected rejection");
        },
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(ZonemapDbError);
      expect((error as ZonemapDbError).code).toBe("CORRUPT_DATA");
      expect((error as ZonemapDbError).url).toBe("/data/blocks/bad.ndjson.gz");
    });
  });
});
