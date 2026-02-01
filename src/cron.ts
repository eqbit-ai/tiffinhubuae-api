import cron from 'node-cron';
import { runAutoPaymentReminders, runTrialExpiryCheck, runMealRatingRequests } from './routes/functions';

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

  // Run every 15 days at 9 PM UAE time (5 PM UTC) - meal rating requests (1st and 15th)
  cron.schedule('0 17 1,15 * *', async () => {
    console.log('[Cron] Running meal rating requests...');
    try {
      const result = await runMealRatingRequests();
      console.log('[Cron] Meal rating requests complete:', result);
    } catch (error) {
      console.error('[Cron] Meal rating requests failed:', error);
    }
  });

  console.log('Cron jobs started');
}
