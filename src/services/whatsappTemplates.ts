// WhatsApp Content Template SIDs (from Twilio Content Template Builder)
// Each env var maps to an approved template for production WhatsApp messaging.
// If a template SID is not set, the message falls back to plain body text
// (works in sandbox mode or within 24h user-initiated conversation window).
//
// IMPORTANT: contentVariables must use the exact named keys from the template,
// NOT numbered keys. Check Twilio Content API for each template's variable names.

export const TEMPLATES = {
  // 1. OTP Login Code (whatsapp/authentication type)
  // Body: "{{1}}" — authentication templates use numbered variables
  // Variables: {{1}} = OTP code
  OTP_LOGIN: process.env.TWILIO_TPL_OTP || '',

  // 2. Payment Reminder (manual + bulk)
  // Body: "Hello {{customer name}}, your payment of {{currency }} {{amount}} is due..."
  // Variables: "customer name", "currency " (trailing space!), "amount"
  PAYMENT_REMINDER: process.env.TWILIO_TPL_PAYMENT_REMINDER || '',

  // 3. Payment Reminder with Link (auto-generated Stripe checkout)
  // Body: "Hello {{name}}, your tiffin subscription ends on {{end date}}. Amount: {{currency}} {{amount}}. Pay securely here: {{payment URL}}"
  // Variables: "name", "end date", "currency", "amount", "payment URL"
  PAYMENT_REMINDER_LINK: process.env.TWILIO_TPL_PAYMENT_REMINDER_LINK || '',

  // 4. Payment Overdue with Link
  // Body: "Hello {{name}}, your subscription expired on {{expiry date}} and payment is overdue. Amount due: {{currency}} {{amount}}. Pay now: {{payment URL}}"
  // Variables: "name", "expiry date", "currency", "amount", "payment URL"
  PAYMENT_OVERDUE: process.env.TWILIO_TPL_PAYMENT_OVERDUE || '',

  // 5. Payment Received / Renewal Confirmed
  // Body: "Hello {{name}}, payment of {{currency}} {{amount}} received! Your subscription is active until {{end date}}. Thank you!"
  // Variables: "name", "currency", "amount", "end date"
  PAYMENT_RECEIVED: process.env.TWILIO_TPL_PAYMENT_RECEIVED || '',

  // 6. Order Confirmed (customer)
  // Body: "Thank you {{name}}! Your order of {{currency}} {{amount}} has been confirmed."
  // Variables: "name", "currency", "amount"
  ORDER_CONFIRMED: process.env.TWILIO_TPL_ORDER_CONFIRMED || '',

  // 7. New Order Alert (merchant) — not yet created
  NEW_ORDER_MERCHANT: process.env.TWILIO_TPL_NEW_ORDER_MERCHANT || '',

  // 8. Service Complete / Trial Expired — not yet created
  SERVICE_ENDED: process.env.TWILIO_TPL_SERVICE_ENDED || '',

  // 9. Feedback / Meal Rating Request — not yet created
  FEEDBACK_REQUEST: process.env.TWILIO_TPL_FEEDBACK || '',

  // 10. Registration Status — not yet created
  REGISTRATION_STATUS: process.env.TWILIO_TPL_REGISTRATION || '',
};

// Helper to check if a template is configured
export function hasTemplate(templateName: keyof typeof TEMPLATES): boolean {
  return !!TEMPLATES[templateName];
}
