import { PrismaClient } from '@prisma/client';
import { readFileSync } from 'node:fs';

/**
 * Confirms the SocialClaim/SocialAtom tables reproduce content/atoms.json
 * exactly.
 *
 * The move from file to database is only safe if it is lossless — a dropped
 * `cta`, a re-ordered headline list or a coerced null would change what gets
 * printed on an image. Cheap to run, so it stays as a check rather than a
 * one-off I ran once and described in a commit message.
 */

const prisma = new PrismaClient();
const SOURCE = process.argv[2] || '/Users/saif/tiffinhub-social/content/atoms.json';

const stable = (o: any) =>
  JSON.stringify(Object.keys(o).sort().reduce((acc: any, k) => ((acc[k] = o[k]), acc), {}));

async function main() {
  const claims = await prisma.socialClaim.findMany({
    where: { is_active: true },
    orderBy: [{ sort_order: 'asc' }],
  });
  const atoms = await prisma.socialAtom.findMany({
    where: { is_active: true },
    orderBy: [{ kind: 'asc' }, { sort_order: 'asc' }],
  });
  const pool = (kind: string) => atoms.filter((a) => a.kind === kind).map((a) => a.text);

  const fromDb = claims.map((c) => ({
    id: c.claim_id,
    layout: c.layout,
    headlines: c.headlines,
    body: c.body,
    ...(c.eyebrow ? { eyebrow: c.eyebrow } : {}),
    ...(c.sub ? { sub: c.sub } : {}),
    ...(c.value ? { value: c.value } : {}),
    ...(c.items ? { items: c.items } : {}),
    ...(c.cta ? { cta: c.cta } : {}),
  }));

  const src = JSON.parse(readFileSync(SOURCE, 'utf8'));

  let mismatches = 0;
  for (const s of src.claims) {
    const d = fromDb.find((x) => x.id === s.id);
    if (!d) {
      console.log(`  MISSING  ${s.id}`);
      mismatches++;
    } else if (stable(d) !== stable(s)) {
      console.log(`  DIFFERS  ${s.id}`);
      mismatches++;
    }
  }

  const pools = [
    ['openers', pool('opener'), src.openers],
    ['closers', pool('closer'), src.closers],
    ['tag_sets', pool('tag_set'), src.tag_sets],
  ] as const;

  console.log(`\n  claims compared: ${src.claims.length}, mismatches: ${mismatches}`);
  for (const [name, got, want] of pools) {
    const same = JSON.stringify(got) === JSON.stringify(want);
    if (!same) mismatches++;
    console.log(`  ${name}: ${same ? 'match' : 'MISMATCH'} (${got.length} vs ${want.length})`);
  }

  const posts = fromDb.reduce((n, c: any) => n + c.headlines.length, 0);
  console.log(`  posts generatable: ${posts}`);
  console.log(mismatches ? '\n  ROUND-TRIP FAILED\n' : '\n  round-trip lossless\n');
  process.exitCode = mismatches ? 1 : 0;
}

main()
  .catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
