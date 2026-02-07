export declare function sendEmail(params: {
    to: string;
    subject: string;
    body: string;
}): Promise<{
    success: boolean;
    messageId: string;
    reason?: undefined;
} | {
    success: boolean;
    reason: any;
    messageId?: undefined;
}>;
//# sourceMappingURL=email.d.ts.map