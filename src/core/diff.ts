import { createHash } from "node:crypto";

export interface Change {
  path: string;
  before: unknown;
  after: unknown;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** JSON serialization with sorted object keys, so equal values always hash identically. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value)
      .filter((k) => value[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * Structural diff. Objects are walked into dotted paths; arrays and scalars are compared
 * as whole values. `undefined` and `null` are treated as equal (both mean "unset").
 */
export function diff(before: unknown, after: unknown, prefix = ""): Change[] {
  if (isPlainObject(before) && isPlainObject(after)) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    return [...keys].sort().flatMap((k) => diff(before[k], after[k], prefix ? `${prefix}.${k}` : k));
  }
  if (stableStringify(before) === stableStringify(after)) return [];
  return [{ path: prefix || "(root)", before: before ?? null, after: after ?? null }];
}

export function hash(value: unknown, length = 16): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex").slice(0, length);
}
