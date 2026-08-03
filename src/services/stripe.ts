import Stripe from 'stripe';

const stripeKey = process.env.STRIPE_SECRET_KEY || 'sk_test_placeholder';

export const stripe = new Stripe(stripeKey, {
  apiVersion: '2024-12-18.acacia' as any,
});

export const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
// The product has one plan, so there is one price. STRIPE_PRICE_ID is the name
// going forward; STRIPE_PREMIUM_PRICE_ID is still read so the deployed env keeps
// working without a coordinated restart.
export const STRIPE_PREMIUM_PRICE_ID =
  process.env.STRIPE_PRICE_ID || process.env.STRIPE_PREMIUM_PRICE_ID || '';
