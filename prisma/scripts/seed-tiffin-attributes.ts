/**
 * Seed each merchant's tiffin attributes from the data they already have.
 *
 * Every merchant gets Roti, Rice and Diet pre-created with their own current
 * values, so day one looks identical to today. The choices come from a DISTINCT
 * over that merchant's own customers, never a fixed list — the six live values
 * of rice_type (Basmati, None, Yes, '', Barik, Mota) are proof that a
 * hardcoded assumption would miss something.
 *
 *   npx tsx prisma/scripts/seed-tiffin-attributes.ts --dry-run
 *   npx tsx prisma/scripts/seed-tiffin-attributes.ts --merchant=someone@example.com
 *   npx tsx prisma/scripts/seed-tiffin-attributes.ts            # every merchant
 *
 * Idempotent: re-running updates the existing row for a legacy_field rather than
 * creating a second one (enforced by @@unique([created_by, legacy_field])).
 */
import { prisma } from '../../src/lib/prisma';

type Choice = {
  id: string;
  label: string;
  sort_order: number;
  is_default: boolean;
  group: string;
  diet_match: 'veg' | 'non_veg' | 'either' | null;
  aliases: string[];
  color?: string;
};

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const MERCHANT = args.find((a) => a.startsWith('--merchant='))?.split('=')[1];

/** Stable, readable choice id. Values are keyed by this, never by label. */
const choiceId = (prefix: string, label: string) =>
  `${prefix}_${label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'unset'}`;

/**
 * How a diet label maps onto the veg/non-veg split the kitchen board draws
 * against the day's menu. 'either' and null are explicit so the reducer can
 * partition exhaustively instead of dropping customers into neither bucket.
 */
function dietMatchFor(label: string): Choice['diet_match'] {
  const l = label.toLowerCase();
  if (l.includes('non-veg') || l.includes('non veg')) return 'non_veg';
  if (l === 'both') return 'either';
  if (l.includes('veg')) return 'veg';
  return null;
}

/** Legacy strings that should resolve to this choice. */
function aliasesFor(label: string): string[] {
  const l = label.toLowerCase();
  const out = new Set<string>([label]);
  if (l === 'veg') { out.add('Veg Only'); out.add('Vegetarian'); }
  if (l === 'non-veg') { out.add('Non-Veg Only'); out.add('Non-Vegetarian'); out.add('Non Veg'); }
  return [...out];
}

async function seedMerchant(user: { id: string; email: string }) {
  const customers = await prisma.customer.findMany({
    where: { created_by: user.id, is_deleted: false },
    select: { roti_quantity: true, rice_type: true, dietary_preference: true },
  });

  // ---- Roti: a count ----------------------------------------------------
  const rotiValues = customers.map((c) => c.roti_quantity ?? 0);
  const rotiDefault = rotiValues.length
    ? Number(
        Object.entries(
          rotiValues.reduce<Record<number, number>>((acc, v) => ({ ...acc, [v]: (acc[v] || 0) + 1 }), {})
        ).sort((a, b) => b[1] - a[1])[0][0]
      )
    : 2;

  // ---- Rice: a choice, from this merchant's own values -------------------
  const riceRaw = [...new Set(customers.map((c) => c.rice_type).filter(Boolean) as string[])];
  // 'Yes' and 'No' came from the portal's old boolean toggle. 'No' is None;
  // 'Yes' means rice of unstated type, so it becomes an alias of the merchant's
  // most common real type rather than a choice of its own.
  const realRice = riceRaw.filter((v) => !['yes', 'no', 'none', ''].includes(v.trim().toLowerCase()));
  const commonest = realRice.length
    ? realRice
        .map((v) => [v, customers.filter((c) => c.rice_type === v).length] as const)
        .sort((a, b) => b[1] - a[1])[0][0]
    : null;

  const hasBareYes = riceRaw.some((v) => v.trim().toLowerCase() === 'yes');
  const riceChoices: Choice[] = [
    {
      id: choiceId('rice', 'none'), label: 'No rice', sort_order: 0, is_default: !commonest && !hasBareYes,
      group: 'standard', diet_match: null, aliases: ['None', 'No', ''],
    },
    // Some merchants only ever had the portal's boolean toggle, so 'Yes' is all
    // they have and there is no real type to fold it into. It becomes a choice
    // of its own — rice, type unstated — rather than resolving to nothing.
    ...(hasBareYes && !commonest
      ? [{
          id: choiceId('rice', 'rice'), label: 'Rice', sort_order: 1, is_default: true,
          group: 'standard', diet_match: null as Choice['diet_match'], aliases: ['Yes'],
        }]
      : []),
    ...realRice.map((label, i) => ({
      id: choiceId('rice', label),
      label,
      sort_order: i + (hasBareYes && !commonest ? 2 : 1),
      is_default: label === commonest,
      group: 'standard',
      diet_match: null as Choice['diet_match'],
      aliases: label === commonest ? [label, 'Yes'] : [label],
    })),
  ];

  // ---- Diet: a choice, and the axis the kitchen board splits on ----------
  const dietRaw = [...new Set(customers.map((c) => c.dietary_preference).filter(Boolean) as string[])];
  const dietLabels = dietRaw.length ? dietRaw : ['Veg', 'Non-Veg', 'Both'];
  const dietChoices: Choice[] = dietLabels.map((label, i) => ({
    id: choiceId('diet', label),
    label,
    sort_order: i,
    is_default: label === 'Both',
    // 'Premium' is a tier, not a diet: today it is used as an exclusion filter
    // to give the kitchen its own section. Modelled as a group so the filter
    // becomes data, and a merchant adding "Keto" gets a third section free.
    group: label.toLowerCase() === 'premium' ? 'premium' : 'standard',
    diet_match: label.toLowerCase() === 'premium' ? null : dietMatchFor(label),
    aliases: aliasesFor(label),
  }));

  const specs = [
    {
      legacy_field: 'roti_quantity', name: 'Roti', kind: 'count',
      choices: undefined, default_value: rotiDefault,
      unit: 'pieces', prep_category: 'bread', min_value: 0, max_value: 20,
      sort_order: 0, is_segment_axis: false,
    },
    {
      legacy_field: 'rice_type', name: 'Rice', kind: 'choice',
      choices: riceChoices, default_value: riceChoices.find((c) => c.is_default)?.id ?? null,
      unit: 'portions', prep_category: 'rice', min_value: null, max_value: null,
      sort_order: 1, is_segment_axis: false,
    },
    {
      legacy_field: 'dietary_preference', name: 'Diet', kind: 'choice',
      choices: dietChoices, default_value: dietChoices.find((c) => c.is_default)?.id ?? null,
      unit: null, prep_category: null, min_value: null, max_value: null,
      sort_order: 2, is_segment_axis: true,
    },
  ];

  console.log(`\n${user.email} — ${customers.length} customers`);
  for (const spec of specs) {
    const summary = spec.kind === 'choice'
      ? (spec.choices as Choice[]).map((c) => c.label).join(', ')
      : `default ${spec.default_value}`;
    console.log(`  ${spec.name.padEnd(6)} ${spec.kind.padEnd(7)} ${summary}`);
  }

  // Checked before writing, so --dry-run reports problems rather than hiding them.
  const resolvable = (value: string | null, choices: Choice[]) => {
    if (value === null || value === undefined) return true;
    const v = String(value).trim().toLowerCase();
    return choices.some(
      (c) => c.label.toLowerCase() === v || c.aliases.some((a) => a.toLowerCase() === v)
    );
  };
  let unresolved = 0;
  const seen = new Set<string>();
  for (const c of customers) {
    for (const [field, value, choices] of [
      ['rice_type', c.rice_type, riceChoices],
      ['dietary_preference', c.dietary_preference, dietChoices],
    ] as const) {
      if (!resolvable(value as string | null, choices as Choice[])) {
        const key = `${field}:${value}`;
        if (!seen.has(key)) {
          seen.add(key);
          console.log(`    UNRESOLVED ${field}: ${JSON.stringify(value)}`);
        }
        unresolved++;
      }
    }
  }
  if (unresolved > 0) console.log(`  -> ${unresolved} unresolved value(s)`);

  if (DRY_RUN) return { seeded: 0, unresolved };

  for (const spec of specs) {
    const data = { ...spec, created_by: user.id } as any;
    const existing = await prisma.tiffinAttribute.findFirst({
      where: { created_by: user.id, legacy_field: spec.legacy_field },
    });
    if (existing) {
      await prisma.tiffinAttribute.update({ where: { id: existing.id }, data });
    } else {
      await prisma.tiffinAttribute.create({ data });
    }
  }

  return { seeded: 3, unresolved };
}

async function main() {
  const users = await prisma.user.findMany({
    where: MERCHANT ? { email: MERCHANT } : {},
    select: { id: true, email: true },
    orderBy: { created_at: 'asc' },
  });
  if (users.length === 0) {
    console.error(MERCHANT ? `No user with email ${MERCHANT}` : 'No users found');
    process.exit(1);
  }

  console.log(DRY_RUN ? '=== DRY RUN — nothing will be written ===' : '=== seeding ===');
  let totalUnresolved = 0;
  for (const user of users) {
    const { unresolved } = await seedMerchant(user);
    totalUnresolved += unresolved;
  }

  console.log(`\nDone. ${users.length} merchant(s), ${totalUnresolved} unresolved value(s).`);
  if (totalUnresolved > 0) {
    console.log('Unresolved values must reach zero before a merchant advances to Stage 2.');
  }
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
