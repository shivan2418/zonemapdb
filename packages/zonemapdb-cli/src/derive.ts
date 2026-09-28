import { NORMALIZERS } from "./normalize.js";
import type { FieldConfig } from "./types.js";

type DerivedField = [name: string, field: FieldConfig];

/** The fields a config derives, in config order — computed once per build, then applied per record. */
export function derivedFieldsOf(fields: Record<string, FieldConfig>): DerivedField[] {
  return Object.entries(fields).filter(([, field]) => field.derive !== undefined);
}

/**
 * Computes every `derive`d field onto one record, IN PLACE (ADR-0009).
 *
 * A derived field is an ordinary column by the time anything else sees it: sorting, zonemaps,
 * indexes, drift, codegen and the runtime all treat it exactly like a field that was in the input
 * file. That is the whole point of the design — the alternative (indexing a projection of another
 * field) would have to split "how a value is stored" from "how it is queried" across the manifest,
 * the generated types and the runtime filter.
 *
 * Runs on each record as `materialize` reads it, so `build` and `inspect --config` derive identically.
 *
 * In place because the alternative is copying every record to add one number. `config.ts` forbids
 * deriving from a derived field, so one pass in config order is enough — and it adds the keys in
 * config order, which is what fixes each record's serialized bytes.
 */
export function deriveRecord(record: Record<string, unknown>, derived: DerivedField[]): void {
  for (const [name, field] of derived) {
    const { from, using } = field.derive!;

    if (Object.prototype.hasOwnProperty.call(record, name)) {
      throw new Error(
        `zonemapdb: field "${name}" is declared as derived from "${from}", but the input data already ` +
          `has a "${name}" key. Deriving would overwrite real data — rename the derived field, or drop ` +
          `its "derive" block if the column already exists in the input.`,
      );
    }

    const source = record[from];
    if (source === undefined || source === null) continue;

    const normalizer = NORMALIZERS[using];
    if (Array.isArray(source)) {
      const values = source.map((element) => normalizer.apply(element)).filter((value) => value !== null);
      // No derivable elements is no value at all — same rule as the scalar case, so `absent`
      // means the same thing for multi and single fields.
      if (values.length > 0) record[name] = values;
      continue;
    }

    const value = normalizer.apply(source);
    if (value !== null) record[name] = value;
  }
}

/** `deriveRecord` over many records. */
export function applyDerivedFields(records: Record<string, unknown>[], fields: Record<string, FieldConfig>): void {
  const derived = derivedFieldsOf(fields);
  if (derived.length === 0) return;
  for (const record of records) deriveRecord(record, derived);
}
