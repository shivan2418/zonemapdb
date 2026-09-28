import { describe, expect, test } from "vitest";
import { createProgressReporter, renderProgressLine } from "../src/progress.js";

/** Minimal write-capturing stand-in for a stdout stream, TTY or not. */
function fakeStdout(isTTY: boolean) {
  const writes: string[] = [];
  return {
    stream: { isTTY, columns: 80, write: (s: string) => (writes.push(s), true) } as unknown as NodeJS.WriteStream,
    writes,
    text: () => writes.join(""),
  };
}

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");

describe("renderProgressLine", () => {
  test("renders a filled bar and percentage for a known total", () => {
    const line = stripAnsi(renderProgressLine({ phase: "reading input", done: 50, total: 100, unit: "count" }));
    expect(line).toContain("reading input");
    expect(line).toContain("50%");
    expect((line.match(/█/g) ?? []).length).toBeGreaterThan(0);
    expect((line.match(/░/g) ?? []).length).toBeGreaterThan(0);
  });

  test("formats byte units human-readably, count units with separators", () => {
    const bytes = stripAnsi(renderProgressLine({ phase: "reading", done: 1_572_864, total: 3_145_728, unit: "bytes" }));
    expect(bytes).toContain("1.5MB");
    expect(bytes).toContain("3.0MB");

    const counts = stripAnsi(renderProgressLine({ phase: "writing", done: 1500, total: 12000, unit: "count" }));
    expect(counts).toContain("1,500");
    expect(counts).toContain("12,000");
  });

  test("pads short labels and truncates long ones so the bar column never shifts", () => {
    const barColumn = (phase: string) => stripAnsi(renderProgressLine({ phase, done: 1, total: 2, unit: "count" })).indexOf("█");
    expect(barColumn("reading input")).toBe(barColumn("writing index files"));
    expect(barColumn("indexing a")).toBe(barColumn("indexing a_very_long_field_name_here"));

    const truncated = stripAnsi(renderProgressLine({ phase: "indexing a_very_long_field_name_here", done: 1, total: 2, unit: "count" }));
    expect(truncated).toContain("…");
  });

  test("a phase with no total shows the label without a bar or a bogus percentage", () => {
    const line = stripAnsi(renderProgressLine({ phase: "sorting" }));
    expect(line).toContain("sorting");
    expect(line).not.toContain("%");
    expect(line).not.toContain("█");
  });

  test("clamps a bar that would overflow, and never renders a negative one", () => {
    const over = stripAnsi(renderProgressLine({ phase: "x", done: 999, total: 100, unit: "count" }));
    expect(over).toContain("100%");
    const under = stripAnsi(renderProgressLine({ phase: "x", done: -5, total: 100, unit: "count" }));
    expect(under).toContain("0%");
    // a zero total can't be a ratio — must not render NaN%
    expect(stripAnsi(renderProgressLine({ phase: "x", done: 0, total: 0, unit: "count" }))).not.toContain("NaN");
  });
});

describe("createProgressReporter — TTY", () => {
  test("rewrites a single line in place rather than scrolling", () => {
    const out = fakeStdout(true);
    const reporter = createProgressReporter(out.stream, { intervalMs: 0 });
    reporter.report({ phase: "reading input", done: 1, total: 10, unit: "count" });
    reporter.report({ phase: "reading input", done: 10, total: 10, unit: "count" });
    reporter.finish();

    expect(out.text()).toContain("\r"); // in-place rewrite
    expect(out.text().split("\n").filter((l) => l.includes("reading input")).length).toBe(1);
  });

  test("throttles mid-phase updates but never drops a phase change or a completed phase", () => {
    const out = fakeStdout(true);
    const reporter = createProgressReporter(out.stream, { intervalMs: 10_000 }); // nothing mid-phase gets through
    reporter.report({ phase: "reading", done: 1, total: 100, unit: "count" });
    reporter.report({ phase: "reading", done: 2, total: 100, unit: "count" }); // throttled away
    reporter.report({ phase: "reading", done: 3, total: 100, unit: "count" }); // throttled away
    reporter.report({ phase: "reading", done: 100, total: 100, unit: "count" }); // completion always renders
    reporter.report({ phase: "sorting" }); // new phase always renders
    reporter.finish();

    const rendered = stripAnsi(out.text());
    expect(rendered).toContain("100%");
    expect(rendered).toContain("sorting");
    expect(rendered).not.toContain("2%");
    expect(rendered).not.toContain("3%");
  });

  test("finish clears the line so later output isn't glued onto a stale bar", () => {
    const out = fakeStdout(true);
    const reporter = createProgressReporter(out.stream, { intervalMs: 0 });
    reporter.report({ phase: "reading", done: 5, total: 10, unit: "count" });
    reporter.finish();
    expect(out.text().endsWith("\r\x1b[2K")).toBe(true);
  });
});

describe("createProgressReporter — non-TTY", () => {
  test("emits one plain line per phase, with no ANSI and no carriage returns", () => {
    const out = fakeStdout(false);
    const reporter = createProgressReporter(out.stream, { intervalMs: 0 });
    reporter.report({ phase: "reading input", done: 1, total: 10, unit: "count" });
    reporter.report({ phase: "reading input", done: 9, total: 10, unit: "count" });
    reporter.report({ phase: "sorting" });
    reporter.finish();

    const text = out.text();
    expect(text).not.toContain("\r");
    expect(text).not.toContain("\x1b[");
    expect(text).not.toContain("█");
    // one line per distinct phase — progress within a phase would just spam a log file
    const lines = text.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("reading input");
    expect(lines[1]).toContain("sorting");
  });
});
