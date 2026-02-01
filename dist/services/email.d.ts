export declare function sendEmail(params: {
    to: string;
    subject: string;
    body: string;
}): Promise<{
    success: boolean;
    reason: string;
    messageId?: undefined;
} | {
    success: boolean;
    messageId: string;
    reason?: undefined;
}>;
//# sourceMappingURL=email.d.ts.map