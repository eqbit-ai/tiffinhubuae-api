import cron from 'node-cron';
import { prisma } from './lib/prisma';
import { runAutoPaymentReminders, runTrialExpiryCheck, runAutoResumePausedCustomers } from './routes/functions';
import { deleteFromCloudinary, extractPublicId } from './lib/cloudinary';

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

    console.log('[Cron] Running customer days maintenance...');
    try {
      const result = await runCustomerDaysMaintenance();
      console.log('[Cron] Customer days maintenance complete:', result);
    } catch (error) {
      console.error('[Cron] Customer days maintenance failed:', error);
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
