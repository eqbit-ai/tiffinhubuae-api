/**
 * The version of the terms and privacy policy currently being presented.
 *
 * Dated rather than numbered, because the question anyone ever asks about an
 * acceptance record is "what did the document say when they agreed", and a date
 * answers it against the page history without a lookup table.
 *
 * Bump this when the terms change in a way that affects what a merchant agreed
 * to. Existing rows keep the version they accepted; nothing is rewritten.
 */
export const TERMS_VERSION = '2026-08-13';

/**
 * Fields stamped on an account at creation.
 *
 * Every path that creates an account spreads this, so a new signup route cannot
 * quietly ship without a consent record — the omission would be visible as a
 * missing spread rather than invisible as an unset column.
 */
export function termsAcceptance() {
  return { terms_accepted_at: new Date(), terms_version: TERMS_VERSION };
}
