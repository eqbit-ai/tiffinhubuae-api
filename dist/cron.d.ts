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
export declare function runInventoryDeduction(dateStr?: string): Promise<{
    merchants: number;
    ingredients: number;
    note: string;
    date?: undefined;
} | {
    merchants: number;
    ingredients: number;
    date: string;
    note?: undefined;
}>;
//# sourceMappingURL=cron.d.ts.map