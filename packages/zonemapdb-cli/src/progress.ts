/**
 * Build/inference progress reporting (hand-rolled ANSI, no dependency — same dep-light rule as the
 * wizard, ADR-0006 §4). The pipeline modules only ever emit plain `ProgressEvent` numbers through an
 * injected callback, so they stay I/O-free and testable; deciding what a terminal sees lives here.
 */

export type ProgressUnit = "bytes" | "count";

export interface ProgressEvent {
  /** Short lower-case phase label, e.g. "reading input", "writing blocks". */
  phase: string;
  /** Work completed so far within this phase. */
  done?: number;
  /** Total work for this phase, when it's known up front — omit for open-ended work. */
  total?: number;
  unit?: ProgressUnit;
}

export type OnProgress = (event: ProgressEvent) => void;

const ESC = "\x1b[";
const CLEAR_LINE = `\r${ESC}2K`;
const DIM = `${ESC}2m`;
const CYAN = `${ESC}36m`;
const RESET = `${ESC}0m`;

const BAR_WIDTH = 24;
const DEFAULT_INTERVAL_MS = 80;
/**
 * Phase labels are padded to this width so the bar starts at the same column every phase. Without
 * it the bar visibly jumps left and right as labels change length, which reads as flicker when the
 * line is being rewritten in place.
 */
const LABEL_WIDTH = 24;

function padLabel(phase: string): string {
  if (phase.length >= LABEL_WIDTH) return `${phase.slice(0, LABEL_WIDTH - 1)}…`;
  return phase + " ".repeat(LABEL_WIDTH - phase.length);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${Math.round(bytes)}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function formatAmount(value: number, unit: ProgressUnit | undefined): string {
  return unit === "bytes" ? formatBytes(value) : Math.round(value).toLocaleString("en-US");
}

/** A total of 0 is not a ratio — treat it as "nothing to do", i.e. complete, never NaN%. */
function fraction(done: number, total: number): number {
  if (total <= 0) return 1;
  return Math.max(0, Math.min(1, done / total));
}

/**
 * One line of progress. Open-ended phases (no `total`) deliberately render no bar and no
 * percentage — a made-up denominator would be a worse lie than admitting the work is unbounded.
 */
export function renderProgressLine(event: ProgressEvent, barWidth: number = BAR_WIDTH): string {
  const label = `${DIM}zonemapdb:${RESET} ${padLabel(event.phase)}`;
  if (event.total === undefined || event.done === undefined) {
    const amount = event.done !== undefined ? `${DIM}${formatAmount(event.done, event.unit)}${RESET} ` : "";
    return `${label} ${amount}${DIM}…${RESET}`;
  }

  const ratio = fraction(event.done, event.total);
  const filled = Math.round(ratio * barWidth);
  const bar = `${CYAN}${"█".repeat(filled)}${RESET}${DIM}${"░".repeat(barWidth - filled)}${RESET}`;
  const pct = `${Math.round(ratio * 100)}%`.padStart(4);
  const counts = `${formatAmount(event.done, event.unit)} / ${formatAmount(event.total, event.unit)}`;
  return `${label} ${bar} ${pct} ${DIM}${counts}${RESET}`;
}

export interface ProgressReporter {
  report: OnProgress;
  /** Leaves the cursor on a clean line so whatever prints next isn't glued onto a stale bar. */
  finish(): void;
}

export interface ProgressReporterOptions {
  /** Minimum gap between mid-phase redraws. Phase changes and completions always render. */
  intervalMs?: number;
  now?: () => number;
}

/**
 * A live single-line bar on a TTY; one plain line per phase otherwise. The non-TTY path matters:
 * rewriting a line with `\r` into a CI log or a pipe produces unreadable noise, while total silence
 * during a multi-minute build looks like a hang — one line per phase is the useful middle.
 */
export function createProgressReporter(
  stdout: NodeJS.WriteStream,
  opts: ProgressReporterOptions = {},
): ProgressReporter {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const now = opts.now ?? Date.now;
  const isTTY = stdout.isTTY === true;

  let lastPhase: string | undefined;
  let lastDrawAt = -Infinity;
  let dirty = false;

  function report(event: ProgressEvent): void {
    const phaseChanged = event.phase !== lastPhase;
    const complete = event.total !== undefined && event.done !== undefined && event.done >= event.total;

    if (!isTTY) {
      // Only the phase itself is worth logging; per-chunk percentages would spam the file.
      if (phaseChanged) {
        stdout.write(`zonemapdb: ${event.phase}\n`);
        lastPhase = event.phase;
      }
      return;
    }

    // Throttle only the mid-phase churn — a new phase or a finished one is always news.
    if (!phaseChanged && !complete && now() - lastDrawAt < intervalMs) return;

    stdout.write(CLEAR_LINE + renderProgressLine(event));
    lastPhase = event.phase;
    lastDrawAt = now();
    dirty = true;
  }

  function finish(): void {
    if (isTTY && dirty) {
      stdout.write(CLEAR_LINE);
      dirty = false;
    }
  }

  return { report, finish };
}
