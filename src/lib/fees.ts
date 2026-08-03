/**
 * Platform fee arithmetic, in one place.
 *
 * This block was copy-pasted into nine call sites across portal.ts and
 * functions.ts, each carrying the same two bugs:
 *
 *   const feePercentage = merchant.fee_percentage || 3.5;
 *   const platformFeeAmount = Math.round((amount * feePercentage) / 100);
 *   ...
 *   application_fee_amount: Math.round(platformFeeAmount * 100),
 *
 * 1. The fee was rounded to whole currency units *before* being converted to
 *    minor units, so a 3.5% fee on $100 charged $4.00 instead of $3.50, and on
 *    $150 charged $5.00 instead of $5.25 — out by up to half a unit either way
 *    on every Connect payment.
 * 2. `|| 3.5` treats a deliberate 0% fee as "unset" and silently bills 3.5%.
 *    `??` respects an explicit zero.
 *
 * Everything is computed in minor units (cents/fils) and rounded exactly once,
 * which is what Stripe expects for application_fee_amount.
 */
export const DEFAULT_FEE_PERCENTAGE = 3.5;

export interface PlatformFee {
  /** The percentage actually applied. */
  feePercentage: number;
  /** Gross amount in minor units, for Stripe. */
  amountMinor: number;
  /** Platform fee in minor units, for Stripe's application_fee_amount. */
  feeMinor: number;
  /** Platform fee in major units, for display and DB storage. */
  fee: number;
  /** What the merchant keeps, in major units. */
  net: number;
}

export function calculatePlatformFee(
  amountMajor: number,
  feePercentage?: number | null
): PlatformFee {
  const pct = feePercentage ?? DEFAULT_FEE_PERCENTAGE;
  const amountMinor = Math.round(amountMajor * 100);
  const feeMinor = Math.round((amountMinor * pct) / 100);

  return {
    feePercentage: pct,
    amountMinor,
    feeMinor,
    fee: feeMinor / 100,
    net: (amountMinor - feeMinor) / 100,
  };
}
