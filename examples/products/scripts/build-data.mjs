#!/usr/bin/env node
// Runs the real `zonemapdb-cli build()` against the committed config — regenerates
// `public/zonemapdb/` (gitignored, the "deploy this" tree) and `src/zonemapdb/` (committed).
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build, loadConfigFile } from "zonemapdb-cli";

const baseDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function run() {
  const config = loadConfigFile(path.join(baseDir, "zonemapdb.config.json"));
  const result = build(config, { baseDir });
  if (result.warnings.length > 0) {
    for (const w of result.warnings) console.warn(`[build-data] warning: ${w}`);
  }
  console.log(
    `[build-data] built ${result.manifest.dataset.recordCount} records across ${result.manifest.dataset.blockCount} blocks -> ${path.relative(baseDir, result.outputDir)}`,
  );
  return result;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run();
}
