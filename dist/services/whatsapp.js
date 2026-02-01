"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendWhatsAppMessage = sendWhatsAppMessage;
const twilio_1 = __importDefault(require("twilio"));
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
    const result = await client.messages.create({
        from: formattedFrom,
        to: formattedTo,
        body: params.message,
    });
    return { success: true, messageSid: result.sid, status: result.status };
}
//# sourceMappingURL=whatsapp.js.map