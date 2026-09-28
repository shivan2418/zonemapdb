import type { FieldConfig, FieldKind } from "./types.js";

function expectedTypeof(kind: FieldKind): "string" | "number" | "boolean" {
  return kind === "number" ? "number" : kind === "boolean" ? "boolean" : "string";
}

/** A missing key or `null` the config doesn't allow: where it first appears, and how often. */
interface MissingValueDrift {
  firstRecord: number;
  count: number;
}

const REINFER_HINT =
  `Run "zonemapdb init --reinfer" to refresh these facts from the data (it keeps your sort field, ` +
  `indexed fields and other choices), or edit zonemapdb.config.json by hand.`;

/**
 * `build` replays the baked schema and never re-infers (ADR-0005 §4) — if the data's shape has
 * since changed, that must fail loud rather than silently block/index a mistyped value, or ship a
 * generated type that lies. Checks the kind of every present value, and that a missing key or a
 * `null` only appears where the config says it can (`absent`, `nullable`): those flags are what
 * make the generated record type optional or `| null`.
 *
 * Fed one record at a time (`check`), so `build` can stream its input (#28); `finish` then reports
 * every drifting field in one error, grouped by fix and in config order, so a data refresh that
 * touched many fields costs one rebuild to diagnose rather than one per field.
 */
export class SchemaDriftChecker {
  /** Payload-only fields are opaque — any JSON value is valid, and they're always typed optional. */
  private readonly checked: [string, FieldConfig][];
  private readonly missingKeys = new Map<string, MissingValueDrift>();
  private readonly nulls = new Map<string, MissingValueDrift>();
  /** Only the first kind problem per field: one bad value says what's wrong; a million say nothing more. */
  private readonly kindProblems = new Map<string, string>();
  private recordIndex = 0;

  constructor(private readonly fields: Record<string, FieldConfig>) {
    this.checked = Object.entries(fields).filter(([, field]) => field.kind !== "json");
  }

  check(record: Record<string, unknown>): void {
    const i = this.recordIndex++;
    for (const [name, field] of this.checked) {
      if (!Object.prototype.hasOwnProperty.call(record, name)) {
        if (!field.absent) note(this.missingKeys, name, i);
        continue;
      }
      const value = record[name];
      if (value === null) {
        if (!field.nullable) note(this.nulls, name, i);
        continue;
      }
      if (value === undefined || this.kindProblems.has(name)) continue;

      const problem = kindProblem(name, field, value, i);
      if (problem) this.kindProblems.set(name, problem);
    }
  }

  /** Throws the aggregated drift error, if any record so far drifted. */
  finish(): void {
    const { missingKeys, nulls, kindProblems } = this;
    if (missingKeys.size === 0 && nulls.size === 0 && kindProblems.size === 0) return;

    const sections: string[] = [];
    if (missingKeys.size > 0) {
      sections.push(
        `Some records lack a key the config says is always present. Add "absent": true to:\n` +
          this.describeMissing(missingKeys, "has no key"),
      );
    }
    if (nulls.size > 0) {
      sections.push(
        `Some records hold null where the config says a field is never null. Add "nullable": true to:\n` +
          this.describeMissing(nulls, "is null"),
      );
    }
    if (kindProblems.size > 0) {
      const problems = this.inConfigOrder(kindProblems).map(([, problem]) => `  - ${problem}`);
      sections.push(`Some values no longer match the field's declared kind:\n` + problems.join("\n"));
    }
    throw new Error(`zonemapdb: schema drift — the data no longer matches zonemapdb.config.json.\n\n${sections.join("\n\n")}\n\n${REINFER_HINT}`);
  }

  /** Records meet fields in record order, but the report lists them the way the config does. */
  private inConfigOrder<T>(map: Map<string, T>): [string, T][] {
    return Object.keys(this.fields)
      .filter((name) => map.has(name))
      .map((name) => [name, map.get(name)!]);
  }

  private describeMissing(map: Map<string, MissingValueDrift>, what: string): string {
    return describeMissing(this.inConfigOrder(map), what);
  }
}

function note(map: Map<string, MissingValueDrift>, name: string, record: number): void {
  const seen = map.get(name);
  if (seen) seen.count++;
  else map.set(name, { firstRecord: record, count: 1 });
}

/** `SchemaDriftChecker` over records already in memory. */
export function assertNoSchemaDrift(records: Record<string, unknown>[], fields: Record<string, FieldConfig>): void {
  const checker = new SchemaDriftChecker(fields);
  for (const record of records) checker.check(record);
  checker.finish();
}

function describeMissing(entries: [string, MissingValueDrift][], what: string): string {
  return entries
    .map(([name, { firstRecord, count }]) => `  - "${name}" (${what} in ${count} record${count === 1 ? "" : "s"}, first record ${firstRecord})`)
    .join("\n");
}

/** Why a present, non-null value doesn't fit its field's declared kind, or undefined if it does. */
function kindProblem(name: string, field: FieldConfig, value: unknown, record: number): string | undefined {
  if (field.multi) {
    if (Array.isArray(value) && value.every((v) => typeof v === "string")) return undefined;
    return `"${name}" is declared "multi" (string[]), but record ${record} has ${JSON.stringify(value)}.`;
  }
  if (Array.isArray(value)) {
    return (
      `"${name}" is declared a single ${field.kind}, but record ${record} has an array (${JSON.stringify(value)}). ` +
      `A multi-valued field is either "multi": true (which needs "indexed": true) or, if you don't query it, "kind": "json".`
    );
  }
  if (typeof value === "number" && field.kind === "number" && !Number.isFinite(value)) {
    return `"${name}" is declared kind "number", but record ${record} has ${value}, which JSON can't store (it would be written as null).`;
  }
  if (typeof value === expectedTypeof(field.kind)) return undefined;
  return `"${name}" is declared kind "${field.kind}", but record ${record} has a ${typeof value} value (${JSON.stringify(value)}).`;
}
