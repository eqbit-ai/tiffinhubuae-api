declare const router: import("express-serve-static-core").Router;
export declare function runAutoPaymentReminders(): Promise<{
    success: boolean;
    beforeReminders: number;
    afterReminders: number;
}>;
export declare function runTrialExpiryCheck(): Promise<{
    success: boolean;
    trialReminders: number;
}>;
export declare function runMealRatingRequests(): Promise<{
    success: boolean;
    ratingRequests: number;
}>;
export default router;
//# sourceMappingURL=functions.d.ts.map