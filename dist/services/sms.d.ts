interface SMSParams {
    to: string;
    message: string;
}
export declare function sendSMS(params: SMSParams): Promise<{
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
export {};
//# sourceMappingURL=sms.d.ts.map