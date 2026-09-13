import { prisma } from './prisma';

/**
 * Writing and correcting CustomerPeriod rows — the ledger the dashboard counts
 * money in. See the model comment in schema.prisma for the attribution rule.
 *
 * The one thing to hold on to: a Customer row describes only the period it is
 * in RIGHT NOW. Everything before it lives here and must never be rewritten by
 * something that happens later, or a month a merchant already read changes
 * underneath them.
 */

type PeriodSource = 'signup' | 'renewal' | 'stripe' | 'backfill';

/** A stored calendar date, normalised the way coerceDates() writes them:
 *  midnight UTC. Keeping the key stable is what makes the (customer, start)
 *  uniqueness — and therefore the idempotent write — actually hold. */
function toUtcMidnight(v: any): Date | null {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  if (isNaN(d.getTime())) return null;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/**
 * What a period's payment_status becomes.
 *
 * Two rules, both there to stop a later event rewriting collected revenue:
 *  - 'Expired' never lands here. A period ending is a lifecycle event; it says
 *    nothing about whether the money arrived, and copying it across would turn
 *    every completed paid period into a non-payment.
 *  - 'Paid' latches. Once a period is marked paid it stays paid, whatever
 *    happens to the customer afterwards — cancelling, expiring or going
 *    Pending on the NEXT period cannot retroactively empty this one.
 */
function periodStatusFor(customerStatus: any, existing?: string): string {
  if (existing === 'Paid') return 'Paid';
  const s = String(customerStatus ?? '').trim();
  if (!s || s === 'Expired') return existing ?? 'Pending';
  return s; // Paid | Pending | Trial | Cancelled
}

/**
 * Bring the ledger in line with a customer row.
 *
 * Addresses exactly one period: the one at the customer's CURRENT start_date.
 * Creates it if this start_date is new (which is what a renewal always is),
 * updates it in place otherwise. Earlier periods are never touched.
 *
 * `previousStartDate` distinguishes the two ways start_date can change:
 *  - a renewal (source 'renewal'/'stripe') genuinely begins a new period, so a
 *    new row is appended and the old one is left exactly as it was;
 *  - anything else is a merchant correcting a typo. That must MOVE the existing
 *    period, not add a second one — otherwise fixing "15 Aug" to "16 Aug"
 *    would count that customer's money in August twice.
 */
export async function syncCustomerPeriod(
  customer: any,
  opts: { source?: PeriodSource; previousStartDate?: any; client?: any } = {}
): Promise<void> {
  const db = opts.client ?? prisma;
  if (!customer?.id || !customer?.created_by) return;

  const start = toUtcMidnight(customer.start_date);
  if (!start) return; // nothing to attribute a month to

  const isRenewal = opts.source === 'renewal' || opts.source === 'stripe';
  const prevStart = toUtcMidnight(opts.previousStartDate);

  const fields = {
    end_date: toUtcMidnight(customer.end_date),
    paid_days: customer.paid_days ?? null,
    amount: Number(customer.payment_amount) || 0,
  };

  // Correction: the period that was at the old date moves to the new one.
  if (!isRenewal && prevStart && prevStart.getTime() !== start.getTime()) {
    const stale = await db.customerPeriod.findUnique({
      where: { customer_id_start_date: { customer_id: customer.id, start_date: prevStart } },
    });
    if (stale) {
      // Only if the destination is free; if a period already exists at the new
      // date the move would collide, so fall through and update that one.
      const clash = await db.customerPeriod.findUnique({
        where: { customer_id_start_date: { customer_id: customer.id, start_date: start } },
      });
      if (!clash) {
        await db.customerPeriod.update({
          where: { id: stale.id },
          data: { ...fields, start_date: start, payment_status: periodStatusFor(customer.payment_status, stale.payment_status) },
        });
        return;
      }
    }
  }

  const existing = await db.customerPeriod.findUnique({
    where: { customer_id_start_date: { customer_id: customer.id, start_date: start } },
  });

  if (existing) {
    await db.customerPeriod.update({
      where: { id: existing.id },
      data: { ...fields, payment_status: periodStatusFor(customer.payment_status, existing.payment_status) },
    });
    return;
  }

  // A first period is a signup; a new start_date on a customer that already has
  // history is a renewal, whether or not the caller said so.
  let source: PeriodSource = opts.source ?? 'signup';
  if (!opts.source) {
    const priorCount = await db.customerPeriod.count({ where: { customer_id: customer.id } });
    source = priorCount > 0 ? 'renewal' : 'signup';
  }

  await db.customerPeriod.create({
    data: {
      created_by: customer.created_by,
      customer_id: customer.id,
      start_date: start,
      ...fields,
      payment_status: periodStatusFor(customer.payment_status),
      source,
    },
  });
}
