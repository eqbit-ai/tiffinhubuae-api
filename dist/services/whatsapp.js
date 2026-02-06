"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendWhatsAppMessage = sendWhatsAppMessage;
const twilio_1 = __importDefault(require("twilio"));
const whatsappTemplates_1 = require("./whatsappTemplates");
async function sendWhatsAppMessage(params) {
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    const fromNumber = process.env.TWILIO_WHATSAPP_FROM;
    if (!accountSid || !authToken || !fromNumber) {
        console.log('[WhatsApp] Twilio not configured, skipping');
        return { success: false, reason: 'Twilio not configured' };
    }
    const client = (0, twilio_1.default)(accountSid, authToken);
    let phoneNumber = params.to.trim();
    if (!phoneNumber.startsWith('+'))
        phoneNumber = '+' + phoneNumber;
    const formattedFrom = fromNumber.startsWith('whatsapp:') ? fromNumber : `whatsapp:${fromNumber}`;
    const formattedTo = phoneNumber.startsWith('whatsapp:') ? phoneNumber : `whatsapp:${phoneNumber}`;
    try {
        const messageParams = {
            from: formattedFrom,
            to: formattedTo,
        };
        // Use Content Template if configured (required for production WhatsApp)
        const templateSid = params.templateName ? whatsappTemplates_1.TEMPLATES[params.templateName] : '';
        if (templateSid) {
            messageParams.contentSid = templateSid;
            if (params.contentVariables) {
                messageParams.contentVariables = JSON.stringify(params.contentVariables);
            }
            console.log(`[WhatsApp] Using template ${params.templateName} (${templateSid})`);
        }
        else {
            messageParams.body = params.message;
        }
        const result = await client.messages.create(messageParams);
        console.log(`[WhatsApp] Message sent to ${formattedTo} — SID: ${result.sid}, status: ${result.status}`);
        return { success: true, messageSid: result.sid, status: result.status };
    }
    catch (error) {
        console.error(`[WhatsApp] Failed to send to ${formattedTo}:`, error.message);
        throw error;
    }
}
//# sourceMappingURL=whatsapp.js.map