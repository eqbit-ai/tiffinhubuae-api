"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.startCronJobs = startCronJobs;
exports.runDeliveryPhotoCleanup = runDeliveryPhotoCleanup;
exports.runMerchantTrialExpiry = runMerchantTrialExpiry;
const node_cron_1 = __importDefault(require("node-cron"));
const prisma_1 = require("./lib/prisma");
const functions_1 = require("./routes/functions");
const cloudinary_1 = require("./lib/cloudinary");
function startCronJobs() {
    // Run daily at 5 AM UTC - payment reminders & trial expiry
    node_cron_1.default.schedule('0 5 * * *', async () => {
        console.log('[Cron] Running automatic payment reminders...');
        try {
            const result = await (0, functions_1.runAutoPaymentReminders)();
            console.log('[Cron] Payment reminders complete:', result);
        }
        catch (error) {
            console.error('[Cron] Payment reminders failed:', error);
        }
        console.log('[Cron] Running trial expiry check...');
        try {
            const result = await (0, functions_1.runTrialExpiryCheck)();
            console.log('[Cron] Trial expiry check complete:', result);
        }
        catch (error) {
            console.error('[Cron] Trial expiry check failed:', error);
        }
        console.log('[Cron] Running merchant trial expiry...');
        try {
            const result = await runMerchantTrialExpiry();
            console.log('[Cron] Merchant trial expiry complete:', result);
        }
        catch (error) {
            console.error('[Cron] Merchant trial expiry failed:', error);
        }
        console.log('[Cron] Running auto-resume for paused customers...');
        try {
            const result = await (0, functions_1.runAutoResumePausedCustomers)();
            console.log('[Cron] Auto-resume complete:', result);
        }
        catch (error) {
            console.error('[Cron] Auto-resume failed:', error);
        }
    });
    // Run daily at 10 PM UTC - delivery photo cleanup + location cleanup
    node_cron_1.default.schedule('0 22 * * *', async () => {
        console.log('[Cron] Running delivery photo cleanup...');
        try {
            const result = await runDeliveryPhotoCleanup();
            console.log('[Cron] Photo cleanup complete:', result);
        }
        catch (error) {
            console.error('[Cron] Photo cleanup failed:', error);
        }
    });
    console.log('Cron jobs started');
}
async function runDeliveryPhotoCleanup() {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
    // Clean up delivery photos from Cloudinary
    const items = await prisma_1.prisma.deliveryItem.findMany({
        where: {
            delivery_photo: { not: '' },
            delivered_at: { lt: cutoff },
        },
    });
    let cleaned = 0;
    for (const item of items) {
        if (!item.delivery_photo)
            continue;
        // Delete from Cloudinary if it's a Cloudinary URL
        if (item.delivery_photo.includes('cloudinary.com')) {
            const publicId = (0, cloudinary_1.extractPublicId)(item.delivery_photo);
            if (publicId) {
                try {
                    await (0, cloudinary_1.deleteFromCloudinary)(publicId);
                }
                catch (err) {
                    console.error(`[Photo Cleanup] Failed to delete from Cloudinary ${publicId}:`, err);
                }
            }
        }
        await prisma_1.prisma.deliveryItem.update({
            where: { id: item.id },
            data: { delivery_photo: '' },
        });
        cleaned++;
    }
    // Clean up old driver locations (older than 1 day)
    const locationResult = await prisma_1.prisma.driverLocation.deleteMany({
        where: { created_at: { lt: cutoff } },
    });
    return { photosCleared: cleaned, totalPhotos: items.length, locationsDeleted: locationResult.count };
}
async function runMerchantTrialExpiry() {
    const result = await prisma_1.prisma.user.updateMany({
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
//# sourceMappingURL=cron.js.map