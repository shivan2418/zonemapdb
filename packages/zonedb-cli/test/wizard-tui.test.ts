import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { createInitialState, estimateForState } from "../src/wizard.js";
import { ensureInteractiveTTY, loadWizardData, runInteractiveInit } from "../src/wizard-tui.js";

describe("ensureInteractiveTTY (ADR-0006 §4 no-TTY fallback)", () => {
  test("throws a clear, --yes-pointing error when stdin isn't a TTY", () => {
    expect(() => ensureInteractiveTTY({ isTTY: false })).toThrow(/--yes/);
    expect(() => ensureInteractiveTTY({ isTTY: undefined })).toThrow(/--yes/);
  });

  test("does not throw when stdin is a TTY", () => {
    expect(() => ensureInteractiveTTY({ isTTY: true })).not.toThrow();
  });
});

describe("runInteractiveInit", () => {
  test("fails loud synchronously on a non-TTY stdin instead of hanging on keypresses", () => {
    expect(() =>
      runInteractiveInit({
        cwd: "/tmp",
        configPath: "/tmp/zonedb.config.json",
        inputPath: "products.ndjson",
        stdin: { isTTY: false } as unknown as NodeJS.ReadStream,
      }),
    ).toThrow(/--yes/);
  });
});

describe("loadWizardData (#31)", () => {
  test("a sampled read recommends indexes at the wizard's block size and the whole input's size, and flags none of them", () => {
    // ~21 MB: about ten of the wizard's default 2 MB blocks. The first 5,000 records alone would be too
    // few blocks to judge, so color (in every block) would be recommended and then flagged.
    const dir = mkdtempSync(path.join(tmpdir(), "zonedb-wizard-load-"));
    try {
      const pad = "x".repeat(650);
      const lines = Array.from({ length: 30_000 }, (_, id) =>
        JSON.stringify({ id, batch: `b${Math.floor(id / 200)}`, region: `r${Math.floor(id / 400)}`, color: `c${id % 20}`, pad }),
      );
      writeFileSync(path.join(dir, "items.ndjson"), lines.join("\n") + "\n");
      const data = loadWizardData(path.join(dir, "items.ndjson"), { format: "ndjson", delimiter: ",", fields: {} }, 5000);
      expect(data.population.recordCount).toBe(30_000);
      expect(data.recommendedIndexed).not.toContain("color");
      expect(data.recommendedIndexed).toContain("batch");

      const state = createInitialState(data);
      const estimate = estimateForState(data, state);
      expect(estimate.costs.blockCount).toBeGreaterThanOrEqual(8);
      expect(estimate.warnings.filter((w) => /barely prunes/.test(w))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
