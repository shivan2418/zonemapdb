import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

function readOwnPackageJson(): { version: string } {
  const packageJsonPath = fileURLToPath(new URL("../package.json", import.meta.url));
  return JSON.parse(readFileSync(packageJsonPath, "utf8")) as { version: string };
}

/** The full semver of this build of zonedb-cli, stamped into manifests and generated files. */
export function getGeneratorVersion(): string {
  return readOwnPackageJson().version;
}

/** `formatVersion` = the package major (ADR-0003) — the on-disk/runtime compatibility contract. */
export function getFormatVersion(): number {
  return parseInt(getGeneratorVersion().split(".")[0] ?? "0", 10);
}
