"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendEmail = sendEmail;
const nodemailer_1 = __importDefault(require("nodemailer"));
const resend_1 = require("resend");
// Resend (preferred — works from cloud hosting)
const resend = process.env.RESEND_API_KEY ? new resend_1.Resend(process.env.RESEND_API_KEY) : null;
// SMTP fallback
const smtpPort = parseInt(process.env.SMTP_PORT || '587');
const transporter = nodemailer_1.default.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: smtpPort,
    secure: smtpPort === 465,
    auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
    },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000,
});
async function sendEmail(params) {
    const from = process.env.SMTP_FROM || process.env.SMTP_USER || 'support@tiffinhub.me';
    // Use Resend if configured
    if (resend) {
        try {
            const { data, error } = await resend.emails.send({
                from,
                to: params.to,
                subject: params.subject,
                html: params.body,
            });
            if (error) {
                console.error('[Email/Resend] Failed:', params.subject, '-', error.message);
                return { success: false, reason: error.message };
            }
            console.log('[Email/Resend] Sent:', params.subject, 'to', params.to);
            return { success: true, messageId: data?.id };
        }
        catch (err) {
            console.error('[Email/Resend] Error:', params.subject, '-', err.message);
            return { success: false, reason: err.message };
        }
    }
    // SMTP fallback
    if (!process.env.SMTP_USER) {
        console.log('[Email] No email provider configured, skipping:', params.subject);
        return { success: false, reason: 'No email provider configured' };
    }
    try {
        const info = await transporter.sendMail({
            from,
            to: params.to,
            subject: params.subject,
            html: params.body,
        });
        console.log('[Email/SMTP] Sent:', params.subject, 'to', params.to);
        return { success: true, messageId: info.messageId };
    }
    catch (err) {
        console.error('[Email/SMTP] Failed:', params.subject, '-', err.message);
        return { success: false, reason: err.message };
    }
}
//# sourceMappingURL=email.js.map