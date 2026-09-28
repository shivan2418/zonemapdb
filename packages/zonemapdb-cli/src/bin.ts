#!/usr/bin/env node
import path from "node:path";
import { build } from "./build.js";
import { formatCliError } from "./cli-error.js";
import { loadConfigFile } from "./config.js";
import { DEFAULT_SAMPLE_SIZE, init } from "./init.js";
import { inspect } from "./inspect.js";
import { runInteractiveInit } from "./wizard-tui.js";
import { COMMAND_HELP, TOP_LEVEL_HELP, isHelpFlag, isVersionFlag } from "./help.js";
import { createProgressReporter, formatBytes } from "./progress.js";
import { getGeneratorVersion } from "./version.js";
import type { InitOptions, InitResult } from "./init.js";
import type { InspectReport } from "./inspect.js";
import type { InputFormat } from "./types.js";

function runBuild(rest: string[]): void {
  let configPath = "zonemapdb.config.json";
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--config") {
      configPath = rest[++i] ?? configPath;
    }
  }

  const resolvedConfigPath = path.resolve(process.cwd(), configPath);
  const config = loadConfigFile(resolvedConfigPath);
  const progress = createProgressReporter(process.stdout);
  let result;
  try {
    result = build(config, { baseDir: path.dirname(resolvedConfigPath), onProgress: progress.report });
  } finally {
    // Also on the throw path — a half-drawn bar left behind would swallow the error message.
    progress.finish();
  }

  console.log(
    `zonemapdb: built ${result.manifest.dataset.blockCount} block(s), ` +
      `${result.manifest.dataset.recordCount} record(s) → ${result.outputDir}`,
  );
  console.log(`zonemapdb: generated client → ${result.clientOutDir}`);
  for (const warning of result.warnings) console.warn(warning);
}

function parseInitArgs(rest: string[]): { configPath: string; options: Omit<InitOptions, "cwd" | "configPath"> } {
  let configPath = "zonemapdb.config.json";
  let inputPath: string | undefined;
  let format: InputFormat | undefined;
  let delimiter: string | undefined;
  let records: string | undefined;
  let collection: string | undefined;
  let sortField: string | undefined;
  let pk: string | undefined;
  let indexedFields: string[] | undefined;
  let endsWithFields: string[] | undefined;
  let containsFields: string[] | undefined;
  let fullScan = false;
  let sampleSize: number | undefined;
  let reinfer = false;
  let yes = false;
  let output: string | undefined;
  let clientOut: string | undefined;
  let basePath: string | undefined;
  let blockBytes: number | undefined;
  let indexChunkBytes: number | undefined;

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    switch (arg) {
      case "--config":
        configPath = rest[++i] ?? configPath;
        break;
      case "--format":
        format = rest[++i] as InputFormat;
        break;
      case "--delimiter":
        delimiter = rest[++i];
        break;
      case "--records":
        records = rest[++i];
        break;
      case "--collection":
        collection = rest[++i];
        break;
      case "--sort-field":
        sortField = rest[++i];
        break;
      case "--pk":
        pk = rest[++i];
        break;
      case "--indexed":
        indexedFields = (rest[++i] ?? "").split(",").filter((s) => s.length > 0);
        break;
      case "--ends-with":
        endsWithFields = (rest[++i] ?? "").split(",").filter((s) => s.length > 0);
        break;
      case "--contains":
        containsFields = (rest[++i] ?? "").split(",").filter((s) => s.length > 0);
        break;
      case "--full-scan":
        fullScan = true;
        break;
      // Inference reads every record by default, so sampling is what needs a flag now. `--sample`
      // takes the default size; `--sample-size N` names one.
      case "--sample":
        sampleSize = DEFAULT_SAMPLE_SIZE;
        break;
      case "--sample-size":
        sampleSize = Number(rest[++i]);
        break;
      case "--reinfer":
        reinfer = true;
        break;
      case "--yes":
        yes = true;
        break;
      case "--output":
        output = rest[++i];
        break;
      case "--client-out":
        clientOut = rest[++i];
        break;
      case "--base-path":
        basePath = rest[++i];
        break;
      case "--block-bytes":
        blockBytes = Number(rest[++i]);
        break;
      case "--index-chunk-bytes":
        indexChunkBytes = Number(rest[++i]);
        break;
      default:
        if (arg !== undefined && !arg.startsWith("--")) inputPath = arg;
    }
  }

  return {
    configPath,
    options: {
      yes,
      reinfer,
      fullScan,
      sampleSize,
      collection,
      inputPath,
      format,
      delimiter,
      records,
      sortField,
      pk,
      indexedFields,
      endsWithFields,
      containsFields,
      output,
      clientOut,
      basePath,
      blockBytes,
      indexChunkBytes,
    },
  };
}

/**
 * `--yes` always runs the non-interactive core directly. Without it, a real TTY launches the
 * interactive wizard (T12); a non-TTY (CI, a pipe) falls back to `init()`'s own "pass --yes" error
 * instead of hanging on keypresses that will never arrive (ADR-0006 §4).
 */
async function runInit(rest: string[]): Promise<void> {
  const { configPath, options } = parseInitArgs(rest);
  const resolvedConfigPath = path.resolve(process.cwd(), configPath);

  const interactive = !options.yes && process.stdin.isTTY;
  // Both paths report: the wizard can't render *over* a bar, but everything before its first frame
  // (read → measure → infer, the whole wait under --full-scan) happens while the screen is still
  // ours, and it hands off by finishing the reporter itself.
  const progress = createProgressReporter(process.stdout);

  let result: InitResult;
  try {
    result = interactive
      ? await runInteractiveInit({ cwd: process.cwd(), configPath: resolvedConfigPath, ...options, progress })
      : init({ cwd: process.cwd(), configPath: resolvedConfigPath, ...options, onProgress: progress.report });
  } finally {
    progress.finish(); // idempotent — a no-op if the wizard already cleared it
  }

  for (const warning of result.warnings) console.warn(warning);
  console.log(
    `zonemapdb: wrote ${result.configPath}` +
      (result.reinferred ? " (schema inferred)" : " (schema unchanged — pass --reinfer to refresh)"),
  );
}

function printInspectReport(report: InspectReport): void {
  console.log(`zonemapdb: inspect (${report.mode}) — ${report.collection}, ${report.recordCount} record(s)`);
  console.log(
    `  blocks: ${report.blocks.count} (min ${formatBytes(report.blocks.minBytes)}, max ${formatBytes(report.blocks.maxBytes)}, ` +
      `mean ${formatBytes(report.blocks.meanBytes)}, total ${formatBytes(report.blocks.totalBytes)})`,
  );
  console.log(
    `  manifest: ${formatBytes(report.manifestBytes)} (gzip ~${formatBytes(report.manifestGzipBytes)})` +
      (report.manifestOverBudget ? " — OVER the ~1MB budget" : " — within the ~1MB budget"),
  );
  const indexNames = Object.keys(report.indexes);
  if (indexNames.length > 0) {
    console.log("  indexes:");
    for (const name of indexNames) {
      const idx = report.indexes[name]!;
      const parts = [`base ${formatBytes(idx.baseBytes)} (${idx.baseChunks} chunk(s))`];
      if (idx.reversedBytes !== undefined) parts.push(`endsWith ${formatBytes(idx.reversedBytes)} (${idx.reversedChunks} chunk(s))`);
      if (idx.trigramBytes !== undefined) parts.push(`contains ${formatBytes(idx.trigramBytes)} (${idx.trigramChunks} chunk(s))`);
      console.log(`    ${name}: ${parts.join(", ")}`);
    }
  }
  console.log("  representative query cost:");
  if (report.perQuery.equality) {
    console.log(`    equality: ${formatBytes(report.perQuery.equality.bytes)} over ${report.perQuery.equality.requests} request(s)`);
  }
  console.log(`    range: ${formatBytes(report.perQuery.range.bytes)} over ${report.perQuery.range.requests} request(s)`);
  for (const warning of report.warnings) console.warn(warning);
}

function runInspect(rest: string[]): void {
  let configPath: string | undefined;
  let dir: string | undefined;
  let json = false;

  for (let i = 0; i < rest.length; i++) {
    switch (rest[i]) {
      case "--config":
        configPath = rest[++i];
        break;
      case "--dir":
        dir = rest[++i];
        break;
      case "--json":
        json = true;
        break;
    }
  }

  const report = inspect({
    ...(configPath !== undefined ? { configPath: path.resolve(process.cwd(), configPath) } : {}),
    ...(dir !== undefined ? { dir: path.resolve(process.cwd(), dir) } : {}),
  });

  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printInspectReport(report);
  }
}

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;

  // Help/version asked for explicitly is the program working: stdout, exit 0. Help shown because
  // the invocation was incomplete or wrong is a usage error: stderr, exit 1.
  if (isVersionFlag(command)) {
    console.log(getGeneratorVersion());
    return;
  }
  if (isHelpFlag(command)) {
    console.log(TOP_LEVEL_HELP);
    return;
  }
  if (command !== undefined && COMMAND_HELP[command] && rest.some(isHelpFlag)) {
    console.log(COMMAND_HELP[command]);
    return;
  }

  if (command === "build") {
    runBuild(rest);
    return;
  }
  if (command === "init") {
    await runInit(rest);
    return;
  }
  if (command === "inspect") {
    runInspect(rest);
    return;
  }

  const problem =
    command === undefined ? "zonemapdb: no command given" : `zonemapdb: unknown command "${command}"`;
  console.error(`${problem}\n\n${TOP_LEVEL_HELP}`);
  process.exitCode = 1;
}

main(process.argv.slice(2)).catch((err: unknown) => {
  console.error(formatCliError(err));
  process.exitCode = 1;
});
