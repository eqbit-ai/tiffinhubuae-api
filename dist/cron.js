"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.startCronJobs = startCronJobs;
exports.runDeliveryPhotoCleanup = runDeliveryPhotoCleanup;
const node_cron_1 = __importDefault(require("node-cron"));
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const prisma_1 = require("./lib/prisma");
const functions_1 = require("./routes/functions");
function startCronJobs() {
    // Run daily at 9 AM UAE time (5 AM UTC) - payment reminders & trial expiry
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
    });
    // Run daily at 2 AM UAE time (10 PM UTC) - delivery photo cleanup
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
    const uploadsDir = path_1.default.join(__dirname, '../uploads');
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
        // Extract filename from URL
        const filename = item.delivery_photo.split('/uploads/').pop();
        if (filename) {
            const filePath = path_1.default.join(uploadsDir, filename);
            try {
                if (fs_1.default.existsSync(filePath)) {
                    fs_1.default.unlinkSync(filePath);
                }
            }
            catch (err) {
                console.error(`[Photo Cleanup] Failed to delete file ${filePath}:`, err);
            }
        }
        await prisma_1.prisma.deliveryItem.update({
            where: { id: item.id },
            data: { delivery_photo: '' },
        });
        cleaned++;
    }
    return { cleaned, total: items.length };
}
//# sourceMappingURL=cron.js.map