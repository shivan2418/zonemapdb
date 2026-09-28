import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { build } from "../src/build.js";
import type { ZoneDbConfig } from "../src/types.js";

// Placed under this package's own test/ dir (not os.tmpdir()) so the
// generated client.ts's `import ... from "zonedb"` resolves through
// this package's real node_modules symlink to the workspace runtime.
const testDir = path.dirname(fileURLToPath(import.meta.url));

const config: ZoneDbConfig = {
  collection: "movies",
  input: { path: "movies.ndjson" },
  schema: { sortField: "year", fields: { year: { kind: "number" } } },
};

let tmpDir: string | undefined;

afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = undefined;
});

interface FakeResponse {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}

function emptyManifestFetch(seenUrls: string[]): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    seenUrls.push(String(input));
    const body = {
      formatVersion: 0,
      generatorVersion: "0.1.0",
      dataset: { collection: "movies", recordCount: 0, blockCount: 0, sortField: "year" },
      schema: { collection: "movies", sortField: "year", fields: {} },
      blocks: [],
      zonemap: { year: { splitPoints: [] } },
    };
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) } as FakeResponse;
  }) as unknown as typeof fetch;
}

describe("the generated connect() (executed, not just type-checked)", () => {
  test("connect() with no args uses the baked default basePath; both basePath and fetch are overridable", async () => {
    tmpDir = mkdtempSync(path.join(testDir, "tmp-connect-"));
    writeFileSync(path.join(tmpDir, "movies.ndjson"), '{"year":2000}\n');

    const { clientOutDir } = build(config, { baseDir: tmpDir, generatorVersion: "0.1.0", formatVersion: 0 });
    writeFileSync(path.join(clientOutDir, "package.json"), JSON.stringify({ type: "module" }));

    const { connect } = (await import(pathToFileURL(path.join(clientOutDir, "client.ts")).href)) as {
      connect: (opts?: { basePath?: string; fetch?: typeof fetch }) => {
        movies: { findMany: () => Promise<{ records: unknown[]; hasMore: boolean }> };
      };
    };

    const defaultUrls: string[] = [];
    await connect({ fetch: emptyManifestFetch(defaultUrls) }).movies.findMany();
    expect(defaultUrls).toEqual(["/zonedb/manifest.json"]);

    const overriddenUrls: string[] = [];
    await connect({ basePath: "https://cdn.example.com/data", fetch: emptyManifestFetch(overriddenUrls) }).movies.findMany();
    expect(overriddenUrls).toEqual(["https://cdn.example.com/data/manifest.json"]);
  });
});
