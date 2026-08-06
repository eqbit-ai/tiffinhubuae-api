/**
 * Mark every existing merchant as already onboarded.
 *
 *   npx tsx prisma/scripts/backfill-onboarding.ts --dry-run
 *   npx tsx prisma/scripts/backfill-onboarding.ts
 *
 * Onboarding is gated on `onboarding_completed_at` being null. Without this,
 * adding the column would drop all 46 existing merchants — several of them
 * running real kitchens — into a setup wizard for a business they configured
 * long ago. They are stamped with their own `created_at` rather than now, so
 * the column reads as history rather than as something that happened today.
 *
 * Idempotent: only rows where the column is still null are touched, so a
 * merchant who genuinely completes onboarding later keeps their real timestamp.
 */
import { prisma } from '../../src/lib/prisma';

const DRY_RUN = process.argv.includes('--dry-run');

async function main() {
  const pending = await prisma.user.findMany({
    where: { onboarding_completed_at: null },
    select: { id: true, email: true, created_at: true },
    orderBy: { created_at: 'asc' },
  });

  console.log(`${pending.length} user(s) without an onboarding timestamp.`);
  if (pending.length === 0) return;

  for (const u of pending.slice(0, 5)) {
    console.log(`  ${u.email} → ${u.created_at.toISOString().slice(0, 10)}`);
  }
  if (pending.length > 5) console.log(`  … and ${pending.length - 5} more`);

  if (DRY_RUN) {
    console.log('\nDry run — nothing written.');
    return;
  }

  let done = 0;
  for (const u of pending) {
    await prisma.user.update({
      where: { id: u.id },
      data: { onboarding_completed_at: u.created_at },
    });
    done += 1;
  }
  console.log(`\nStamped ${done} existing user(s). They will not see onboarding.`);
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(async () => { await prisma.$disconnect(); });
