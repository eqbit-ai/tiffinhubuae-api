import { PrismaClient } from '@prisma/client';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Imports content/atoms.json from the tiffinhub-social repo into SocialClaim
 * and SocialAtom.
 *
 * The claims used to live in a file, with a second copy bundled into the
 * frontend so the browser generator could read them. The two drifted — the app
 * spent a while eleven claims behind — and a claim added in production had
 * nowhere to persist. This is the one-time move to a single source of truth.
 *
 * Idempotent by design: claims match on `claim_id`, atoms on kind+text, so
 * running it twice updates rather than duplicates and it is safe to re-run
 * after adding claims to the file. It never deletes: a claim removed from
 * atoms.json is left alone here rather than being dropped, because posts may
 * already reference it. Retire one by setting `is_active = false`.
 *
 *   npx tsx prisma/scripts/seed-social-claims.ts [path/to/atoms.json]
 */

const prisma = new PrismaClient();

const DEFAULT_SOURCE = '/Users/saif/tiffinhub-social/content/atoms.json';

async function main() {
  const source = process.argv[2] || DEFAULT_SOURCE;
  const atoms = JSON.parse(readFileSync(path.resolve(source), 'utf8'));

  if (!Array.isArray(atoms.claims) || !atoms.claims.length) {
    throw new Error(`No claims found in ${source}`);
  }

  let claimsCreated = 0;
  let claimsUpdated = 0;

  for (const [i, claim] of atoms.claims.entries()) {
    const data = {
      layout: claim.layout,
      headlines: claim.headlines,
      body: claim.body,
      eyebrow: claim.eyebrow ?? null,
      sub: claim.sub ?? null,
      value: claim.value ?? null,
      items: claim.items ?? undefined,
      cta: claim.cta ?? null,
      sort_order: i,
    };

    const existing = await prisma.socialClaim.findUnique({ where: { claim_id: claim.id } });
    if (existing) {
      await prisma.socialClaim.update({ where: { claim_id: claim.id }, data });
      claimsUpdated++;
    } else {
      await prisma.socialClaim.create({ data: { claim_id: claim.id, ...data } });
      claimsCreated++;
    }
  }

  // Openers, closers and tag sets share one table with a `kind` discriminator.
  const pools: Array<[string, string[]]> = [
    ['opener', atoms.openers || []],
    ['closer', atoms.closers || []],
    ['tag_set', atoms.tag_sets || []],
  ];

  let atomsCreated = 0;
  for (const [kind, lines] of pools) {
    for (const [i, text] of lines.entries()) {
      const existing = await prisma.socialAtom.findFirst({ where: { kind, text } });
      if (existing) {
        await prisma.socialAtom.update({ where: { id: existing.id }, data: { sort_order: i } });
      } else {
        await prisma.socialAtom.create({ data: { kind, text, sort_order: i } });
        atomsCreated++;
      }
    }
  }

  const totals = {
    claims: await prisma.socialClaim.count(),
    openers: await prisma.socialAtom.count({ where: { kind: 'opener' } }),
    closers: await prisma.socialAtom.count({ where: { kind: 'closer' } }),
    tag_sets: await prisma.socialAtom.count({ where: { kind: 'tag_set' } }),
  };

  // The number that actually matters: how many distinct posts the pool yields.
  const headlineTotal = (
    await prisma.socialClaim.findMany({ where: { is_active: true }, select: { headlines: true } })
  ).reduce((n, c) => n + (Array.isArray(c.headlines) ? c.headlines.length : 0), 0);

  console.log(`\nFrom ${source}`);
  console.log(`  claims: ${claimsCreated} created, ${claimsUpdated} updated`);
  console.log(`  atoms:  ${atomsCreated} created`);
  console.log(`\nNow in the database:`);
  console.log(`  ${totals.claims} claims, ${totals.openers} openers, ${totals.closers} closers, ${totals.tag_sets} tag sets`);
  console.log(`  → ${headlineTotal} posts generatable\n`);
}

main()
  .catch((err) => {
    console.error(`\n${err.message}\n`);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
