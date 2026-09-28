import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { ZoneDbError } from "../src/errors.js";
import { fetchManifest, type Manifest } from "../src/manifest.js";
import { FORMAT_VERSION } from "../src/version.js";

const manifest: Manifest = {
  formatVersion: 0,
  generatorVersion: "0.1.0",
  dataset: { collection: "movies", recordCount: 1, blockCount: 1, sortField: "year" },
  schema: { collection: "movies", sortField: "year", fields: {} },
  blocks: [{ hash: "abc", bytes: 1, count: 1 }],
  zonemap: { year: { splitPoints: [2000, 2000] } },
  indexes: {},
};

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

async function expectZoneDbError(
  promise: Promise<unknown>,
  expected: { code: string; url?: string; status?: number; message: RegExp },
): Promise<ZoneDbError> {
  const error = await promise.then(
    () => {
      throw new Error("expected the promise to reject, but it resolved");
    },
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ZoneDbError);
  const blockError = error as ZoneDbError;
  expect(blockError.code).toBe(expected.code);
  expect(blockError.message).toMatch(expected.message);
  if (expected.url !== undefined) expect(blockError.url).toBe(expected.url);
  if (expected.status !== undefined) expect(blockError.status).toBe(expected.status);
  return blockError;
}

describe("fetchManifest", () => {
  test("fetches and parses manifest.json from basePath", async () => {
    const fetchImpl = fakeFetch({ "/data/manifest.json": { status: 200, body: JSON.stringify(manifest) } });
    const result = await fetchManifest("/data", fetchImpl);
    expect(result).toEqual(manifest);
  });

  test("manifest.json 404 → CONFIG with url, status and a basePath remediation (ADR-0007 §6)", async () => {
    const fetchImpl = fakeFetch({ "/data/manifest.json": { status: 404, body: "" } });
    await expectZoneDbError(fetchManifest("/data", fetchImpl), {
      code: "CONFIG",
      url: "/data/manifest.json",
      status: 404,
      message: /basePath/,
    });
  });

  test("manifest.json 500 → NETWORK with url + status (the maybe-transient bucket)", async () => {
    const fetchImpl = fakeFetch({ "/data/manifest.json": { status: 500, body: "" } });
    await expectZoneDbError(fetchManifest("/data", fetchImpl), {
      code: "NETWORK",
      url: "/data/manifest.json",
      status: 500,
      message: /500/,
    });
  });

  test("a rejected fetch → NETWORK with NO status and the original error as cause", async () => {
    const cause = new TypeError("fetch failed");
    const fetchImpl = (async () => {
      throw cause;
    }) as typeof fetch;
    const error = await expectZoneDbError(fetchManifest("/data", fetchImpl), {
      code: "NETWORK",
      url: "/data/manifest.json",
      message: /fetch failed/,
    });
    expect("status" in error).toBe(false);
    expect(error.cause).toBe(cause);
  });

  test("a 2xx body that won't parse → CORRUPT_DATA with the parse error as cause", async () => {
    const fetchImpl = fakeFetch({ "/data/manifest.json": { status: 200, body: "<html>not json</html>" } });
    const error = await expectZoneDbError(fetchManifest("/data", fetchImpl), {
      code: "CORRUPT_DATA",
      url: "/data/manifest.json",
      message: /parse|JSON/i,
    });
    expect(error.cause).toBeInstanceOf(SyntaxError);
  });

  test("a JSON-valid body that isn't a manifest (no numeric formatVersion) → CORRUPT_DATA, not a bogus FORMAT_VERSION", async () => {
    const fetchImpl = fakeFetch({ "/data/manifest.json": { status: 200, body: '{"hello":"world"}' } });
    await expectZoneDbError(fetchManifest("/data", fetchImpl), {
      code: "CORRUPT_DATA",
      url: "/data/manifest.json",
      message: /formatVersion|manifest/i,
    });
  });

  test("manifest major ≠ runtime major → FORMAT_VERSION with an align-and-rebuild remediation (ADR-0005)", async () => {
    const mismatched = { ...manifest, formatVersion: FORMAT_VERSION + 1 };
    const fetchImpl = fakeFetch({ "/data/manifest.json": { status: 200, body: JSON.stringify(mismatched) } });
    await expectZoneDbError(fetchManifest("/data", fetchImpl), {
      code: "FORMAT_VERSION",
      url: "/data/manifest.json",
      message: /zonedb build/,
    });
  });
});

describe("FORMAT_VERSION constant", () => {
  test("equals the runtime package's own major (ADR-0005: formatVersion = the package major)", () => {
    const packageJsonPath = fileURLToPath(new URL("../package.json", import.meta.url));
    const { version } = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { version: string };
    expect(FORMAT_VERSION).toBe(parseInt(version.split(".")[0]!, 10));
  });
});

describe("fetchManifest — build-time gzipped manifest (ADR-0002 §8)", () => {
  function fakeGzipFetch(url: string, bytes: Uint8Array): { impl: typeof fetch; urls: string[] } {
    const urls: string[] = [];
    const impl = (async (input: RequestInfo | URL) => {
      urls.push(String(input));
      if (String(input) !== url) return { ok: false, status: 404, json: async () => ({}), text: async () => "" } as Response;
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
    return { impl, urls };
  }

  test("gzipped: true fetches manifest.json.gz and decompresses it", async () => {
    // The manifest is the bootstrap fetch, so unlike index chunks nothing can tell the client how it
    // was encoded — the generated client carries the answer instead.
    const { impl, urls } = fakeGzipFetch("/data/manifest.json.gz", gzipSync(JSON.stringify(manifest)));
    expect(await fetchManifest("/data", impl, "gzip")).toEqual(manifest);
    expect(urls).toEqual(["/data/manifest.json.gz"]);
  });

  test("omitting the flag keeps the plain path — the default deploy is uncompressed", async () => {
    const fetchImpl = fakeFetch({ "/data/manifest.json": { status: 200, body: JSON.stringify(manifest) } });
    expect(await fetchManifest("/data", fetchImpl)).toEqual(manifest);
  });

  test("a gzipped manifest that isn't valid gzip → CORRUPT_DATA, not a silent empty dataset", async () => {
    const { impl } = fakeGzipFetch("/data/manifest.json.gz", new TextEncoder().encode("not gzip"));
    const error = await fetchManifest("/data", impl, "gzip").then(
      () => {
        throw new Error("expected rejection");
      },
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ZoneDbError);
    expect((error as ZoneDbError).code).toBe("CORRUPT_DATA");
  });

  test("a missing gzipped manifest still reports CONFIG against the .gz url (ADR-0007 §6)", async () => {
    const { impl } = fakeGzipFetch("/data/elsewhere.json.gz", gzipSync("{}"));
    const error = await fetchManifest("/data", impl, "gzip").then(
      () => {
        throw new Error("expected rejection");
      },
      (e: unknown) => e,
    );
    expect((error as ZoneDbError).code).toBe("CONFIG");
    expect((error as ZoneDbError).url).toBe("/data/manifest.json.gz");
  });
});
