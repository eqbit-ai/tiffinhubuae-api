import { prisma } from './prisma';

/**
 * Delivery status is derived, never set directly.
 *
 * A "Lunch + Dinner" customer is one Order row but two physical deliveries, so
 * the truth lives in two columns — `lunch_delivered_at` and
 * `dinner_delivered_at` — and `delivery_status` is a summary of them. Writing
 * the summary by hand is what let an order read "Delivered" with only its lunch
 * stamped.
 *
 * There are now two ways a delivery gets recorded: the merchant tapping a run
 * or a stop on Delivery Management, and a driver marking a drop in the driver
 * app. Both call this, so both produce the same answer.
 */

/** Stamp one run on a set of orders. `at = null` clears it (undo). */
export async function stampRun(orderIds: string[], meal: 'Lunch' | 'Dinner', at: Date | null) {
  if (orderIds.length === 0) return;
  const column = meal === 'Lunch' ? 'lunch_delivered_at' : 'dinner_delivered_at';
  await prisma.order.updateMany({
    where: { id: { in: orderIds } },
    data: { [column]: at } as any,
  });
}

/**
 * Recompute `delivery_status` from the per-run stamps.
 *
 * An order counts as Delivered only once every run its meal_type calls for has
 * been stamped; one of two stamped is still Out for Delivery.
 *
 * $executeRaw (tagged template), not $executeRawUnsafe: callers pass
 * server-derived, tenant-scoped ids, but the tagged form parameterises by
 * construction so no future edit can concatenate user input into this string.
 */
export async function syncDeliveryStatus(orderIds: string[]) {
  if (orderIds.length === 0) return;
  await prisma.$executeRaw`
    UPDATE "Order" SET "delivery_status" = CASE
       WHEN (("meal_type" ILIKE '%lunch%') IS NOT TRUE OR "lunch_delivered_at" IS NOT NULL)
        AND (("meal_type" ILIKE '%dinner%') IS NOT TRUE OR "dinner_delivered_at" IS NOT NULL)
         THEN 'Delivered'
       WHEN "lunch_delivered_at" IS NOT NULL OR "dinner_delivered_at" IS NOT NULL
         THEN 'Out for Delivery'
       ELSE 'Pending'
     END
     WHERE "id" = ANY(${orderIds}::text[])`;
}

/** Which run a delivery belongs to, from a free-text meal_type. Null when it names neither. */
export function runOf(mealType: string | null | undefined): 'Lunch' | 'Dinner' | null {
  const m = (mealType || '').toLowerCase();
  const lunch = m.includes('lunch');
  const dinner = m.includes('dinner');
  // "Lunch + Dinner" on a single drop is ambiguous — the caller must say which
  // run it is rather than have this guess and stamp the wrong one.
  if (lunch && dinner) return null;
  if (lunch) return 'Lunch';
  if (dinner) return 'Dinner';
  return null;
}
