import cron from 'node-cron';
import fs from 'fs';
import path from 'path';
import { prisma } from './lib/prisma';
import { runAutoPaymentReminders, runTrialExpiryCheck } from './routes/functions';

export function startCronJobs() {
  // Run daily at 9 AM UAE time (5 AM UTC) - payment reminders & trial expiry
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
  });

  // Run daily at 2 AM UAE time (10 PM UTC) - delivery photo cleanup
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
  const uploadsDir = path.join(__dirname, '../uploads');

  const items = await prisma.deliveryItem.findMany({
    where: {
      delivery_photo: { not: '' },
      delivered_at: { lt: cutoff },
    },
  });

  let cleaned = 0;
  for (const item of items) {
    if (!item.delivery_photo) continue;

    // Extract filename from URL
    const filename = item.delivery_photo.split('/uploads/').pop();
    if (filename) {
      const filePath = path.join(uploadsDir, filename);
      try {
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }
      } catch (err) {
        console.error(`[Photo Cleanup] Failed to delete file ${filePath}:`, err);
      }
    }

    await prisma.deliveryItem.update({
      where: { id: item.id },
      data: { delivery_photo: '' },
    });
    cleaned++;
  }

  return { cleaned, total: items.length };
}
