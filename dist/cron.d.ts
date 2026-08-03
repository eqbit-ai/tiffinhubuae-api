export declare function startCronJobs(): void;
export declare function runDeliveryPhotoCleanup(): Promise<{
    photosCleared: number;
    totalPhotos: number;
    locationsDeleted: number;
}>;
/**
 * Daily customer maintenance.
 *
 * This previously lived in a useEffect on the Dashboard, which meant opening
 * the dashboard issued one PUT per customer (hundreds for a busy merchant,
 * enough to trip the rate limiter), deactivated expired customers, and sent
 * reminder emails — all as a side effect of rendering a page. Viewing a report
 * should not mutate business state, so it runs here once a day instead.
 */
export declare function runCustomerDaysMaintenance(): Promise<{
    scanned: number;
    daysUpdated: number;
    deactivated: number;
    remindersFlagged: number;
}>;
export declare function runMerchantTrialExpiry(): Promise<{
    expired: number;
}>;
//# sourceMappingURL=cron.d.ts.map