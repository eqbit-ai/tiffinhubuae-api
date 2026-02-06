import twilio from 'twilio';
import { TEMPLATES } from './whatsappTemplates';

interface WhatsAppParams {
  to: string;
  message: string;
  templateName?: keyof typeof TEMPLATES;
  contentVariables?: Record<string, string>;
}

export async function sendWhatsAppMessage(params: WhatsAppParams) {
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

  try {
    const messageParams: any = {
      from: formattedFrom,
      to: formattedTo,
    };

    // Use Content Template if configured (required for production WhatsApp)
    const templateSid = params.templateName ? TEMPLATES[params.templateName] : '';
    if (templateSid) {
      messageParams.contentSid = templateSid;
      if (params.contentVariables) {
        messageParams.contentVariables = JSON.stringify(params.contentVariables);
      }
      console.log(`[WhatsApp] Using template ${params.templateName} (${templateSid})`);
    } else {
      messageParams.body = params.message;
    }

    const result = await client.messages.create(messageParams);

    console.log(`[WhatsApp] Message sent to ${formattedTo} — SID: ${result.sid}, status: ${result.status}`);
    return { success: true, messageSid: result.sid, status: result.status };
  } catch (error: any) {
    console.error(`[WhatsApp] Failed to send to ${formattedTo}:`, error.message);
    throw error;
  }
}
