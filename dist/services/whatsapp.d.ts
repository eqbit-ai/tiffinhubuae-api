export declare function sendWhatsAppMessage(params: {
    to: string;
    message: string;
}): Promise<{
    success: boolean;
    reason: string;
    messageSid?: undefined;
    status?: undefined;
} | {
    success: boolean;
    messageSid: string;
    status: import("twilio/lib/rest/api/v2010/account/message").MessageStatus;
    reason?: undefined;
}>;
//# sourceMappingURL=whatsapp.d.ts.map