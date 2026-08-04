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
export declare function runSubscriptionExpiry(): Promise<{
    scanned: number;
    expired: number;
    keptStripeActive: number;
    skippedSpecialAccess: number;
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