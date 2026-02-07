"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendWhatsAppMessage = sendWhatsAppMessage;
exports.sendMerchantWhatsApp = sendMerchantWhatsApp;
const twilio_1 = __importDefault(require("twilio"));
const whatsappTemplates_1 = require("./whatsappTemplates");
const prisma_1 = require("../lib/prisma");
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
        const templateSid = params.templateName ? whatsappTemplates_1.TEMPLATES[params.templateName] : '';
        if (templateSid) {
            messageParams.contentSid = templateSid;
            if (params.contentVariables) {
                // Ensure all values are non-null strings (Twilio rejects null/undefined)
                const safeVars = {};
                for (const [k, v] of Object.entries(params.contentVariables)) {
                    safeVars[k] = v ?? '';
                }
                messageParams.contentVariables = JSON.stringify(safeVars);
            }
            console.log(`[WhatsApp] Using template ${params.templateName} (${templateSid})`);
        }
        else {
            messageParams.body = params.message;
        }
        try {
            const result = await client.messages.create(messageParams);
            console.log(`[WhatsApp] Message sent to ${formattedTo} — SID: ${result.sid}, status: ${result.status}`);
            return { success: true, messageSid: result.sid, status: result.status };
        }
        catch (templateErr) {
            // If template send fails (e.g. 21656 invalid variables), fall back to plain body
            if (templateSid && params.message) {
                console.warn(`[WhatsApp] Template failed (${templateErr.code || templateErr.message}), falling back to body text`);
                const fallbackResult = await client.messages.create({
                    from: formattedFrom,
                    to: formattedTo,
                    body: params.message,
                });
                console.log(`[WhatsApp] Fallback sent to ${formattedTo} — SID: ${fallbackResult.sid}`);
                return { success: true, messageSid: fallbackResult.sid, status: fallbackResult.status };
            }
            throw templateErr;
        }
    }
    catch (error) {
        console.error(`[WhatsApp] Failed to send to ${formattedTo}:`, error.message);
        throw error;
    }
}
// Merchant-aware wrapper: checks 400 limit, sends, increments count
async function sendMerchantWhatsApp(merchantId, params) {
    const merchant = await prisma_1.prisma.user.findUnique({
        where: { id: merchantId },
        select: { whatsapp_sent_count: true, whatsapp_limit: true },
    });
    if (!merchant) {
        console.log(`[WhatsApp] Merchant ${merchantId} not found, skipping`);
        return { success: false, reason: 'Merchant not found' };
    }
    const limit = Math.max(merchant.whatsapp_limit || 400, 400);
    const sent = merchant.whatsapp_sent_count || 0;
    if (sent >= limit) {
        console.log(`[WhatsApp] Merchant ${merchantId} hit limit (${sent}/${limit}), skipping`);
        return { success: false, reason: 'Message limit reached' };
    }
    const result = await sendWhatsAppMessage(params);
    if (result.success) {
        await prisma_1.prisma.user.update({
            where: { id: merchantId },
            data: { whatsapp_sent_count: sent + 1 },
        });
    }
    return result;
}
//# sourceMappingURL=whatsapp.js.map