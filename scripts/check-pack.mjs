#!/usr/bin/env node
// Pack hygiene gate: fails CI if a package would publish more than its
// intended contents, or if the runtime package has grown a runtime dependency.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packagesDir = path.join(rootDir, "packages");

const ALWAYS_ALLOWED = new Set(["package.json", "LICENSE", "README.md"]);

function packFiles(pkgName, pkgDir) {
  let output;
  try {
    output = execFileSync("pnpm", ["pack", "--dry-run", "--json"], {
      cwd: pkgDir,
      encoding: "utf8",
    });
  } catch (err) {
    console.error(`[pack:check] ${pkgName}: \`pnpm pack --dry-run\` failed:\n${err.message}`);
    process.exit(1);
  }
  const { files } = JSON.parse(output);
  return files.map((f) => f.path);
}

function assertOnlyAllowed(pkgName, files, extraAllowed = []) {
  const allowed = new Set([...ALWAYS_ALLOWED, ...extraAllowed]);
  const violations = files.filter((f) => !f.startsWith("dist/") && !allowed.has(f));
  if (violations.length > 0) {
    console.error(
      `[pack:check] ${pkgName}: unexpected files in published tarball:\n  ${violations.join("\n  ")}`,
    );
    process.exitCode = 1;
  }
}

function assertNoRuntimeDeps(pkgDir, pkgName) {
  const pkg = JSON.parse(readFileSync(path.join(pkgDir, "package.json"), "utf8"));
  const deps = pkg.dependencies ?? {};
  if (Object.keys(deps).length > 0) {
    console.error(
      `[pack:check] ${pkgName}: must have empty dependencies, found ${Object.keys(deps).join(", ")}`,
    );
    process.exitCode = 1;
  }
}

const runtimeDir = path.join(packagesDir, "zonedb");
const cliDir = path.join(packagesDir, "zonedb-cli");

assertOnlyAllowed("zonedb", packFiles("zonedb", runtimeDir));
assertNoRuntimeDeps(runtimeDir, "zonedb");

assertOnlyAllowed("zonedb-cli", packFiles("zonedb-cli", cliDir), ["config.schema.json"]);

if (process.exitCode) {
  process.exit(process.exitCode);
}
console.log("[pack:check] OK — published tarballs are clean.");
