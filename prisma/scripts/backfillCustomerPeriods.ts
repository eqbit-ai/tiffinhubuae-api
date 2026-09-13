/**
 * Seed CustomerPeriod from the customers that already exist.
 *
 * WHAT THIS CAN AND CANNOT RECOVER
 *
 * A Customer row carries exactly one period: the one it is in right now.
 * Renewing overwrites start_date, end_date and payment_amount in place, so
 * every period before the current one is simply not in the database. No script
 * can bring those back — they were never written down.
 *
 * So each existing customer gets ONE period, at their CURRENT start_date. That
 * is the only period whose dates and amount are real rather than guessed.
 * Writing a second row at created_at as well would double-count the same money
 * whenever a customer signed up and started in the same month, which is most of
 * them.
 *
 * "Customers added in August" does NOT come from this table — it is counted
 * straight off Customer.created_at, which no renewal ever touches and which is
 * therefore complete and exact for live data.
 *
 * Idempotent: reruns skip customers that already have a period at that date.
 *
 *   npx tsx prisma/scripts/backfillCustomerPeriods.ts          # dry run
 *   npx tsx prisma/scripts/backfillCustomerPeriods.ts --write  # apply
 */
import { prisma } from '../../src/lib/prisma';

const WRITE = process.argv.includes('--write');

function utcMidnight(v: any): Date | null {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  if (isNaN(d.getTime())) return null;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/** 'Expired' is a lifecycle state, not a payment one. On a historical row it
 *  means the period finished, which says nothing about whether it was paid —
 *  and the dashboard has always counted Expired customers as revenue. Keep
 *  that reading rather than silently zeroing collected money. */
function statusFor(s: any): string {
  const v = String(s ?? '').trim();
  if (v === 'Expired') return 'Paid';
  if (!v) return 'Pending';
  return v;
}

async function main() {
  const customers = await prisma.customer.findMany({
    where: { is_deleted: false },
    select: {
      id: true, created_by: true, created_at: true, start_date: true, end_date: true,
      paid_days: true, payment_amount: true, payment_status: true, full_name: true,
    },
  });

  let created = 0, skipped = 0, noDate = 0;
  const byMonth = new Map<string, { periods: number; amount: number }>();

  for (const c of customers) {
    // Fall back to created_at only when there is no start_date at all — a
    // period has to begin somewhere to be attributable to a month.
    const start = utcMidnight(c.start_date) ?? utcMidnight(c.created_at);
    if (!start) { noDate++; continue; }

    const existing = await prisma.customerPeriod.findUnique({
      where: { customer_id_start_date: { customer_id: c.id, start_date: start } },
    });
    if (existing) { skipped++; continue; }

    const status = statusFor(c.payment_status);
    const amount = Number(c.payment_amount) || 0;

    if (WRITE) {
      await prisma.customerPeriod.create({
        data: {
          created_by: c.created_by,
          customer_id: c.id,
          start_date: start,
          end_date: utcMidnight(c.end_date),
          paid_days: c.paid_days ?? null,
          amount,
          payment_status: status,
          source: 'backfill',
        },
      });
    }
    created++;

    const key = start.toISOString().slice(0, 7);
    const b = byMonth.get(key) ?? { periods: 0, amount: 0 };
    b.periods++;
    if (status === 'Paid') b.amount += amount;
    byMonth.set(key, b);
  }

  console.log(`\n${WRITE ? 'WROTE' : 'DRY RUN — would write'} ${created} period(s)`);
  console.log(`  already present: ${skipped}   no usable date: ${noDate}   customers: ${customers.length}\n`);
  console.log('month     periods   paid revenue');
  for (const k of [...byMonth.keys()].sort()) {
    const b = byMonth.get(k)!;
    console.log(`${k}   ${String(b.periods).padStart(7)}   ${b.amount.toFixed(2).padStart(12)}`);
  }
  if (!WRITE) console.log('\nNothing was written. Rerun with --write to apply.');
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
