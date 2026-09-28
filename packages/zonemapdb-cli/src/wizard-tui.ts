import readline from "node:readline";
import path from "node:path";
import { init, resolveInitConfig, sampleLimit, scanInput, type InitOptions, type InitResult } from "./init.js";
import { countInputRecords, type InputReadOptions, type PopulationStats } from "./input.js";
import type { OnProgress, ProgressReporter } from "./progress.js";
import {
  applyKey,
  createInitialState,
  ESTIMATE_SAMPLE_MAX,
  deriveWizardChoices,
  estimateForState,
  renderFrame,
  type WizardChoices,
  type WizardData,
  type WizardKey,
  type WizardState,
  wizardDataFrom,
} from "./wizard.js";
import type { InputFormat } from "./types.js";

const CLEAR_SCREEN = "\x1b[2J\x1b[H";

type TTYStdin = NodeJS.ReadStream & { setRawMode?: (mode: boolean) => void; isRaw?: boolean };

export interface InteractiveInitOptions
  extends Pick<
    InitOptions,
    "cwd" | "configPath" | "inputPath" | "format" | "delimiter" | "records" | "collection" | "fullScan" | "sampleSize" | "output" | "clientOut" | "basePath" | "indexChunkBytes"
  > {
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
  /**
   * Reports the load phase (read → measure → infer) that runs before the first frame paints. The
   * wizard owns the screen once it starts rendering, so this is finished and cleared at hand-off.
   */
  progress?: ProgressReporter;
}

/**
 * ADR-0006 §4's no-TTY fallback: rather than block forever on keypresses that will never arrive
 * (e.g. `init` run in CI or piped), the wizard fails loud immediately with the same "pass --yes"
 * guidance `init()`'s own non-interactive guard gives.
 */
export function ensureInteractiveTTY(stdin: Pick<NodeJS.ReadStream, "isTTY">): void {
  if (!stdin.isTTY) {
    throw new Error(
      "zonemapdb: init needs an interactive terminal for the wizard — pass --yes plus flags to run non-interactively",
    );
  }
}

function keyFromInput(str: string | undefined, key: readline.Key): WizardKey | undefined {
  if (key?.ctrl && key.name === "c") return { type: "cancel" };
  // Filter-fields step only (ADR-0006 §5 follow-up): ctrl+a/tab, not a bare letter, since bare
  // printable characters are already claimed by type-to-filter — a plain "a" must stay text input.
  if (key?.ctrl && key.name === "a") return { type: "select-all" };
  switch (key?.name) {
    case "up":
      return { type: "up" };
    case "down":
      return { type: "down" };
    case "left":
      return { type: "left" };
    case "right":
      return { type: "right" };
    case "return":
      return { type: "enter" };
    case "backspace":
      return { type: "backspace" };
    case "space":
      return { type: "space" };
    case "tab":
      return { type: "invert" };
  }
  if (str && str.length === 1 && str >= " " && str !== "\x7f") return { type: "char", value: str };
  return undefined;
}

/**
 * Translates the wizard's chosen knobs into the same `InitOptions` shape `init --yes` + flags would
 * receive — the single place that does this, used both for the review step's live preview
 * (`resolveInitConfig`, no write) and for the actual persist (`init`, writes). One call site means
 * there's no second translation that could drift from it.
 */
function toInitOptions(opts: InteractiveInitOptions, choices: WizardChoices): InitOptions {
  return {
    cwd: opts.cwd,
    configPath: opts.configPath,
    yes: true,
    reinfer: true,
    fullScan: opts.fullScan,
    sampleSize: opts.sampleSize,
    collection: opts.collection,
    inputPath: opts.inputPath,
    format: opts.format,
    delimiter: opts.delimiter,
    records: opts.records,
    sortField: choices.sortField,
    indexedFields: choices.indexedFields,
    endsWithFields: choices.endsWithFields,
    containsFields: choices.containsFields,
    output: opts.output,
    clientOut: opts.clientOut,
    basePath: opts.basePath,
    blockBytes: choices.blockBytes,
    indexChunkBytes: opts.indexChunkBytes,
  };
}

/**
 * Everything the wizard needs before its first frame, from the same streaming pass `init --yes` makes
 * (including `sampleLimit`), so the wizard reads exactly the records `init` would and can't drift from
 * what it would have written. Exported for tests.
 */
export function loadWizardData(
  resolvedInput: string,
  readOpts: InputReadOptions,
  limit: number | undefined,
  onProgress?: OnProgress,
): WizardData {
  // A sampled read counts the true totals first (NDJSON streamed, no parse), so the review screen and
  // size estimates reflect the full input, and so does the recommendation's judgement of which indexes
  // prune. A full read measures the dataset on the way.
  const counted: PopulationStats | undefined =
    limit === undefined ? undefined : countInputRecords(resolvedInput, { ...readOpts, ...(onProgress ? { onProgress } : {}) });
  const scan = scanInput(
    resolvedInput,
    { ...readOpts, limit, ...(onProgress ? { onProgress } : {}) },
    { estimateSample: ESTIMATE_SAMPLE_MAX, measureBytes: limit === undefined, ...(counted ? { population: counted } : {}) },
  );
  const population: PopulationStats = counted ?? scan.population;
  const draft: WizardData = wizardDataFrom(scan.inferred, scan.sample, population, scan.pruneSample);
  // The scan judged the default indexes at the default block size; the wizard starts from its own
  // recommended size, so judge them again at that one, or it would pre-tick a field and then flag it.
  const startBlockBytes = createInitialState(draft).blockBytes;
  return { ...draft, recommendedIndexed: scan.recommendFor({ blockBytes: startBlockBytes }).indexedFields };
}

/**
 * The interactive `init` wizard (T12/ADR-0006): a thin terminal driver over `wizard.ts`'s pure state
 * machine. On persist it calls the exact same `init()` core the non-interactive `--yes` path uses —
 * flag-equivalence (ADR-0006 §1) isn't asserted after the fact, it's structural: there is no second
 * config-writing code path for the wizard to drift from.
 */
export function runInteractiveInit(opts: InteractiveInitOptions): Promise<InitResult> {
  const stdin = (opts.stdin ?? process.stdin) as TTYStdin;
  const stdout = opts.stdout ?? process.stdout;
  ensureInteractiveTTY(stdin);

  const inputPath = opts.inputPath;
  if (!inputPath) {
    throw new Error("zonemapdb: init needs an input path/glob — pass it as the positional argument");
  }
  const format: InputFormat = opts.format ?? "ndjson";
  const delimiter = opts.delimiter ?? (format === "tsv" ? "\t" : ",");

  const resolvedInput = path.resolve(opts.cwd, inputPath);
  const readOpts = { format, delimiter, recordsPath: opts.records, fields: {} };
  // All the loading below happens BEFORE the wizard paints its first frame, so it's the one stretch
  // where the user stares at a blank terminal. Report it, then hand the screen over.
  const progress = opts.progress;
  const data = loadWizardData(resolvedInput, readOpts, sampleLimit(opts), progress?.report);
  // Loading done — clear the bar before the TUI takes over the screen.
  progress?.finish();

  let state: WizardState = createInitialState(data);

  return new Promise((resolve, reject) => {
    const wasRaw = stdin.isRaw;

    function cleanup(): void {
      stdin.off("keypress", onKeypress);
      stdin.setRawMode?.(wasRaw ?? false);
      stdin.pause();
      stdout.off("resize", render);
    }

    function render(): void {
      const estimate = estimateForState(data, state);
      let configPreview: string | undefined;
      if (state.stage === 5 && state.reviewJsonExpanded) {
        try {
          const initOptions = toInitOptions(opts, deriveWizardChoices(state));
          configPreview = JSON.stringify(resolveInitConfig(initOptions).config, null, 2);
        } catch (err) {
          configPreview = `(preview unavailable: ${err instanceof Error ? err.message : String(err)})`;
        }
      }
      // Real terminal height, so each step's scrollable list fills the actual screen (ADR-0006 §5)
      // rather than a fixed page size — `stdout.rows` is undefined for a non-TTY stream, in which
      // case `renderFrame` falls back to its own default.
      stdout.write(CLEAR_SCREEN + renderFrame(data, state, estimate, configPreview, stdout.rows));
    }

    function onKeypress(str: string | undefined, key: readline.Key): void {
      const wizardKey = keyFromInput(str, key);
      if (!wizardKey) return;
      state = applyKey(data, state, wizardKey);

      if (state.quit) {
        cleanup();
        reject(new Error("zonemapdb: init wizard cancelled"));
        return;
      }
      if (state.persisted) {
        cleanup();
        try {
          resolve(init(toInitOptions(opts, deriveWizardChoices(state))));
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
        return;
      }
      render();
    }

    readline.emitKeypressEvents(stdin);
    stdin.setRawMode?.(true);
    stdin.on("keypress", onKeypress);
    // Re-layout (not just redraw) on terminal resize, since the list windows are now sized to fit
    // the reported height — a resize can change how many rows are visible.
    stdout.on("resize", render);
    render();
  });
}
