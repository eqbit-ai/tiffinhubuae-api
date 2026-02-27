import cron from 'node-cron';
import { prisma } from './lib/prisma';
import { runAutoPaymentReminders, runTrialExpiryCheck } from './routes/functions';
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
