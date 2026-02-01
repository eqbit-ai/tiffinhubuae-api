import twilio from 'twilio';

export async function sendWhatsAppMessage(params: { to: string; message: string }) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const fromNumber = process.env.TWILIO_WHATSAPP_FROM;

  if (!accountSid || !authToken || !fromNumber) {
    console.log('[WhatsApp] Twilio not configured, skipping');
    return { success: false, reason: 'Twilio not configured' };
  }

  const client = twilio(accountSid, authToken);

  let phoneNumber = params.to.trim();
  if (!phoneNumber.startsWith('+')) phoneNumber = '+' + phoneNumber;

  const formattedFrom = fromNumber.startsWith('whatsapp:') ? fromNumber : `whatsapp:${fromNumber}`;
  const formattedTo = phoneNumber.startsWith('whatsapp:') ? phoneNumber : `whatsapp:${phoneNumber}`;

  const result = await client.messages.create({
    from: formattedFrom,
    to: formattedTo,
    body: params.message,
  });

  return { success: true, messageSid: result.sid, status: result.status };
}
