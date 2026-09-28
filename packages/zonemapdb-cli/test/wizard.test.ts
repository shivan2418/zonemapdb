import { describe, expect, test } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  CHUNK_STEPS,
  applyKey,
  buildWizardData,
  createInitialState,
  deriveWizardChoices,
  estimateForState,
  STAGE_LABELS,
  renderFrame,
  type WizardState,
} from "../src/wizard.js";
import { init } from "../src/init.js";

const PRODUCTS = [
  { id: "p1", category: "electronics", price: 100, name: "Widget", description: "a fine widget for widgets" },
  { id: "p2", category: "electronics", price: 200, name: "Gadget", description: "a gadget that gadgets" },
  { id: "p3", category: "books", price: 15, name: "Novel", description: "a novel about novels" },
  { id: "p4", category: "books", price: 20, name: "Textbook", description: "a textbook for textbooks" },
  { id: "p5", category: "toys", price: 30, name: "Blocks", description: "blocks that stack" },
];

describe("buildWizardData", () => {
  test("infers fields, sort candidates, and recommendations via the same inferSchema init uses", () => {
    const data = buildWizardData(PRODUCTS);
    expect(data.recordCount).toBe(5);
    expect(data.fields.map((f) => f.name).sort()).toEqual(
      ["category", "description", "id", "name", "price"].sort(),
    );
    // alphabetical ordering
    expect(data.fields.map((f) => f.name)).toEqual(["category", "description", "id", "name", "price"]);
    // Every always-present, single-valued sortable field is offered — strings included, since
    // locality on the field users search is the whole point of the choice (ADR-0002 §2)...
    expect(data.sortCandidates).toEqual(["category", "description", "id", "name", "price"]);
    // ...but the *recommendation* still prefers number/date, so it can't land on an id-like column.
    expect(data.recommendedSortField).toBe("price");
    expect(data.recommendedPk).toBe("id");
  });

  test("throws on an empty record set", () => {
    expect(() => buildWizardData([])).toThrow(/no records/i);
  });
});

describe("createInitialState", () => {
  test("defaults to the recommended sort field, recommended indexed set, and a chunk-step-snapped block size", () => {
    const data = buildWizardData(PRODUCTS);
    const state = createInitialState(data);
    expect(state.stage).toBe(0);
    expect(state.sortField).toBe(data.recommendedSortField);
    expect([...state.indexedFields].sort()).toEqual([...data.recommendedIndexed].sort());
    expect(CHUNK_STEPS).toContain(state.blockBytes);
    expect(state.endsWithFields.size).toBe(0);
    expect(state.containsFields.size).toBe(0);
  });
});

describe("applyKey — stage navigation", () => {
  test("left/right move between stages and clamp at the ends", () => {
    const data = buildWizardData(PRODUCTS);
    let state = createInitialState(data);
    state = applyKey(data, state, { type: "left" }); // already at 0
    expect(state.stage).toBe(0);
    for (let i = 0; i < 10; i++) state = applyKey(data, state, { type: "right" });
    expect(state.stage).toBe(5); // clamped at the last stage
    for (let i = 0; i < 10; i++) state = applyKey(data, state, { type: "left" });
    expect(state.stage).toBe(0);
  });

  test("enter advances the detect screen", () => {
    const data = buildWizardData(PRODUCTS);
    let state = createInitialState(data);
    state = applyKey(data, state, { type: "enter" });
    expect(state.stage).toBe(1);
  });

  test("cancel sets quit regardless of stage", () => {
    const data = buildWizardData(PRODUCTS);
    const state = createInitialState(data);
    expect(applyKey(data, state, { type: "cancel" }).quit).toBe(true);
  });
});

describe("applyKey — sort field step", () => {
  // Sort field is stage 2 now — the filter step is asked first, so the recommendation can react to it.
  function toStage1(data: ReturnType<typeof buildWizardData>) {
    let state = applyKey(data, createInitialState(data), { type: "right" });
    return applyKey(data, state, { type: "right" });
  }

  test("space selects the field under the cursor and clears it from indexed/endsWith/contains", () => {
    const withRank = PRODUCTS.map((p, i) => ({ ...p, rank: i + 1 }));
    const data = buildWizardData(withRank);
    expect(data.sortCandidates).toContain("rank");
    let state = toStage1(data);
    // pre-seed "rank" into the indexed set to prove picking it as sort field clears it back out
    state = { ...state, indexedFields: new Set([...state.indexedFields, "rank"]) };
    const idx = data.sortCandidates.indexOf("rank");
    for (let i = 0; i < idx; i++) state = applyKey(data, state, { type: "down" });
    state = applyKey(data, state, { type: "space" });
    expect(state.sortField).toBe("rank");
    expect(state.indexedFields.has("rank")).toBe(false);
  });

  test("typing narrows the candidate list (type-to-filter, ADR-0006 §5)", () => {
    const withRank = PRODUCTS.map((p, i) => ({ ...p, rank: i + 1 }));
    const data = buildWizardData(withRank);
    let state = toStage1(data);
    state = applyKey(data, state, { type: "char", value: "r" });
    state = applyKey(data, state, { type: "char", value: "a" });
    expect(state.filterQuery).toBe("ra");
    state = applyKey(data, state, { type: "space" }); // only "rank" matches "ra"
    expect(state.sortField).toBe("rank");
    state = applyKey(data, state, { type: "backspace" });
    expect(state.filterQuery).toBe("r");
  });
});

describe("applyKey — filter fields step", () => {
  function toStage2(data: ReturnType<typeof buildWizardData>) {
    return applyKey(data, createInitialState(data), { type: "right" });
  }

  test("space toggles a field's indexed membership and clears endsWith/contains when turned off", () => {
    const data = buildWizardData(PRODUCTS);
    let state = toStage2(data);
    state = { ...state, endsWithFields: new Set(["category"]), containsFields: new Set(["category"]) };
    const idx = data.fields.filter((f) => f.name !== state.sortField).findIndex((f) => f.name === "category");
    for (let i = 0; i < idx; i++) state = applyKey(data, state, { type: "down" });

    if (!state.indexedFields.has("category")) state = applyKey(data, state, { type: "space" }); // ensure on first
    expect(state.indexedFields.has("category")).toBe(true);
    state = applyKey(data, state, { type: "space" }); // toggle off
    expect(state.indexedFields.has("category")).toBe(false);
    expect(state.endsWithFields.has("category")).toBe(false);
    expect(state.containsFields.has("category")).toBe(false);
  });

  test("every non-payload field is offered, the sort field included — it hasn't been chosen yet", () => {
    const data = buildWizardData(PRODUCTS);
    const state = toStage2(data);
    const selectable = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const s = applyKey(data, { ...state, cursor: i }, { type: "space" });
      for (const name of s.indexedFields) selectable.add(name);
    }
    expect([...selectable].sort()).toEqual(["category", "description", "id", "name", "price"]);
  });

  test("select-all indexes every currently-visible candidate, leaving already-indexed fields' endsWith/contains untouched", () => {
    const data = buildWizardData(PRODUCTS);
    let state = toStage2(data);
    state = { ...state, indexedFields: new Set(["category"]), containsFields: new Set(["category"]) };
    state = applyKey(data, state, { type: "select-all" });
    const visible = data.fields.filter((f) => f.name !== state.sortField).map((f) => f.name);
    for (const name of visible) expect(state.indexedFields.has(name)).toBe(true);
    expect(state.containsFields.has("category")).toBe(true); // untouched, not cleared by select-all
  });

  test("select-all only affects fields matching the active type-to-filter query", () => {
    const data = buildWizardData(PRODUCTS);
    let state = toStage2(data);
    state = applyKey(data, state, { type: "char", value: "o" }); // "category", "novel"-ish... narrow to matches
    state = applyKey(data, state, { type: "select-all" });
    const matching = data.fields.filter((f) => f.name !== state.sortField && f.name.includes("o")).map((f) => f.name);
    const nonMatching = data.fields.filter((f) => f.name !== state.sortField && !f.name.includes("o")).map((f) => f.name);
    expect(matching.length).toBeGreaterThan(0);
    for (const name of matching) expect(state.indexedFields.has(name)).toBe(true);
    for (const name of nonMatching) expect(state.indexedFields.has(name)).toBe(false);
  });

  test("invert flips every currently-visible candidate's indexed membership, clearing endsWith/contains for any turned off", () => {
    const data = buildWizardData(PRODUCTS);
    let state = toStage2(data);
    const visible = data.fields.filter((f) => f.name !== state.sortField).map((f) => f.name);
    const before = new Set(state.indexedFields);
    state = { ...state, endsWithFields: new Set(before.has("category") ? ["category"] : []) };
    state = applyKey(data, state, { type: "invert" });
    for (const name of visible) expect(state.indexedFields.has(name)).toBe(!before.has(name));
    if (before.has("category")) expect(state.endsWithFields.has("category")).toBe(false);

    // inverting twice returns to the original selection
    state = applyKey(data, state, { type: "invert" });
    expect([...state.indexedFields].sort()).toEqual([...before].sort());
  });

  test("the list fills the reported terminal height instead of a fixed page size", () => {
    // Comfortably more candidates than even a tall terminal can show, so "windowed" is testable.
    const wideRecord: Record<string, unknown> = { price: 1 };
    for (let i = 0; i < 80; i++) wideRecord[`field${i}`] = i;
    const data = buildWizardData([wideRecord, { ...wideRecord, price: 2 }, { ...wideRecord, price: 3 }]);
    const state = toStage2(data);
    const estimate = estimateForState(data, state);

    const checklistRowCount = (terminalRows: number) => {
      const rendered = renderFrame(data, state, estimate, undefined, terminalRows);
      return rendered.split("\n").filter((l) => l.includes("[x]") || l.includes("[ ]")).length;
    };

    const shortScreen = checklistRowCount(20);
    const tallScreen = checklistRowCount(60);
    expect(tallScreen).toBeGreaterThan(shortScreen);
    expect(shortScreen).toBeGreaterThanOrEqual(3); // never below the MIN_VISIBLE_ROWS floor
    expect(tallScreen).toBeLessThan(81); // still windowed, not the whole 81-candidate list at once

    // omitting terminalRows falls back to DEFAULT_TERMINAL_ROWS (24) rather than an unbounded list.
    const rendered = renderFrame(data, state, estimate);
    const defaultScreen = rendered.split("\n").filter((l) => l.includes("[x]") || l.includes("[ ]")).length;
    expect(defaultScreen).toBe(checklistRowCount(24));
  });

  test("payload-only json fields are never offered as filterable, and their absence is explained", () => {
    const nested = [
      { id: "p1", price: 100, category: "a", prices: { usd: "1.50" } },
      { id: "p2", price: 200, category: "b", prices: { usd: "2.00" } },
      { id: "p3", price: 300, category: "c", prices: { usd: "3.00" } },
    ];
    const data = buildWizardData(nested);
    expect(data.fields.find((f) => f.name === "prices")!.kind).toBe("json");

    const state = toStage2(data);
    const rendered = renderFrame(data, state, estimateForState(data, state));
    const checklist = rendered.split("\n").filter((l) => l.includes("[x]") || l.includes("[ ]"));
    expect(checklist.some((l) => l.includes("category"))).toBe(true);
    expect(checklist.some((l) => l.includes("prices"))).toBe(false);
    expect(rendered).toContain("not filterable");

    // and it can't be reached by walking the cursor either — the invalid state is unreachable
    for (let i = 0; i < 20; i++) {
      const s = applyKey(data, { ...state, cursor: i }, { type: "space" });
      expect(s.indexedFields.has("prices")).toBe(false);
    }
    // nor by select-all / invert
    expect(applyKey(data, state, { type: "select-all" }).indexedFields.has("prices")).toBe(false);
    expect(applyKey(data, state, { type: "invert" }).indexedFields.has("prices")).toBe(false);
  });

  test("the first-download figure carries a budget meter that fills as the manifest grows", () => {
    const data = buildWizardData(PRODUCTS);
    const state = toStage2(data);
    const base = estimateForState(data, state);

    // The manifest figure is an input to renderFrame, so the meter's whole fill range is drivable
    // without synthesizing a dataset big enough to actually blow the ~1MB budget.
    const meterFor = (gzipBytes: number, overBudget: boolean) => {
      const estimate = { ...base, costs: { ...base.costs, manifest: { bytes: gzipBytes, gzipBytes, overBudget } } };
      const line = renderFrame(data, state, estimate)
        .split("\n")
        .find((l) => l.includes("comfort limit"))!;
      return { filled: (line.match(/█/g) ?? []).length, empty: (line.match(/░/g) ?? []).length, line };
    };

    const empty = meterFor(0, false);
    const half = meterFor(500_000, false);
    const full = meterFor(1_000_000, false);
    const over = meterFor(5_000_000, true);

    expect(empty.filled).toBe(0);
    expect(half.filled).toBeGreaterThan(empty.filled);
    expect(full.filled).toBeGreaterThan(half.filled);
    // every state keeps the meter exactly one fixed width — over-budget clamps rather than overflowing
    for (const m of [empty, half, full, over]) expect(m.filled + m.empty).toBe(18);
    expect(over.filled).toBe(18);
    expect(over.empty).toBe(0);
    // under budget the meter is green, over budget it turns yellow alongside the figure
    expect(full.line).toContain("\x1b[32m");
    expect(over.line).toContain("\x1b[33m");
  });
});

describe("applyKey — text search step", () => {
  function toStage3WithIndexedStrings(data: ReturnType<typeof buildWizardData>): WizardState {
    let state = createInitialState(data);
    state = { ...state, indexedFields: new Set(["category", "name", "description"]) };
    state = applyKey(data, state, { type: "right" });
    state = applyKey(data, state, { type: "right" });
    state = applyKey(data, state, { type: "right" });
    return state;
  }

  test("rows are only string, indexed, non-sort, non-multi fields, one row per operator", () => {
    const data = buildWizardData(PRODUCTS);
    const state = toStage3WithIndexedStrings(data);
    const rendered = renderFrame(data, state, estimateForState(data, state));
    expect(rendered).toContain("category");
    expect(rendered).toContain("ends with");
    expect(rendered).toContain("contains");
    expect(rendered).not.toContain("price"); // sort field excluded
  });

  test("space toggles the operator for the row under the cursor", () => {
    const data = buildWizardData(PRODUCTS);
    let state = toStage3WithIndexedStrings(data);
    state = applyKey(data, state, { type: "space" }); // first row = (first eligible field, endsWith)
    const firstEligible = data.fields
      .filter((f) => f.name !== state.sortField && state.indexedFields.has(f.name) && f.kind === "string" && !f.multi)
      .sort((a, b) => (a.name < b.name ? -1 : 1))[0]!.name;
    expect(state.endsWithFields.has(firstEligible)).toBe(true);
  });

  test("select-all enables both operators on every visible field", () => {
    const data = buildWizardData(PRODUCTS);
    let state = toStage3WithIndexedStrings(data);
    state = applyKey(data, state, { type: "select-all" });
    for (const name of ["category", "name", "description"]) {
      expect(state.endsWithFields.has(name)).toBe(true);
      expect(state.containsFields.has(name)).toBe(true);
    }
    // never leaks onto the sort field or a non-indexed field
    expect(state.endsWithFields.has(state.sortField)).toBe(false);
    expect(state.containsFields.has("id")).toBe(false);
  });

  test("select-all is scoped to the active type-to-filter query", () => {
    const data = buildWizardData(PRODUCTS);
    let state = toStage3WithIndexedStrings(data);
    state = applyKey(data, state, { type: "char", value: "d" }); // matches "description" only
    state = applyKey(data, state, { type: "select-all" });
    expect(state.endsWithFields.has("description")).toBe(true);
    expect(state.containsFields.has("description")).toBe(true);
    expect(state.endsWithFields.has("category")).toBe(false);
    expect(state.containsFields.has("name")).toBe(false);
  });

  test("invert flips each visible row's operator independently, and round-trips", () => {
    const data = buildWizardData(PRODUCTS);
    let state = toStage3WithIndexedStrings(data);
    // seed a mixed starting state: category has endsWith only, name has contains only
    state = { ...state, endsWithFields: new Set(["category"]), containsFields: new Set(["name"]) };

    state = applyKey(data, state, { type: "invert" });
    expect(state.endsWithFields.has("category")).toBe(false); // was on → off
    expect(state.containsFields.has("category")).toBe(true); // was off → on
    expect(state.containsFields.has("name")).toBe(false); // was on → off
    expect(state.endsWithFields.has("name")).toBe(true); // was off → on
    expect(state.endsWithFields.has("description")).toBe(true);
    expect(state.containsFields.has("description")).toBe(true);

    state = applyKey(data, state, { type: "invert" });
    expect([...state.endsWithFields].sort()).toEqual(["category"]);
    expect([...state.containsFields].sort()).toEqual(["name"]);
  });

  test("a `contains` index estimated bigger than its own column surfaces as a warning and renders red", () => {
    // "description" is long free text with high per-value entropy relative to a tiny 5-record sample —
    // its trigram index is expected to dwarf the raw column at this scale.
    const data = buildWizardData(PRODUCTS);
    let state = createInitialState(data);
    state = { ...state, indexedFields: new Set(["description"]), containsFields: new Set(["description"]) };
    const estimate = estimateForState(data, state);
    expect(estimate.costs.indexes.description?.containsExceedsColumn).toBe(true);
    expect(estimate.warnings.some((w) => w.includes("description"))).toBe(true);

    const rendered = renderFrame(data, { ...state, stage: 3 }, estimate);
    expect(rendered).toContain("\x1b[31m"); // red ANSI escape somewhere in the frame
    expect(rendered).toContain("bigger than the data");
  });
});

describe("applyKey — file size step", () => {
  test("up/down move through CHUNK_STEPS and set blockBytes to match", () => {
    const data = buildWizardData(PRODUCTS);
    let state = createInitialState(data);
    for (let i = 0; i < 4; i++) state = applyKey(data, state, { type: "right" });
    expect(state.stage).toBe(4);
    const startCursor = state.cursor;
    state = applyKey(data, state, { type: "down" });
    expect(state.cursor).toBe(Math.min(CHUNK_STEPS.length - 1, startCursor + 1));
    expect(state.blockBytes).toBe(CHUNK_STEPS[state.cursor]);
    state = applyKey(data, state, { type: "up" });
    expect(state.blockBytes).toBe(CHUNK_STEPS[state.cursor]);
  });
});

describe("applyKey — review step", () => {
  function toReview(data: ReturnType<typeof buildWizardData>): WizardState {
    let state = createInitialState(data);
    for (let i = 0; i < 5; i++) state = applyKey(data, state, { type: "right" });
    return state;
  }

  test("space toggles the collapsed JSON preview", () => {
    const data = buildWizardData(PRODUCTS);
    let state = toReview(data);
    expect(state.reviewJsonExpanded).toBe(false);
    state = applyKey(data, state, { type: "space" });
    expect(state.reviewJsonExpanded).toBe(true);
  });

  test("enter marks the state persisted (the wizard's one write trigger)", () => {
    const data = buildWizardData(PRODUCTS);
    const state = applyKey(data, toReview(data), { type: "enter" });
    expect(state.persisted).toBe(true);
  });
});

describe("flag-equivalence (ADR-0006 §1 / T12 acceptance)", () => {
  let tmpDir: string;

  test("wizard-derived choices produce a config identical to init --yes + the equivalent flags", () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "zonemapdb-wizard-"));
    try {
      writeFileSync(path.join(tmpDir, "products.ndjson"), PRODUCTS.map((p) => JSON.stringify(p)).join("\n") + "\n");

      const data = buildWizardData(PRODUCTS);
      let state = createInitialState(data);
      // drive a handful of real interactions: change the indexed set, opt a field into contains,
      // and shrink the block size — then land on review and persist.
      state = applyKey(data, state, { type: "right" }); // -> stage 1 (filter fields)
      state = applyKey(data, state, { type: "right" }); // -> stage 2 (sort field), keep the recommendation
      const nameIdx = data.fields.filter((f) => f.name !== state.sortField).findIndex((f) => f.name === "name");
      for (let i = 0; i < nameIdx; i++) state = applyKey(data, state, { type: "down" });
      state = applyKey(data, state, { type: "space" }); // index "name"
      state = applyKey(data, state, { type: "right" }); // -> stage 3 (text search)
      state = applyKey(data, state, { type: "space" }); // toggle the first row's operator on
      state = applyKey(data, state, { type: "right" }); // -> stage 4 (file size)
      state = applyKey(data, state, { type: "down" }); // bump block size up one step
      state = applyKey(data, state, { type: "right" }); // -> stage 5 (review)
      state = applyKey(data, state, { type: "enter" }); // persist
      expect(state.persisted).toBe(true);

      const choices = deriveWizardChoices(state);

      const wizardConfigPath = path.join(tmpDir, "wizard.config.json");
      const { config: viaWizard } = init({
        cwd: tmpDir,
        configPath: wizardConfigPath,
        yes: true,
        reinfer: true,
        fullScan: true,
        inputPath: "products.ndjson",
        sortField: choices.sortField,
        indexedFields: choices.indexedFields,
        endsWithFields: choices.endsWithFields,
        containsFields: choices.containsFields,
        blockBytes: choices.blockBytes,
      });

      const flagsConfigPath = path.join(tmpDir, "flags.config.json");
      const { config: viaFlags } = init({
        cwd: tmpDir,
        configPath: flagsConfigPath,
        yes: true,
        fullScan: true,
        inputPath: "products.ndjson",
        sortField: choices.sortField,
        indexedFields: choices.indexedFields,
        endsWithFields: choices.endsWithFields,
        containsFields: choices.containsFields,
        blockBytes: choices.blockBytes,
      });

      expect(viaWizard).toEqual(viaFlags);
      expect(existsSync(wizardConfigPath)).toBe(true);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("stage order — what you filter on is asked BEFORE the sort field", () => {
  const FILTER_STAGE = 1;
  const SORT_STAGE = 2;

  function atStage(data: ReturnType<typeof buildWizardData>, stage: number) {
    let state = createInitialState(data);
    for (let i = 0; i < stage; i++) state = applyKey(data, state, { type: "right" });
    return state;
  }

  test("STAGE_LABELS puts Fast filters before Sort field", () => {
    expect(STAGE_LABELS[FILTER_STAGE]).toBe("Fast filters");
    expect(STAGE_LABELS[SORT_STAGE]).toBe("Sort field");
  });

  test("the filter step offers every non-payload field, including sort-field candidates", () => {
    // Nothing is excluded for being "the sort field" yet — the user hasn't been asked.
    const data = buildWizardData(PRODUCTS);
    const rendered = renderFrame(data, atStage(data, FILTER_STAGE), estimateForState(data, atStage(data, FILTER_STAGE)));
    for (const field of ["category", "description", "id", "name", "price"]) {
      expect(rendered).toContain(field);
    }
  });

  /**
   * The field report's shape in miniature, and big enough for locality to be measurable: `region`
   * runs in contiguous runs of `rank`, while `scanned_at` is a bulk-rescan timestamp uncorrelated
   * with everything. 5 records and 2 bins is pure noise — the metric needs repeated values.
   */
  const REGIONS = ["north", "south", "east", "west", "central", "coastal", "inland", "border"];
  const CATALOG = Array.from({ length: 200 }, (_, i) => {
    let x = Math.imul(i + 1, 2654435761) >>> 0;
    x ^= x >>> 15;
    return {
      sku: `sku-${String(i).padStart(4, "0")}`,
      rank: i,
      region: REGIONS[Math.floor(i / 25)]!,
      scanned_at: new Date(Date.UTC(2026, 0, 1 + (x % 900))).toISOString(),
    };
  });

  test("recommends the sort field that measurably clusters what the user filters on", () => {
    // Nothing here keys off field NAMES: `rank` wins because sorting by it puts each region's
    // records together, and `scanned_at` loses because it scatters them across every file.
    const data = buildWizardData(CATALOG);
    expect(data.sortCandidates).toEqual(expect.arrayContaining(["rank", "scanned_at"]));

    let state = atStage(data, FILTER_STAGE);
    state = { ...state, indexedFields: new Set(["region"]) };
    state = applyKey(data, state, { type: "right" });

    expect(state.stage).toBe(SORT_STAGE);
    expect(state.sortField).toBe("rank");

    // and the measurement backs it: sorting by the timestamp reads far more of the data
    const est = estimateForState(data, state);
    expect(est.locality.rank!.mean).toBeLessThan(est.locality.scanned_at!.mean);
  });

  test("prefers a field the user filters on over one they don't, because it clusters itself perfectly", () => {
    const data = buildWizardData(CATALOG);
    let state = atStage(data, FILTER_STAGE);
    // `region` is itself a sort candidate; filtering on it makes sorting by it the cheapest choice
    state = { ...state, indexedFields: new Set(["region"]) };
    state = applyKey(data, state, { type: "right" });
    const est = estimateForState(data, state);
    expect(est.locality.region!.mean).toBeLessThanOrEqual(est.locality.rank!.mean);
  });

  test("ranks on total cost, not on one filter's best case", () => {
    // The regression that shipped once: sorting by S always clusters S perfectly, so ranking on the
    // BEST filter ties every self-clustering candidate at the floor and lets the cardinality tiebreak
    // decide instead. On real Scryfall data that picked `artist` (915 distinct) over `set` (637), even
    // though sorting by `set` left artist queries at 39% while sorting by `artist` pushed set queries
    // to 47%.
    //
    // The asymmetry reproduced here: `city` blocks sit inside `region` blocks, but city LABELS sort in
    // a scrambled order. So ordering by region keeps both contiguous, while ordering by city keeps only
    // city contiguous and interleaves regions. Both still bottom out at the same best case.
    const scramble = (n: number) => {
      let x = Math.imul(n + 1, 2654435761) >>> 0;
      x ^= x >>> 15;
      return `c${(x % 100000).toString().padStart(5, "0")}`;
    };
    const rows = Array.from({ length: 240 }, (_, i) => ({
      // uncorrelated with everything, like a real identifier — otherwise row order IS the best
      // possible sort field and it wins on merit rather than by the bug under test
      id: scramble(i * 7919),
      region: `region-${String(Math.floor(i / 12)).padStart(2, "0")}`,
      city: scramble(Math.floor(i / 4)),
    }));
    const data = buildWizardData(rows);
    let state = atStage(data, FILTER_STAGE);
    // a small byte target so the sample is cut into enough bins for the measurement to have resolution
    state = { ...state, indexedFields: new Set(["region", "city"]), blockBytes: 4096 };
    state = applyKey(data, state, { type: "right" });

    const loc = estimateForState(data, state).locality;
    // both cluster themselves perfectly, so a best-case ranking cannot tell them apart — the trap
    expect(loc.region!.best.scatter).toBeCloseTo(loc.city!.best.scatter, 5);
    // ...but total cost separates them, and that is the key the recommendation follows
    expect(loc.region!.mean).toBeLessThan(loc.city!.mean);
    expect(state.sortField).toBe("region");
  });

  test("between two candidates that partition identically, prefers the one with cheaper split-points", () => {
    // Real shape: `set` and `scryfall_set_uri` on Scryfall are 1:1, so they cluster everything exactly
    // alike — but split-points store the sort field's raw values in the manifest every client
    // downloads, where the codes cost 1.7 KB over 491 blocks and the URLs cost 21.4 KB.
    const rows = Array.from({ length: 240 }, (_, i) => {
      const code = `s${String(Math.floor(i / 12)).padStart(2, "0")}`;
      return { id: `r${String(i).padStart(3, "0")}`, code, code_uri: `https://example.com/api/sets/${code}?utm_source=api` };
    });
    const data = buildWizardData(rows);
    let state = atStage(data, FILTER_STAGE);
    state = { ...state, indexedFields: new Set(["code"]), blockBytes: 4096 };
    state = applyKey(data, state, { type: "right" });

    const loc = estimateForState(data, state).locality;
    expect(loc.code!.mean).toBeCloseTo(loc.code_uri!.mean, 5); // identical partitioning
    expect(state.sortField).toBe("code"); // ...so the tiebreak is what it costs to route on
  });

  test("a fully-unique field carries no locality signal and cannot skew the ranking", () => {
    // Every `sku` occurs once, so it sits in one bin under any ordering — measuring against it would
    // report every candidate as equally good.
    const data = buildWizardData(CATALOG);
    let state = atStage(data, FILTER_STAGE);
    state = { ...state, indexedFields: new Set(["sku"]) };
    state = applyKey(data, state, { type: "right" });
    // no measurable signal -> falls back to the same recommendation `init --yes` would make
    expect(estimateForState(data, state).locality).toEqual({});
    expect(state.sortField).toBe(data.recommendedSortField);
  });

  test("deriveWizardChoices never lists the sort field as a filter field, whatever the click order", () => {
    // Reachable by checking a field at the filter step, then choosing it as sort field, then going
    // back and re-checking it — the config would otherwise carry a redundant indexed: true.
    const data = buildWizardData(PRODUCTS);
    const state = { ...createInitialState(data), sortField: "price", indexedFields: new Set(["price", "name"]) };
    expect(deriveWizardChoices(state).indexedFields).toEqual(["name"]);
  });

  test("warns, with measured numbers, when the sort field scatters what you filter on", () => {
    const data = buildWizardData(CATALOG);
    const scattered = {
      ...createInitialState(data),
      sortField: "scanned_at",
      indexedFields: new Set(["region"]),
      blockBytes: 4096,
    };
    const warning = estimateForState(data, scattered).warnings.join("\n");
    expect(warning).toMatch(/scanned_at/);
    expect(warning).toMatch(/scatters/i);
    expect(warning).toMatch(/\d+% of your data files/);
    // and it names the better alternative it measured
    expect(warning).toMatch(/"rank"|"region"/);

    const clustered = { ...scattered, sortField: "region" };
    expect(estimateForState(data, clustered).warnings.join("\n")).not.toMatch(/scatters/i);
  });

  test("a low-cardinality candidate loses to one that blocks evenly, however well it clusters", () => {
    // `region` clusters perfectly but has 8 values across 200 records, so equal-key runs stay
    // contiguous and it blocks badly (ADR-0002 §6). Locality alone would pick it.
    const data = buildWizardData(CATALOG);
    let state = atStage(data, FILTER_STAGE);
    state = { ...state, indexedFields: new Set(["region", "rank"]) };
    state = applyKey(data, state, { type: "right" });
    expect(state.sortField).toBe("rank");
  });
});

describe("fast filters flag indexes that wouldn't prune (#31)", () => {
  const records = Array.from({ length: 2000 }, (_, id) => ({ id, batch: `b${Math.floor(id / 100)}`, color: `c${id % 10}` }));

  test("a scattered field is marked on its row and warned about once ticked", () => {
    const data = buildWizardData(records);
    const base = applyKey(data, createInitialState(data), { type: "right" }); // the fast-filters stage
    // Small blocks, so the ratio has enough files to mean something.
    const state: WizardState = { ...base, sortField: "id", blockBytes: 4096, indexedFields: new Set(["batch", "color"]) };
    const estimate = estimateForState(data, state);

    expect(estimate.costs.blockCount).toBeGreaterThanOrEqual(8);
    expect(estimate.blockShare.color).toBeGreaterThan(0.9);
    expect(estimate.blockShare.batch).toBeLessThan(0.2);
    expect(estimate.warnings.filter((w) => /index\(color\): this index barely prunes/.test(w))).toHaveLength(1);
    expect(estimate.warnings.some((w) => /index\(batch\)/.test(w))).toBe(false);

    const rows = renderFrame(data, state, estimate).split("\n");
    expect(rows.find((l) => l.includes(" color "))).toMatch(/barely prunes: in ~\d+% of files/);
    expect(rows.find((l) => l.includes(" batch "))).not.toMatch(/barely prunes/);
  });
});
