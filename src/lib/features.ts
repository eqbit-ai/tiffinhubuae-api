/**
 * Features that are built, working, and deliberately not offered right now.
 *
 * Nothing is deleted. Every route, service and cron behind these flags is
 * untouched and still compiles — flipping a flag back to `true` restores the
 * feature in full, with no other change required.
 *
 * The frontend hides the matching controls via `src/components/utils/features.jsx`.
 * That only stops the feature being offered; this file is what actually stops it
 * running. Both sides must agree, so if you turn one back on, turn on its pair.
 *
 * WHATSAPP_NOTIFICATIONS
 *   Every outbound WhatsApp message: the merchant's new-order alert, the manual
 *   payment reminder, payment-link delivery, and the customer portal OTP.
 *
 * AUTO_PAYMENTS
 *   The daily cron that generates a Stripe payment link per customer who is due
 *   and WhatsApps it to them. It has never sent anything in production: it
 *   requires a verified Stripe Connect account and no merchant has one.
 *
 * STRIPE_CONNECT
 *   Merchant onboarding to collect money from THEIR customers. This is not how
 *   merchants pay us — that is ordinary Stripe Checkout and Billing, which is
 *   deliberately left alone.
 */
export const FEATURES = {
  WHATSAPP_NOTIFICATIONS: false,
  AUTO_PAYMENTS: false,
  STRIPE_CONNECT: false,
} as const;

/** Sent to the client when a disabled feature is called anyway. */
export const FEATURE_DISABLED = 'FEATURE_DISABLED';

export function featureDisabledResponse(feature: string) {
  return {
    error: 'This feature is not available.',
    errorCode: FEATURE_DISABLED,
    feature,
  };
}

/**
 * Route guard for a disabled feature.
 *
 * Hiding the button is not the same as turning the feature off: the route is
 * still mounted and still reachable by anyone with a session and curl. This
 * refuses with an explicit code rather than half-running, so a disabled feature
 * can never do partial work — no Stripe account created, no message queued.
 *
 * Auth is applied to the whole router, so an unauthenticated call still gets 401
 * and never reaches this. Place it as the route's first middleware so it runs
 * ahead of the per-route checks and the handler body.
 */
export function requireFeature(feature: keyof typeof FEATURES) {
  return (_req: any, res: any, next: any) => {
    if (!FEATURES[feature]) {
      return res.status(403).json(featureDisabledResponse(feature));
    }
    next();
  };
}
