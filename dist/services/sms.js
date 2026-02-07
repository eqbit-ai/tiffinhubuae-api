"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendSMS = sendSMS;
const twilio_1 = __importDefault(require("twilio"));
async function sendSMS(params) {
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    const fromNumber = process.env.TWILIO_SMS_FROM;
    if (!accountSid || !authToken || !fromNumber) {
        console.log('[SMS] Twilio not configured, skipping');
        return { success: false, reason: 'Twilio not configured' };
    }
    const client = (0, twilio_1.default)(accountSid, authToken);
    let phoneNumber = params.to.trim();
    // Strip whatsapp: prefix if present
    if (phoneNumber.startsWith('whatsapp:'))
        phoneNumber = phoneNumber.replace('whatsapp:', '');
    if (!phoneNumber.startsWith('+'))
        phoneNumber = '+' + phoneNumber;
    const result = await client.messages.create({
        from: fromNumber,
        to: phoneNumber,
        body: params.message,
    });
    console.log(`[SMS] Message sent to ${phoneNumber} — SID: ${result.sid}, status: ${result.status}`);
    return { success: true, messageSid: result.sid, status: result.status };
}
//# sourceMappingURL=sms.js.map