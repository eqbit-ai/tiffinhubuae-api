import nodemailer from 'nodemailer';

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
  if (!process.env.SMTP_USER) {
    console.log('[Email] SMTP not configured, skipping:', params.subject);
    return { success: false, reason: 'SMTP not configured' };
  }

  try {
    const info = await transporter.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to: params.to,
      subject: params.subject,
      html: params.body,
    });
    return { success: true, messageId: info.messageId };
  } catch (err: any) {
    console.error('[Email] Failed to send:', params.subject, '-', err.message);
    return { success: false, reason: err.message };
  }
}
