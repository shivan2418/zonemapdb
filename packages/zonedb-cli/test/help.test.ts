import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { COMMAND_HELP, GLOBAL_FLAGS, TOP_LEVEL_HELP, isHelpFlag, isVersionFlag } from "../src/help.js";

/**
 * Help text that promises a flag the CLI doesn't parse — or omits one it does — is worse than no
 * help at all, and nothing else would catch the drift. `bin.ts` is the only place flags are read,
 * so comparing its flag literals against the help text keeps the two honest in both directions.
 */
const binSource = readFileSync(new URL("../src/bin.ts", import.meta.url), "utf8");
const FLAG_LITERAL = /"(--[a-z][a-z0-9-]*)"/g;
const FLAG_MENTION = /(--[a-z][a-z0-9-]*)/g;

const parsedFlags = new Set([...binSource.matchAll(FLAG_LITERAL)].map((m) => m[1]!));
const allHelp = [TOP_LEVEL_HELP, ...Object.values(COMMAND_HELP)].join("\n");
const documentedFlags = new Set([...allHelp.matchAll(FLAG_MENTION)].map((m) => m[1]!));

describe("help text", () => {
  test("every flag bin.ts parses is documented somewhere in --help", () => {
    const undocumented = [...parsedFlags].filter((flag) => !documentedFlags.has(flag)).sort();
    expect(undocumented).toEqual([]);
  });

  test("every flag the help text promises is actually parsed by bin.ts", () => {
    const allowed = new Set<string>(GLOBAL_FLAGS); // handled before command dispatch, not as flag literals
    const phantom = [...documentedFlags].filter((flag) => !parsedFlags.has(flag) && !allowed.has(flag)).sort();
    expect(phantom).toEqual([]);
  });

  test("each command has its own help, naming itself and its usage line", () => {
    for (const [command, text] of Object.entries(COMMAND_HELP)) {
      expect(text).toContain(`zonedb ${command}`);
      expect(text).toContain("-h, --help");
    }
  });

  test("top-level help lists every command", () => {
    for (const command of Object.keys(COMMAND_HELP)) {
      expect(TOP_LEVEL_HELP).toMatch(new RegExp(`^\\s+${command}\\b`, "m"));
    }
  });

  test("recognizes both long and short forms", () => {
    expect(["--help", "-h"].every(isHelpFlag)).toBe(true);
    expect(["--version", "-v"].every(isVersionFlag)).toBe(true);
    expect(isHelpFlag("--halp")).toBe(false);
    expect(isVersionFlag(undefined)).toBe(false);
  });
});
