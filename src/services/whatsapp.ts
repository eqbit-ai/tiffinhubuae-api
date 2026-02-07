import twilio from 'twilio';
import { TEMPLATES } from './whatsappTemplates';
import { prisma } from '../lib/prisma';

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

// Merchant-aware wrapper: checks 400 limit, sends, increments count
export async function sendMerchantWhatsApp(merchantId: string, params: WhatsAppParams) {
  const merchant = await prisma.user.findUnique({
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
    await prisma.user.update({
      where: { id: merchantId },
      data: { whatsapp_sent_count: sent + 1 },
    });
  }

  return result;
}
