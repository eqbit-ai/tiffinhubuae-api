import Stripe from 'stripe';

const stripeKey = process.env.STRIPE_SECRET_KEY || 'sk_test_placeholder';

export const stripe = new Stripe(stripeKey, {
  apiVersion: '2024-12-18.acacia' as any,
});

export const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
// The product has one plan, so there is one price. STRIPE_PRICE_ID is the name
// going forward; STRIPE_PREMIUM_PRICE_ID is still read so the deployed env keeps
// working without a coordinated restart.
// .trim() is not cosmetic: a value pasted into a hosting dashboard with a
// trailing space is still a "set" env var, but every === against a Stripe id
// fails and Stripe rejects the id outright — which silently made the plan
// unbuyable and showed "No active plans found" on the paywall.
export const STRIPE_PREMIUM_PRICE_ID = (
  process.env.STRIPE_PRICE_ID || process.env.STRIPE_PREMIUM_PRICE_ID || ''
).trim();
