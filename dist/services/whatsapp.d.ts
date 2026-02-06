import { TEMPLATES } from './whatsappTemplates';
interface WhatsAppParams {
    to: string;
    message: string;
    templateName?: keyof typeof TEMPLATES;
    contentVariables?: Record<string, string>;
}
export declare function sendWhatsAppMessage(params: WhatsAppParams): Promise<{
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
//# sourceMappingURL=whatsapp.d.ts.map