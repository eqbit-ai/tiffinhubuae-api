export declare function startCronJobs(): void;
export declare function runDeliveryPhotoCleanup(): Promise<{
    photosCleared: number;
    totalPhotos: number;
    locationsDeleted: number;
}>;
export declare function runMerchantTrialExpiry(): Promise<{
    expired: number;
}>;
//# sourceMappingURL=cron.d.ts.map