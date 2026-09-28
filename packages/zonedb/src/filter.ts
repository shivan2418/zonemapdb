/** Evaluates one non-null, present value against a single scalar operator (equals/in/gt/.../not). */
function matchesValueOp(value: unknown, op: string, opValue: unknown): boolean {
  switch (op) {
    case "equals":
      return value === opValue;
    case "not":
      return value !== opValue;
    case "in":
      return (opValue as unknown[]).includes(value);
    case "gt":
      return (value as number | string) > (opValue as number | string);
    case "gte":
      return (value as number | string) >= (opValue as number | string);
    case "lt":
      return (value as number | string) < (opValue as number | string);
    case "lte":
      return (value as number | string) <= (opValue as number | string);
    case "startsWith":
      return (value as string).startsWith(opValue as string);
    case "endsWith":
      return (value as string).endsWith(opValue as string);
    case "contains":
      return (value as string).includes(opValue as string);
    default:
      throw new Error(`zonedb: unsupported operator "${op}"`);
  }
}

/** One element against `some`/`every`'s element filter — shorthand value ≡ `{ equals: value }`. */
function matchesElement(element: unknown, elementFilter: unknown): boolean {
  if (typeof elementFilter === "object" && elementFilter !== null) {
    return Object.entries(elementFilter as Record<string, unknown>).every(([op, opValue]) =>
      matchesValueOp(element, op, opValue),
    );
  }
  return element === elementFilter;
}

/**
 * The list operators on a multi-valued field: `some` (T7) plus ADR-0010's `hasEvery`, `every` and
 * `isEmpty`. `undefined` means `op` isn't one of them.
 */
function matchesListOp(values: unknown[], op: string, opValue: unknown): boolean | undefined {
  switch (op) {
    case "some":
      return values.some((element) => matchesElement(element, opValue));
    case "every":
      // Vacuously true for [] — "every colour is W or U" holds for a colourless card.
      return values.every((element) => matchesElement(element, opValue));
    case "hasEvery":
      return (opValue as unknown[]).every((wanted) => values.includes(wanted));
    case "isEmpty":
      return (values.length === 0) === opValue;
    default:
      return undefined;
  }
}

/**
 * Evaluates one field's operator filter against a record (T7): `isNull`/`isAbsent`/`exists`
 * distinguish an explicit `null` from a genuinely missing key; every other operator
 * (including `some` and the `not` rider) requires a present, non-null value.
 */
export function matchesFieldFilter(record: Record<string, unknown>, field: string, filter: Record<string, unknown>): boolean {
  const isAbsent = !(field in record);
  const value = isAbsent ? undefined : record[field];
  const isNull = !isAbsent && value === null;

  for (const [op, opValue] of Object.entries(filter)) {
    if (op === "isNull") {
      if (isNull !== opValue) return false;
      continue;
    }
    if (op === "isAbsent") {
      if (isAbsent !== opValue) return false;
      continue;
    }
    if (op === "exists") {
      const exists = !isAbsent && !isNull;
      if (exists !== opValue) return false;
      continue;
    }
    if (isAbsent || isNull) return false;
    if (Array.isArray(value)) {
      const listMatch = matchesListOp(value, op, opValue);
      if (listMatch === false) return false;
      if (listMatch === true) continue;
    }
    if (!matchesValueOp(value, op, opValue)) return false;
  }
  return true;
}

/** Implicit-AND across every field in `where` (ADR-0001). */
export function matchesWhere(
  record: Record<string, unknown>,
  where: Record<string, Record<string, unknown>> | undefined,
): boolean {
  if (!where) return true;
  for (const [field, filter] of Object.entries(where)) {
    if (!matchesFieldFilter(record, field, filter)) return false;
  }
  return true;
}
