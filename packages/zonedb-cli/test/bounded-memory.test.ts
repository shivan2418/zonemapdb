import { execFileSync } from "node:child_process";
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { ZoneDbConfig, Manifest } from "../src/types.js";

/**
 * #28: `build` streams end to end, so its memory is bounded by one sort run, one block and the index
 * dictionaries — not by the input. Checked the only way that can't be fooled: a real build in a child
 * process whose heap is too small to hold the dataset. A stage that materializes every record dies
 * with "heap out of memory"; the streaming pipeline finishes.
 *
 * Runs the BUILT CLI (`dist/`), like the examples' e2e tests, because the child is plain Node. The
 * pre-streaming build fails this test, so a stale `dist/` fails loudly rather than passing silently.
 */
const cliRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distBuild = path.join(cliRoot, "dist", "build.js");
const distInit = path.join(cliRoot, "dist", "init.js");

/**
 * Locally, a checkout that hasn't run `pnpm build` skips these. CI builds first, so there a missing
 * `dist/` is a broken pipeline and fails instead of skipping without anyone noticing.
 */
const skipWithoutDist = (file: string) => !existsSync(file) && !process.env.CI;

const RECORDS = 150_000;
/** ~36 MB of NDJSON: the pre-streaming build runs out of memory on it at this heap size; the streaming one fits in half. */
const HEAP_MB = 48;

let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), "zonedb-bounded-"));
  const fd = openSync(path.join(tmpDir, "big.ndjson"), "w");
  try {
    const padding = "x".repeat(200);
    let lines: string[] = [];
    for (let i = 0; i < RECORDS; i++) {
      // Written in reverse sort order, so the sort has real work to do across every run.
      lines.push(JSON.stringify({ id: RECORDS - i, group: `g${i % 50}`, note: `${padding}${i}` }));
      if (lines.length === 10_000) {
        writeSync(fd, lines.join("\n") + "\n");
        lines = [];
      }
    }
    if (lines.length > 0) writeSync(fd, lines.join("\n") + "\n");
  } finally {
    closeSync(fd);
  }

  const config: ZoneDbConfig = {
    collection: "big",
    input: { path: "big.ndjson" },
    output: "out",
    clientOut: "client",
    schema: {
      sortField: "id",
      pk: "id",
      fields: {
        id: { kind: "number" },
        group: { kind: "string", indexed: true },
        note: { kind: "string" },
      },
    },
  };
  writeFileSync(path.join(tmpDir, "zonedb.config.json"), JSON.stringify(config));
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("build and init memory (#28, #29)", () => {
  test.skipIf(skipWithoutDist(distBuild))(
    `builds ${RECORDS.toLocaleString("en-US")} records inside a ${HEAP_MB} MB heap`,
    () => {
      const script = `
        import { readFileSync } from "node:fs";
        import { build } from ${JSON.stringify(distBuild)};
        const config = JSON.parse(readFileSync("zonedb.config.json", "utf8"));
        build(config, { baseDir: process.cwd(), sortRunRecords: 5000, tmpDir: process.cwd() });
      `;
      execFileSync(process.execPath, [`--max-old-space-size=${HEAP_MB}`, "--input-type=module", "-e", script], {
        cwd: tmpDir,
        stdio: "pipe",
      });

      const manifest = JSON.parse(readFileSync(path.join(tmpDir, "out", "manifest.json"), "utf8")) as Manifest;
      expect(manifest.dataset.recordCount).toBe(RECORDS);
      expect(manifest.zonemap.id).toMatchObject({ splitPoints: expect.arrayContaining([1, RECORDS]) });
    },
    60_000,
  );

  test.skipIf(skipWithoutDist(distInit))(
    `init infers ${RECORDS.toLocaleString("en-US")} records inside a ${HEAP_MB} MB heap`,
    () => {
      // Inference streams too: it keeps counts per field, never the records (#29).
      const script = `
        import path from "node:path";
        import { init } from ${JSON.stringify(distInit)};
        const { config } = init({ cwd: process.cwd(), configPath: path.resolve("inferred.config.json"), yes: true, inputPath: "big.ndjson" });
        console.log(JSON.stringify(config.schema));
      `;
      const out = execFileSync(process.execPath, [`--max-old-space-size=${HEAP_MB}`, "--input-type=module", "-e", script], {
        cwd: tmpDir,
        stdio: "pipe",
      });

      const schema = JSON.parse(out.toString()) as ZoneDbConfig["schema"];
      expect(schema.pk).toBe("id");
      expect(schema.fields.group).toMatchObject({ kind: "string" });
    },
    60_000,
  );
});
