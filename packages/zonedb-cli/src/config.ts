import { readFileSync } from "node:fs";
import path from "node:path";
import { NORMALIZERS, isNormalizerName, normalizerNames } from "./normalize.js";
import type { Compression, InputFormat, ResolvedConfig, ZoneDbConfig } from "./types.js";

const DEFAULT_OUTPUT = "public/zonedb";
const DEFAULT_CLIENT_OUT = "src/zonedb";
export const DEFAULT_BLOCK_BYTES = 2_097_152; // 2 MiB
/** ~45 KB gzipped anchor (ADR-0003 §5) — exported so the wizard's live estimates (T12) use the same default `build` would. */
export const DEFAULT_INDEX_CHUNK_BYTES = 45_000;
const INPUT_FORMATS = ["ndjson", "json", "csv", "tsv"] as const;
const COMPRESSIONS = ["none", "gzip", "brotli"] as const;
const TS_IDENTIFIER_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
/**
 * Field kinds a sort field may have (ADR-0002 §2). Exported so `infer`'s candidate predicate and
 * the wizard's candidate list share this exact set rather than keeping second copies that could
 * drift from what `build` accepts.
 */
export const SORTABLE_KINDS = ["number", "date", "string"] as const;
export type SortableKind = (typeof SORTABLE_KINDS)[number];
const DEFAULT_DELIMITERS: Partial<Record<InputFormat, string>> = { csv: ",", tsv: "\t" };

/**
 * Reconciles the modern `compression` field with the original boolean `gzip`. They can disagree only
 * by mistake, so a conflict is an error rather than a silent precedence rule.
 */
function resolveCompression(config: ZoneDbConfig): Compression {
  const { compression, gzip } = config;
  if (compression !== undefined && !COMPRESSIONS.includes(compression)) {
    throw new Error(`zonedb: compression "${compression}" is not one of ${COMPRESSIONS.join(" / ")}`);
  }
  if (compression !== undefined && gzip !== undefined) {
    const implied = gzip ? "gzip" : "none";
    if (implied !== compression) {
      throw new Error(
        `zonedb: config sets compression: "${compression}" and gzip: ${gzip}, which disagree — ` +
          `drop the deprecated "gzip" field and keep "compression".`,
      );
    }
  }
  if (compression !== undefined) return compression;
  return gzip === true ? "gzip" : "none";
}

function defaultBasePath(output: string): string {
  const normalized = output.replace(/\\/g, "/").replace(/^\/+/, "");
  return normalized.startsWith("public/") ? `/${normalized.slice("public/".length)}` : `/${normalized}`;
}

export function resolveConfig(config: ZoneDbConfig, baseDir: string): ResolvedConfig {
  const format = config.input.format ?? "ndjson";
  if (!INPUT_FORMATS.includes(format)) {
    throw new Error(
      `zonedb: unsupported input format "${format}" — supported formats: ${INPUT_FORMATS.join(", ")}`,
    );
  }
  if (config.input.records !== undefined && format !== "json") {
    throw new Error(`zonedb: config.input.records is only valid for format "json", got "${format}"`);
  }
  if (config.input.delimiter !== undefined && format !== "csv" && format !== "tsv") {
    throw new Error(`zonedb: config.input.delimiter is only valid for format "csv"/"tsv", got "${format}"`);
  }
  const delimiter = config.input.delimiter ?? DEFAULT_DELIMITERS[format] ?? ",";

  const sortField = config.schema.sortField;
  const sortFieldConfig = config.schema.fields[sortField];
  if (!sortFieldConfig) {
    throw new Error(`zonedb: config.schema.sortField "${sortField}" is not declared in config.schema.fields`);
  }
  // number | date | string. Strings range-partition lexicographically exactly as dates already do
  // (dates ARE compared as ISO strings), and the sort field is the one field whose locality decides
  // what a query costs — restricting it to number/date would have forced a timestamp on datasets
  // whose real access pattern is a name. `boolean` and `json` stay out: a two-value sort field is a
  // degenerate partition, and a payload field has no order (ADR-0001).
  if (!SORTABLE_KINDS.includes(sortFieldConfig.kind as SortableKind)) {
    throw new Error(
      `zonedb: sortField "${sortField}" must be one of ${SORTABLE_KINDS.join(" / ")}, got "${sortFieldConfig.kind}"`,
    );
  }

  // `endsWith`/`contains` build structures only for non-sort fields (build.ts indexes the secondary
  // set), so declaring them on the sort field used to be silently dropped — the config asked for an
  // operator the generated client would never expose. Say so instead.
  for (const op of ["endsWith", "contains"] as const) {
    if (sortFieldConfig[op]) {
      throw new Error(
        `zonedb: sortField "${sortField}" cannot also declare ${op}: true — the sort field prunes via ` +
          `split-points, not an inverted index, so no ${op} structure is built for it. ` +
          `Sorted string fields get equals/in/startsWith and the range operators for free; for ${op} on ` +
          `"${sortField}", sort by a different field and index this one instead.`,
      );
    }
  }

  // Fields sharing a valuesType must agree on the values, or the shared type would be a lie for one of
  // them. Checked across the whole schema rather than per field, and re-checked on every build, so a
  // data refresh that makes two fields diverge fails loudly instead of silently widening one.
  const sharedValues = new Map<string, { field: string; values: readonly string[] }>();
  for (const [name, field] of Object.entries(config.schema.fields)) {
    if (field.valuesType === undefined || field.values === undefined) continue;
    const seen = sharedValues.get(field.valuesType);
    if (seen === undefined) {
      sharedValues.set(field.valuesType, { field: name, values: field.values });
      continue;
    }
    const a = [...seen.values].sort().join(",");
    const b = [...field.values].sort().join(",");
    if (a !== b) {
      throw new Error(
        `zonedb: fields "${seen.field}" and "${name}" both declare valuesType "${field.valuesType}" but their ` +
          `values differ ([${seen.values.join(", ")}] vs [${field.values.join(", ")}]) — a shared type cannot be ` +
          `correct for both. Give them separate valuesType names, or reconcile the values.`,
      );
    }
  }

  for (const [name, field] of Object.entries(config.schema.fields)) {
    const isSortField = name === sortField;

    if (field.kind === "json" && (field.indexed === true || field.endsWith || field.contains || field.multi || isSortField)) {
      throw new Error(
        `zonedb: field "${name}" is kind "json" (payload-only) — it cannot be indexed, sorted on, or given endsWith/contains/multi. Give it a scalar kind to make it queryable.`,
      );
    }

    if (field.values !== undefined) {
      if (field.kind !== "string") {
        throw new Error(
          `zonedb: field "${name}" declares "values" but is kind "${field.kind}" — a value union requires kind: "string"`,
        );
      }
      // No `indexed` requirement: since ADR-0013 every field is queryable, and a value union narrows
      // the generated types of an unindexed field's filters just the same.
      if (field.values.length === 0) {
        throw new Error(
          `zonedb: field "${name}" declares an empty "values" array — remove it to leave the field typed as plain string`,
        );
      }
      const duplicates = field.values.filter((v, i) => field.values!.indexOf(v) !== i);
      if (duplicates.length > 0) {
        throw new Error(
          `zonedb: field "${name}" declares duplicate "values" entries (${[...new Set(duplicates)].join(", ")}) — each value must appear once`,
        );
      }
    }

    if (field.valuesType !== undefined) {
      if (field.values === undefined) {
        throw new Error(
          `zonedb: field "${name}" declares "valuesType" but has no "values" — there is no union to name`,
        );
      }
      if (!TS_IDENTIFIER_RE.test(field.valuesType)) {
        throw new Error(
          `zonedb: field "${name}" declares valuesType "${field.valuesType}", which is not a valid TypeScript type name`,
        );
      }
    }

    // `tsType` is a codegen-only convenience for payload fields. It is deliberately NOT allowed on
    // scalar kinds: those already have a precise type, and overriding it would desynchronize the
    // record interface from the `where` operators the runtime actually applies to that field.
    if (field.tsType !== undefined) {
      if (field.kind !== "json") {
        throw new Error(
          `zonedb: field "${name}" declares "tsType" but is kind "${field.kind}" — tsType only applies to payload-only "json" fields, whose type would otherwise be "unknown". A scalar field's type already follows its kind.`,
        );
      }
      if (field.tsType.trim() === "") {
        throw new Error(`zonedb: field "${name}" declares an empty "tsType" — remove it to leave the field typed as unknown`);
      }
    }
    if (field.tsImport !== undefined && field.tsType === undefined) {
      throw new Error(
        `zonedb: field "${name}" declares "tsImport" without "tsType" — the import would name a type nothing uses`,
      );
    }

    if (field.derive !== undefined) {
      const { from, using } = field.derive;
      if (!isNormalizerName(using)) {
        throw new Error(
          `zonedb: field "${name}" derives with unknown normalizer "${using}" — available: ${normalizerNames().join(", ")}`,
        );
      }
      if (from === name) {
        throw new Error(
          `zonedb: field "${name}" derives from itself. A derived field is a NEW column computed from an existing one — give it a distinct name (e.g. "${name}_num").`,
        );
      }
      const source = config.schema.fields[from];
      if (source === undefined) {
        throw new Error(
          `zonedb: field "${name}" derives from "${from}", which is not declared in schema.fields — declare the source field, or fix the name`,
        );
      }
      // One pass in config order computes every derived field. Chaining would make that order
      // load-bearing (and admit cycles), for no capability a second explicit field doesn't give.
      if (source.derive !== undefined) {
        throw new Error(
          `zonedb: field "${name}" derives from "${from}", which is itself derived — chaining is not supported. Derive "${name}" from the original source column instead.`,
        );
      }
      const expectedKind = NORMALIZERS[using].outputKind;
      if (field.kind !== expectedKind) {
        throw new Error(
          `zonedb: field "${name}" derives with "${using}", which produces ${expectedKind} values, but declares kind "${field.kind}" — set kind: "${expectedKind}"`,
        );
      }
    }

    if (field.endsWith || field.contains) {
      const opt = field.endsWith ? "endsWith" : "contains";
      if (field.kind !== "string") {
        throw new Error(
          `zonedb: field "${name}" opts into "${opt}" but is kind "${field.kind}" — endsWith/contains require kind: "string"`,
        );
      }
      if (field.indexed !== true) {
        throw new Error(
          `zonedb: field "${name}" opts into "${opt}" but is not indexed — set indexed: true first (ADR-0003 §7)`,
        );
      }
    }

    if (field.multi) {
      if (isSortField) {
        throw new Error(
          `zonedb: field "${name}" opts into "multi" but is the sort field — a multi-valued field cannot be the sort field`,
        );
      }
      if (field.kind !== "string") {
        throw new Error(
          `zonedb: field "${name}" opts into "multi" but is kind "${field.kind}" — multi requires kind: "string" (T7)`,
        );
      }
      if (field.indexed !== true) {
        throw new Error(`zonedb: field "${name}" opts into "multi" but is not indexed — set indexed: true first (T7)`);
      }
    }
  }

  const pk = config.schema.pk;
  if (pk !== undefined) {
    const pkFieldConfig = config.schema.fields[pk];
    if (!pkFieldConfig) {
      throw new Error(`zonedb: config.schema.pk "${pk}" is not declared in config.schema.fields`);
    }
    if (pkFieldConfig.multi) {
      throw new Error(`zonedb: config.schema.pk "${pk}" opts into "multi" — a multi-valued field cannot be a primary key`);
    }
    if (pkFieldConfig.absent) {
      throw new Error(`zonedb: config.schema.pk "${pk}" opts into "absent" — a primary key must always be present`);
    }
    if (pkFieldConfig.nullable) {
      throw new Error(`zonedb: config.schema.pk "${pk}" opts into "nullable" — a primary key can't be null`);
    }
    if (pk !== sortField && pkFieldConfig.indexed !== true) {
      throw new Error(
        `zonedb: config.schema.pk "${pk}" is not the sort field and is not indexed — set indexed: true so get(id) has an index to look it up by (ADR-0003 §10)`,
      );
    }
  }

  const output = config.output ?? DEFAULT_OUTPUT;

  return {
    collection: config.collection,
    inputPath: path.resolve(baseDir, config.input.path),
    inputFormat: format,
    inputDelimiter: delimiter,
    ...(config.input.records !== undefined ? { inputRecordsPath: config.input.records } : {}),
    output: path.resolve(baseDir, output),
    clientOut: path.resolve(baseDir, config.clientOut ?? DEFAULT_CLIENT_OUT),
    basePath: config.basePath ?? defaultBasePath(output),
    blockBytes: config.blockBytes ?? DEFAULT_BLOCK_BYTES,
    compression: resolveCompression(config),
    indexChunkBytes: config.indexChunkBytes ?? DEFAULT_INDEX_CHUNK_BYTES,
    sortField,
    ...(pk !== undefined ? { pk } : {}),
    fields: config.schema.fields,
  };
}

export function loadConfigFile(configPath: string): ZoneDbConfig {
  return JSON.parse(readFileSync(configPath, "utf8")) as ZoneDbConfig;
}
