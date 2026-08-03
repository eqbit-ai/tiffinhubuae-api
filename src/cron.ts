import cron from 'node-cron';
import { prisma } from './lib/prisma';
import { runAutoPaymentReminders, runTrialExpiryCheck, runAutoResumePausedCustomers } from './routes/functions';
import { deleteFromCloudinary, extractPublicId } from './lib/cloudinary';
import { stripe } from './services/stripe';

export function startCronJobs() {
  // Run daily at 5 AM UTC - payment reminders & trial expiry
  cron.schedule('0 5 * * *', async () => {
    console.log('[Cron] Running automatic payment reminders...');
    try {
      const result = await runAutoPaymentReminders();
      console.log('[Cron] Payment reminders complete:', result);
    } catch (error) {
      console.error('[Cron] Payment reminders failed:', error);
    }

    console.log('[Cron] Running trial expiry check...');
    try {
      const result = await runTrialExpiryCheck();
      console.log('[Cron] Trial expiry check complete:', result);
    } catch (error) {
      console.error('[Cron] Trial expiry check failed:', error);
    }

    console.log('[Cron] Running merchant trial expiry...');
    try {
      const result = await runMerchantTrialExpiry();
      console.log('[Cron] Merchant trial expiry complete:', result);
    } catch (error) {
      console.error('[Cron] Merchant trial expiry failed:', error);
    }

    console.log('[Cron] Running subscription expiry...');
    try {
      const result = await runSubscriptionExpiry();
      console.log('[Cron] Subscription expiry complete:', result);
    } catch (error) {
      console.error('[Cron] Subscription expiry failed:', error);
    }

    console.log('[Cron] Running customer days maintenance...');
    try {
      const result = await runCustomerDaysMaintenance();
      console.log('[Cron] Customer days maintenance complete:', result);
    } catch (error) {
      console.error('[Cron] Customer days maintenance failed:', error);
    }

    console.log('[Cron] Running inventory deduction...');
    try {
      const result = await runInventoryDeduction();
      console.log('[Cron] Inventory deduction complete:', result);
    } catch (error) {
      console.error('[Cron] Inventory deduction failed:', error);
    }

    console.log('[Cron] Running auto-resume for paused customers...');
    try {
      const result = await runAutoResumePausedCustomers();
      console.log('[Cron] Auto-resume complete:', result);
    } catch (error) {
      console.error('[Cron] Auto-resume failed:', error);
    }
  });

  // Run daily at 10 PM UTC - delivery photo cleanup + location cleanup
  cron.schedule('0 22 * * *', async () => {
    console.log('[Cron] Running delivery photo cleanup...');
    try {
      const result = await runDeliveryPhotoCleanup();
      console.log('[Cron] Photo cleanup complete:', result);
    } catch (error) {
      console.error('[Cron] Photo cleanup failed:', error);
    }
  });

  console.log('Cron jobs started');
}

export async function runDeliveryPhotoCleanup() {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);

  // Clean up delivery photos from Cloudinary
  const items = await prisma.deliveryItem.findMany({
    where: {
      delivery_photo: { not: '' },
      delivered_at: { lt: cutoff },
    },
  });

  let cleaned = 0;
  for (const item of items) {
    if (!item.delivery_photo) continue;

    // Delete from Cloudinary if it's a Cloudinary URL
    if (item.delivery_photo.includes('cloudinary.com')) {
      const publicId = extractPublicId(item.delivery_photo);
      if (publicId) {
        try {
          await deleteFromCloudinary(publicId);
        } catch (err) {
          console.error(`[Photo Cleanup] Failed to delete from Cloudinary ${publicId}:`, err);
        }
      }
    }

    await prisma.deliveryItem.update({
      where: { id: item.id },
      data: { delivery_photo: '' },
    });
    cleaned++;
  }

  // Clean up old driver locations (older than 1 day)
  const locationResult = await prisma.driverLocation.deleteMany({
    where: { created_at: { lt: cutoff } },
  });

  return { photosCleared: cleaned, totalPhotos: items.length, locationsDeleted: locationResult.count };
}

/**
 * Daily customer maintenance.
 *
 * This previously lived in a useEffect on the Dashboard, which meant opening
 * the dashboard issued one PUT per customer (hundreds for a busy merchant,
 * enough to trip the rate limiter), deactivated expired customers, and sent
 * reminder emails — all as a side effect of rendering a page. Viewing a report
 * should not mutate business state, so it runs here once a day instead.
 */
export async function runCustomerDaysMaintenance() {
  const now = new Date();
  const customers = await prisma.customer.findMany({
    where: { is_deleted: false, end_date: { not: null } },
  });

  // Notification is keyed by the merchant's email, while Customer.created_by
  // holds their user id — resolve once rather than per customer.
  const merchants = await prisma.user.findMany({ select: { id: true, email: true } });
  const emailByUserId = new Map(merchants.map((m) => [m.id, m.email]));

  let daysUpdated = 0;
  let deactivated = 0;
  let remindersFlagged = 0;

  for (const customer of customers) {
    if (!customer.end_date) continue;

    // Same calculation the Dashboard used: whole days until end_date.
    const daysRemaining = Math.floor(
      (new Date(customer.end_date).getTime() - now.getTime()) / (1000 * 60 * 60 * 24)
    );

    const data: Record<string, any> = {};

    if (daysRemaining !== customer.days_remaining) {
      data.days_remaining = daysRemaining;
      daysUpdated++;
    }

    if (daysRemaining <= 0 && customer.active) {
      data.active = false;
      deactivated++;
    }

    // Three days out, once per subscription period.
    const merchantEmail = emailByUserId.get(customer.created_by);
    if (daysRemaining === 3 && !customer.notification_sent && merchantEmail) {
      try {
        await prisma.notification.create({
          data: {
            user_email: merchantEmail,
            title: 'Payment Reminder',
            notification_type: 'Payment Reminder',
            message: `Payment reminder: ${customer.full_name}'s subscription expires in 3 days.`,
            customer_id: customer.id,
            customer_name: customer.full_name,
            days_left: 3,
            amount_to_collect: customer.payment_amount,
            phone_number: customer.phone_number,
            is_read: false,
            email_sent: false,
          },
        });
        data.notification_sent = true;
        remindersFlagged++;
      } catch (err) {
        console.error(`[Maintenance] Notification failed for ${customer.id}:`, err);
      }
    }

    if (Object.keys(data).length > 0) {
      await prisma.customer.update({ where: { id: customer.id }, data });
    }
  }

  return { scanned: customers.length, daysUpdated, deactivated, remindersFlagged };
}

/**
 * Expire subscriptions whose paid-for period has actually ended.
 *
 * Nothing enforced this. runMerchantTrialExpiry only ever looked at
 * subscription_status='trial' against trial_ends_at, so an admin grant with a
 * duration never ended — one merchant sat at 'active' five months past their
 * subscription_ends_at, using the product for free.
 *
 * The rule is keyed on whether there is a Stripe subscription to ask about, NOT
 * on subscription_source. One live merchant is source='admin' but carries a real
 * stripe_subscription_id, and trusting the source label there would have cut off
 * someone who is still paying. So:
 *  - any user with a stripe_subscription_id is checked against Stripe, and only
 *    Stripe's own answer expires them. A local date can be stale (a missed
 *    invoice.paid webhook); Stripe cannot.
 *  - everyone else is a manual grant, where the local end date is authoritative.
 *
 * A one-day grace period absorbs clock skew and webhook lag either way.
 */
export async function runSubscriptionExpiry() {
  const GRACE_MS = 24 * 60 * 60 * 1000;
  const cutoff = new Date(Date.now() - GRACE_MS);

  const candidates = await prisma.user.findMany({
    where: {
      subscription_status: { notIn: ['expired', 'cancelled'] },
      is_super_admin: { not: true },
      OR: [
        { subscription_ends_at: { lt: cutoff } },
        { subscription_ends_at: null, current_period_end: { lt: cutoff } },
      ],
    },
  });

  const expire = async (user: (typeof candidates)[number], why: string) => {
    await prisma.user.update({
      where: { id: user.id },
      data: { subscription_status: 'expired', plan_type: 'none', is_paid: false },
    });
    console.log(`[SubscriptionExpiry] expired ${user.email} (${why})`);
  };

  let expired = 0;
  let keptStripeActive = 0;
  let skippedSpecialAccess = 0;

  for (const user of candidates) {
    // Comped accounts are deliberate and have no end date to enforce.
    if (user.special_access_type && user.special_access_type !== 'none') {
      skippedSpecialAccess++;
      continue;
    }

    if (user.stripe_subscription_id) {
      try {
        const sub = await stripe.subscriptions.retrieve(user.stripe_subscription_id);
        if (sub.status === 'active' || sub.status === 'trialing' || sub.status === 'past_due') {
          // Still live at Stripe — our copy of the date was just stale. Repair it
          // rather than cutting off someone who is paying.
          const periodEnd = (sub as any).current_period_end
            ? new Date((sub as any).current_period_end * 1000)
            : null;
          await prisma.user.update({
            where: { id: user.id },
            data: {
              subscription_status: sub.status,
              ...(periodEnd && {
                current_period_end: periodEnd,
                subscription_ends_at: periodEnd,
                next_billing_date: periodEnd,
              }),
            },
          });
          keptStripeActive++;
          continue;
        }
        await expire(user, `stripe status ${sub.status}`);
        expired++;
      } catch (err: any) {
        // Can't reach Stripe or the subscription is gone — leave the account
        // alone rather than locking out a payer on a transient API error.
        console.error(`[SubscriptionExpiry] Stripe lookup failed for ${user.email}:`, err.message);
      }
      continue;
    }

    await expire(user, `${user.subscription_source || 'manual'} grant ended, no Stripe subscription`);
    expired++;
  }

  return { scanned: candidates.length, expired, keptStripeActive, skippedSpecialAccess };
}

export async function runMerchantTrialExpiry() {
  const result = await prisma.user.updateMany({
    where: {
      subscription_status: 'trial',
      trial_ends_at: { lt: new Date() },
    },
    data: {
      subscription_status: 'expired',
      plan_type: 'none',
    },
  });

  return { expired: result.count };
}

/**
 * Daily inventory deduction.
 *
 * Inventory could previously only go up. Two endpoints existed to decrement
 * stock — /functions/batch-cooking and /functions/deduct-inventory — but
 * nothing in the app ever called them, so across 46 merchants there were zero
 * ConsumptionLog rows and Critical Stock, Today's Cost and Total Consumed were
 * permanently zero.
 *
 * Rather than require a recipe per dish (one recipe exists across all
 * merchants), each ingredient carries usage_per_tiffin and this multiplies it
 * by the meal count the app already knows from today's orders.
 */
export async function runInventoryDeduction(dateStr?: string) {
  const day = dateStr || new Date().toISOString().slice(0, 10);

  const tracked = await prisma.ingredient.findMany({
    where: { usage_per_tiffin: { not: null, gt: 0 } },
  });
  if (tracked.length === 0) return { merchants: 0, ingredients: 0, note: 'no ingredients tracked' };

  // Meals, not orders: a "Lunch + Dinner" customer is one order row but two
  // tiffins, and the kitchen cooks for both.
  const orders = await prisma.order.findMany({
    where: { order_date: day },
    select: { created_by: true, meal_type: true },
  });

  const mealsByMerchant = new Map<string, number>();
  for (const o of orders) {
    const mt = (o.meal_type || '').toLowerCase();
    const meals =
      (mt.includes('breakfast') ? 1 : 0) +
      (mt.includes('lunch') ? 1 : 0) +
      (mt.includes('dinner') ? 1 : 0);
    mealsByMerchant.set(o.created_by, (mealsByMerchant.get(o.created_by) || 0) + (meals || 1));
  }

  // Group ingredients per merchant so each merchant gets one consumption entry
  // for the day rather than one per ingredient — ConsumptionLog carries the
  // per-ingredient detail in ingredients_used.
  const byMerchant = new Map<string, typeof tracked>();
  for (const ing of tracked) {
    if (!byMerchant.has(ing.created_by)) byMerchant.set(ing.created_by, []);
    byMerchant.get(ing.created_by)!.push(ing);
  }

  let merchantsDone = 0;
  let ingredientsDeducted = 0;

  for (const [merchantId, ingredients] of byMerchant) {
    const meals = mealsByMerchant.get(merchantId) || 0;
    if (meals === 0) continue;

    // Idempotent: re-running on the same day must not deduct twice.
    const pending = ingredients.filter((i) => i.last_deducted_date !== day);
    if (pending.length === 0) continue;

    const used: any[] = [];
    let totalCost = 0;

    for (const ing of pending) {
      const quantity = (ing.usage_per_tiffin || 0) * meals;
      const newStock = Math.max(0, (ing.current_stock || 0) - quantity);
      const cost = quantity * (ing.cost_per_unit || 0);

      await prisma.ingredient.update({
        where: { id: ing.id },
        data: {
          current_stock: newStock,
          total_value: newStock * (ing.cost_per_unit || 0),
          last_deducted_date: day,
        },
      });

      used.push({
        ingredient_id: ing.id,
        name: ing.name,
        quantity,
        unit: ing.unit,
        cost,
        remaining_stock: newStock,
      });
      totalCost += cost;
      ingredientsDeducted++;
    }

    await prisma.consumptionLog.create({
      data: {
        date: day,
        recipe_name: 'Daily tiffin production',
        quantity_prepared: meals,
        ingredients_used: used,
        total_cost: totalCost,
        cost_per_meal: meals > 0 ? totalCost / meals : 0,
        created_by: merchantId,
      },
    });

    merchantsDone++;
  }

  return { merchants: merchantsDone, ingredients: ingredientsDeducted, date: day };
}
