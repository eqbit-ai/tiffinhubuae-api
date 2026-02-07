import twilio from 'twilio';

interface SMSParams {
  to: string;
  message: string;
}

export async function sendSMS(params: SMSParams) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const fromNumber = process.env.TWILIO_SMS_FROM;

  if (!accountSid || !authToken || !fromNumber) {
    console.log('[SMS] Twilio not configured, skipping');
    return { success: false, reason: 'Twilio not configured' };
  }

  const client = twilio(accountSid, authToken);

  let phoneNumber = params.to.trim();
  // Strip whatsapp: prefix if present
  if (phoneNumber.startsWith('whatsapp:')) phoneNumber = phoneNumber.replace('whatsapp:', '');
  if (!phoneNumber.startsWith('+')) phoneNumber = '+' + phoneNumber;

  try {
    const result = await client.messages.create({
      from: fromNumber,
      to: phoneNumber,
      body: params.message,
    });

    console.log(`[SMS] Message sent to ${phoneNumber} — SID: ${result.sid}, status: ${result.status}`);
    return { success: true, messageSid: result.sid, status: result.status };
  } catch (error: any) {
    console.error(`[SMS] Failed to send to ${phoneNumber}:`, error.message);
    throw error;
  }
}
