// WhatsApp Content Template SIDs (from Twilio Content Template Builder)
// Each env var maps to an approved template for production WhatsApp messaging.
// If a template SID is not set, the message falls back to plain body text
// (works in sandbox mode or within 24h user-initiated conversation window).

export const TEMPLATES = {
  // 1. OTP Login Code
  // Template body: "Your {{1}} login code is: {{2}}. This code expires in 10 minutes. Do not share this code."
  // Variables: {{1}} = business name, {{2}} = OTP code
  OTP_LOGIN: process.env.TWILIO_TPL_OTP || '',

  // 2. Payment Reminder (manual + bulk)
  // Template body: "Hello {{1}}, your payment of {{2}} {{3}} is due. Please make the payment to continue your tiffin service. Thank you!"
  // Variables: {{1}} = customer name, {{2}} = currency, {{3}} = amount
  PAYMENT_REMINDER: process.env.TWILIO_TPL_PAYMENT_REMINDER || '',

  // 3. Payment Reminder with Link (auto-generated Stripe checkout)
  // Template body: "Hello {{1}}, your tiffin subscription ends on {{2}}. Amount: {{3}} {{4}}. Pay securely here: {{5}}"
  // Variables: {{1}} = name, {{2}} = end date, {{3}} = currency, {{4}} = amount, {{5}} = payment URL
  PAYMENT_REMINDER_LINK: process.env.TWILIO_TPL_PAYMENT_REMINDER_LINK || '',

  // 4. Payment Overdue with Link
  // Template body: "Hello {{1}}, your subscription expired on {{2}} and payment is overdue. Amount due: {{3}} {{4}}. Pay now: {{5}}"
  // Variables: {{1}} = name, {{2}} = expiry date, {{3}} = currency, {{4}} = amount, {{5}} = payment URL
  PAYMENT_OVERDUE: process.env.TWILIO_TPL_PAYMENT_OVERDUE || '',

  // 5. Payment Received / Renewal Confirmed
  // Template body: "Hello {{1}}, payment of {{2}} {{3}} received! Your subscription is active until {{4}}. Thank you!"
  // Variables: {{1}} = name, {{2}} = currency, {{3}} = amount, {{4}} = end date
  PAYMENT_RECEIVED: process.env.TWILIO_TPL_PAYMENT_RECEIVED || '',

  // 6. Order Confirmed (customer)
  // Template body: "Thank you {{1}}! Your order of {{2}} {{3}} has been confirmed. {{4}}"
  // Variables: {{1}} = name, {{2}} = currency, {{3}} = amount, {{4}} = delivery info
  ORDER_CONFIRMED: process.env.TWILIO_TPL_ORDER_CONFIRMED || '',

  // 7. New Order Alert (merchant)
  // Template body: "New order from {{1}}. Amount: {{2}} {{3}}. Delivery: {{4}}. Please check your dashboard."
  // Variables: {{1}} = customer name, {{2}} = currency, {{3}} = amount, {{4}} = delivery date
  NEW_ORDER_MERCHANT: process.env.TWILIO_TPL_NEW_ORDER_MERCHANT || '',

  // 8. Service Complete / Trial Expired
  // Template body: "Hello {{1}}, your {{2}} has ended. To continue service, please renew your subscription. Amount: {{3}} {{4}}"
  // Variables: {{1}} = name, {{2}} = "tiffin service" or "free trial", {{3}} = currency, {{4}} = amount
  SERVICE_ENDED: process.env.TWILIO_TPL_SERVICE_ENDED || '',

  // 9. Feedback / Meal Rating Request
  // Template body: "Hello {{1}}, we'd love your feedback! Please rate our tiffin service from 1 to 5 stars. Reply with just the number (1-5) and any comments."
  // Variables: {{1}} = name
  FEEDBACK_REQUEST: process.env.TWILIO_TPL_FEEDBACK || '',

  // 10. Registration Status (approved/rejected)
  // Template body: "Hello {{1}}, your registration with {{2}} has been {{3}}. {{4}}"
  // Variables: {{1}} = name, {{2}} = business name, {{3}} = "approved"/"rejected", {{4}} = additional info
  REGISTRATION_STATUS: process.env.TWILIO_TPL_REGISTRATION || '',
};

// Helper to check if a template is configured
export function hasTemplate(templateName: keyof typeof TEMPLATES): boolean {
  return !!TEMPLATES[templateName];
}
