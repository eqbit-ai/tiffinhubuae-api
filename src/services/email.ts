import nodemailer from 'nodemailer';
import { Resend } from 'resend';

// Resend (preferred — works from cloud hosting)
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

// SMTP fallback
const smtpPort = parseInt(process.env.SMTP_PORT || '587');
const transporter = nodemailer.createTransport({
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

export async function sendEmail(params: { to: string; subject: string; body: string }) {
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
    } catch (err: any) {
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
  } catch (err: any) {
    console.error('[Email/SMTP] Failed:', params.subject, '-', err.message);
    return { success: false, reason: err.message };
  }
}
