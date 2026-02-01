"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendEmail = sendEmail;
const nodemailer_1 = __importDefault(require("nodemailer"));
const smtpPort = parseInt(process.env.SMTP_PORT || '587');
const transporter = nodemailer_1.default.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: smtpPort,
    secure: smtpPort === 465,
    auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
    },
});
async function sendEmail(params) {
    if (!process.env.SMTP_USER) {
        console.log('[Email] SMTP not configured, skipping:', params.subject);
        return { success: false, reason: 'SMTP not configured' };
    }
    const info = await transporter.sendMail({
        from: process.env.SMTP_FROM || process.env.SMTP_USER,
        to: params.to,
        subject: params.subject,
        html: params.body,
    });
    return { success: true, messageId: info.messageId };
}
//# sourceMappingURL=email.js.map