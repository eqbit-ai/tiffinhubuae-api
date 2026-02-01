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
});

export async function sendEmail(params: { to: string; subject: string; body: string }) {
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
