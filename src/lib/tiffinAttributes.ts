import { prisma } from './prisma';

/**
 * Validation for `Customer.attribute_values`.
 *
 * The column is a Json blob, so without this any client can write anything into
 * it — which is exactly how `Veg Only` ended up in `dietary_preference`, a value
 * that matched nothing in any kitchen total and made those customers disappear
 * from the board. Three writers reach customer records (the customer form, bulk
 * import, and the customer portal), so the check belongs here rather than in any
 * one of them.
 *
 * Rules, all scoped to the merchant making the request:
 *  - every key must be one of *their own* attribute ids
 *  - a choice value must be one of that attribute's choice ids
 *  - a count must be a number inside min/max
 *  - a toggle must be a boolean
 *  - null clears a value and is always allowed
 *
 * A value is either a bare scalar — the same at every meal, which is every row
 * written before per-meal existed — or `{ default, by_meal }` for an attribute
 * the merchant marked `scope: 'per_meal'`. Each meal's value is checked by the
 * same rules as a scalar, so "rice at lunch" cannot smuggle in an option the
 * merchant does not offer.
 */
export type AttributeValues = Record<string, unknown>;

export async function validateAttributeValues(
  values: unknown,
  merchantId: string
): Promise<{ ok: true; values: AttributeValues } | { ok: false; error: string }> {
  if (values === null || values === undefined) return { ok: true, values: {} };
  if (typeof values !== 'object' || Array.isArray(values)) {
    return { ok: false, error: 'attribute_values must be an object' };
  }

  const entries = Object.entries(values as AttributeValues);
  if (entries.length === 0) return { ok: true, values: {} };

  const attributes = await prisma.tiffinAttribute.findMany({
    where: { created_by: merchantId },
  });
  const byId = new Map(attributes.map((a) => [a.id, a]));

type Attr = { kind: string; name: string; choices: unknown; min_value: number | null; max_value: number | null };

const MEALS = new Set(['lunch', 'dinner', 'breakfast']);

/** One value, by the rules of one attribute. Shared by scalars and each meal. */
function checkOne(attribute: Attr, value: unknown): { ok: true; value: unknown } | { ok: false; error: string } {
  if (attribute.kind === 'choice') {
    const choices = Array.isArray(attribute.choices) ? (attribute.choices as any[]) : [];
    if (!choices.some((c) => c?.id === value)) {
      return { ok: false, error: `"${String(value)}" is not an option of ${attribute.name}` };
    }
    return { ok: true, value };
  }

  if (attribute.kind === 'count') {
    const n = Number(value);
    if (!Number.isFinite(n)) return { ok: false, error: `${attribute.name} must be a number` };
    if (attribute.min_value != null && n < attribute.min_value) {
      return { ok: false, error: `${attribute.name} cannot be below ${attribute.min_value}` };
    }
    if (attribute.max_value != null && n > attribute.max_value) {
      return { ok: false, error: `${attribute.name} cannot be above ${attribute.max_value}` };
    }
    return { ok: true, value: n };
  }

  if (attribute.kind === 'toggle') {
    if (typeof value !== 'boolean') return { ok: false, error: `${attribute.name} must be yes or no` };
    return { ok: true, value };
  }

  return { ok: false, error: `Unsupported attribute type: ${attribute.kind}` };
}

  const clean: AttributeValues = {};
  for (const [attributeId, value] of entries) {
    const attribute = byId.get(attributeId);
    // Covers both a made-up id and another merchant's real id: the lookup is
    // already scoped to the caller, so a foreign id is simply not found.
    if (!attribute) return { ok: false, error: `Unknown tiffin attribute: ${attributeId}` };

    if (value === null || value === undefined) {
      clean[attributeId] = null;
      continue;
    }

    const scoped =
      typeof value === 'object' && !Array.isArray(value) &&
      ('by_meal' in (value as object) || 'default' in (value as object));

    if (!scoped) {
      const r = checkOne(attribute as Attr, value);
      if (!r.ok) return r;
      clean[attributeId] = r.value;
      continue;
    }

    // Per-meal values on an attribute the merchant never marked per_meal would
    // be written but never read — every screen resolves it to `default` — so
    // reject rather than store something inert.
    if (attribute.scope !== 'per_meal') {
      return { ok: false, error: `${attribute.name} is not set up for per-meal values` };
    }

    const v = value as { default?: unknown; by_meal?: Record<string, unknown> };
    const out: { default?: unknown; by_meal?: Record<string, unknown> } = {};

    if (v.default !== undefined && v.default !== null) {
      const r = checkOne(attribute as Attr, v.default);
      if (!r.ok) return r;
      out.default = r.value;
    }

    if (v.by_meal !== undefined && v.by_meal !== null) {
      if (typeof v.by_meal !== 'object' || Array.isArray(v.by_meal)) {
        return { ok: false, error: `${attribute.name}: by_meal must be an object` };
      }
      const meals: Record<string, unknown> = {};
      for (const [meal, mealValue] of Object.entries(v.by_meal)) {
        const key = String(meal).trim().toLowerCase();
        if (!MEALS.has(key)) return { ok: false, error: `Unknown meal: ${meal}` };
        if (mealValue === null || mealValue === undefined) continue;
        const r = checkOne(attribute as Attr, mealValue);
        if (!r.ok) return r;
        meals[key] = r.value;
      }
      if (Object.keys(meals).length) out.by_meal = meals;
    }

    // Nothing left after cleaning is the same as clearing the value.
    clean[attributeId] = Object.keys(out).length ? out : null;
    continue;
  }

  return { ok: true, values: clean };
}
