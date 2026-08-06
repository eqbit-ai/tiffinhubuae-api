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

    if (attribute.kind === 'choice') {
      const choices = Array.isArray(attribute.choices) ? (attribute.choices as any[]) : [];
      if (!choices.some((c) => c?.id === value)) {
        return { ok: false, error: `"${String(value)}" is not an option of ${attribute.name}` };
      }
      clean[attributeId] = value;
      continue;
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
      clean[attributeId] = n;
      continue;
    }

    if (attribute.kind === 'toggle') {
      if (typeof value !== 'boolean') return { ok: false, error: `${attribute.name} must be yes or no` };
      clean[attributeId] = value;
      continue;
    }

    return { ok: false, error: `Unsupported attribute type: ${attribute.kind}` };
  }

  return { ok: true, values: clean };
}
