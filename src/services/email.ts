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

export type SendEmailParams = {
  to: string;
  subject: string;
  body: string;
  /**
   * Overrides the default sender. Marketing mail uses this to send from a
   * separate verified subdomain, so a spam complaint on a campaign cannot take
   * password resets and expiry alerts down with it — those share one reputation
   * with whatever else leaves the same domain.
   */
  from?: string;
  replyTo?: string;
  /** List-Unsubscribe and friends. Ignored by the SMTP fallback's own headers. */
  headers?: Record<string, string>;
};

export async function sendEmail(params: SendEmailParams) {
  const from =
    params.from || process.env.SMTP_FROM || process.env.SMTP_USER || 'support@tiffinhub.me';

  // Use Resend if configured
  if (resend) {
    try {
      const { data, error } = await resend.emails.send({
        from,
        to: params.to,
        subject: params.subject,
        html: params.body,
        ...(params.replyTo ? { replyTo: params.replyTo } : {}),
        ...(params.headers ? { headers: params.headers } : {}),
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
      ...(params.replyTo ? { replyTo: params.replyTo } : {}),
      ...(params.headers ? { headers: params.headers } : {}),
    });
    console.log('[Email/SMTP] Sent:', params.subject, 'to', params.to);
    return { success: true, messageId: info.messageId };
  } catch (err: any) {
    console.error('[Email/SMTP] Failed:', params.subject, '-', err.message);
    return { success: false, reason: err.message };
  }
}
