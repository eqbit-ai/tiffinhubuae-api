import crypto from 'crypto';

/**
 * The two emails sent to a merchant who signed up, never subscribed, and whose
 * trial has ended.
 *
 * This is the only marketing mail the product sends, and it is written to be
 * defensible on three fronts that transactional mail never has to think about.
 *
 * Consent. Everyone here asked for an account and gave this address to get one.
 * That is implied consent under CASL, which matters because a real part of this
 * list is Canadian — but CASL's implied consent from an inquiry lasts six
 * months, so MAX_ACCOUNT_AGE_DAYS stops the sequence reaching someone who
 * signed up two years ago and forgot. An address that old is also the one most
 * likely to be dead, and bounces cost more than the send is worth.
 *
 * Unsubscribe. Every send carries a working one-click link and the matching
 * List-Unsubscribe headers, so a recipient who wants out takes the easy route
 * instead of the spam button. The two are not equivalent: one sets a flag, the
 * other damages delivery for every merchant on the domain.
 *
 * Truth. The copy claims nothing the product does not do. No WhatsApp
 * automation, no payments taken from customers, no invented time savings. It
 * also never says "your trial expired" as a fact about the reader, because one
 * route into this state is re-registering after deleting an account, where that
 * sentence would be false.
 */

const SECRET = process.env.JWT_SECRET || 'change-me-in-production';

/** Days after signup past which the sequence will not start. See CASL, above. */
export const MAX_ACCOUNT_AGE_DAYS = 180;

/** Days between the first email and the follow-up. */
export const FOLLOWUP_AFTER_DAYS = 7;

/**
 * Most emails per run.
 *
 * The first run has a backlog to work through, and pushing forty messages from
 * a subdomain with no sending history is how a new domain gets filtered. A cap
 * spreads the backlog over several days, which is also how you find out from
 * two bounces rather than twenty that an assumption was wrong.
 */
export const MAX_PER_RUN = 25;

/** Resend allows 2 requests/second. Stay under it rather than handle 429s. */
export const SEND_INTERVAL_MS = 600;

/**
 * Addresses that exist in the users table but cannot receive mail: disposable
 * inboxes and the test accounts used during development. Sending to these earns
 * hard bounces, and a bounce rate is a reputation number — the domain pays for
 * it long after the send.
 *
 * Domains only. A blocklist of individual addresses needs maintaining every time
 * someone signs up as test@something, and the domain is the part that generalises.
 */
const UNDELIVERABLE_DOMAINS = new Set([
  'test.com',
  'abc.com',
  'example.com',
  'example.org',
  'example.net',
  'localhost',
  'mailinator.com',
  'bncinema.com',
  'soco7.com',
  'guerrillamail.com',
  'sharklasers.com',
  '10minutemail.com',
  'tempmail.com',
  'yopmail.com',
  'trashmail.com',
]);

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function looksUndeliverable(email: string | null | undefined): boolean {
  const address = String(email || '').trim().toLowerCase();
  if (!EMAIL_SHAPE.test(address)) return true;
  const domain = address.slice(address.lastIndexOf('@') + 1);
  return UNDELIVERABLE_DOMAINS.has(domain);
}

/**
 * Unsubscribe link token.
 *
 * An HMAC of the user id rather than the id alone: the link is handled by an
 * unauthenticated route, so a bare id would let anyone walk the id space and
 * opt out every merchant on the platform. Deriving from JWT_SECRET means there
 * is no new secret to distribute, and it fails closed — the server already
 * refuses to start without one.
 */
export function unsubscribeToken(userId: string): string {
  return crypto.createHmac('sha256', SECRET).update(`winback:${userId}`).digest('hex').slice(0, 32);
}

export function verifyUnsubscribeToken(userId: string, token: unknown): boolean {
  const expected = Buffer.from(unsubscribeToken(userId));
  const given = Buffer.from(String(token || ''));
  // Length check first: timingSafeEqual throws on a mismatch rather than
  // returning false, and the length is not the secret.
  if (expected.length !== given.length) return false;
  return crypto.timingSafeEqual(expected, given);
}

export function unsubscribeUrl(userId: string, apiUrl: string): string {
  const base = apiUrl.replace(/\/+$/, '');
  return `${base}/api/email/unsubscribe?u=${encodeURIComponent(userId)}&t=${unsubscribeToken(userId)}`;
}

/**
 * RFC 8058 one-click unsubscribe.
 *
 * Gmail and Yahoo require this on bulk mail, and the List-Unsubscribe-Post
 * header is the half people forget: without it the client shows no unsubscribe
 * affordance and the reader reaches for "report spam" instead.
 */
export function unsubscribeHeaders(userId: string, apiUrl: string): Record<string, string> {
  return {
    'List-Unsubscribe': `<${unsubscribeUrl(userId, apiUrl)}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  };
}

function escapeHtml(value: string): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** First name if we have one, otherwise a greeting that works without it. */
function greeting(fullName: string | null, businessName: string | null): string {
  const first = String(fullName || '').trim().split(/\s+/)[0];
  if (first && first.length > 1) return `Hi ${escapeHtml(first)},`;
  if (businessName) return `Hi ${escapeHtml(businessName)},`;
  return 'Hi,';
}

function layout(inner: string, unsubUrl: string): string {
  return `
<div style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;color:#0F172A;max-width:520px;font-size:15px;line-height:1.6;">
${inner}
  <hr style="border:none;border-top:1px solid #E2E8F0;margin:28px 0 14px;" />
  <p style="color:#94A3B8;font-size:12px;line-height:1.5;margin:0;">
    You are getting this because you created a TiffinHub account. If you would rather not hear from us again,
    <a href="${unsubUrl}" style="color:#94A3B8;">unsubscribe here</a> — it takes one click and we will not email you about the product again.
  </p>
</div>`.trim();
}

export type WinbackEmail = { subject: string; body: string };

/**
 * Email one. Names the situation plainly, says what the product does in
 * concrete terms, and ends on an offer of help rather than a request for money.
 *
 * The offer to do the data entry is the part that converts this audience. A
 * merchant who signs up and never returns has almost always stalled on typing
 * in a customer list, not on the price — at $10 the price is not what they are
 * weighing.
 */
export function winbackEmail(
  user: { full_name: string | null; business_name: string | null },
  links: { appUrl: string; unsubUrl: string }
): WinbackEmail {
  const app = links.appUrl.replace(/\/+$/, '');
  return {
    subject: 'You set up TiffinHub but never ran a morning on it',
    body: layout(
      `
  <p style="margin:0 0 16px;">${greeting(user.full_name, user.business_name)}</p>

  <p style="margin:0 0 16px;">You made a TiffinHub account and then never ran a day on it. That is usually one of two
  things — the setup felt like work you did not have time for, or it was not obvious what you would get out the other side.</p>

  <p style="margin:0 0 16px;">So, the short version of what it does. Every morning it works out what you have to cook,
  from your own customer list, in whatever items you actually serve. Pauses and skips are already taken off. Labels print
  for the day with the right name, address and diet. And it shows who owes you, so you are not searching a chat to find out.</p>

  <p style="margin:0 0 16px;">One plan, $10 a month, everything included. Cancel any time.</p>

  <p style="margin:0 0 24px;">Your account is still there and nothing was deleted:</p>

  <p style="margin:0 0 24px;">
    <a href="${app}/login" style="display:inline-block;background:#EA580C;color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:10px;font-weight:600;">Open your account</a>
  </p>

  <p style="margin:0 0 16px;">If typing in the customers is the thing stopping you, reply to this email with your list in
  any form — a spreadsheet, a photo of a notebook, anything — and I will put it in for you and send back a working account.</p>

  <p style="margin:0;">Saif<br /><span style="color:#64748B;">TiffinHub</span></p>`,
      links.unsubUrl
    ),
  };
}

/**
 * Email two, a week later. Shorter, one question, and it says outright that it
 * is the last one — which is both true and the reason people answer it.
 */
export function winbackFollowupEmail(
  user: { full_name: string | null; business_name: string | null },
  links: { appUrl: string; unsubUrl: string }
): WinbackEmail {
  const app = links.appUrl.replace(/\/+$/, '');
  return {
    subject: 'Want me to set TiffinHub up for you?',
    body: layout(
      `
  <p style="margin:0 0 16px;">${greeting(user.full_name, user.business_name)}</p>

  <p style="margin:0 0 16px;">I wrote last week about the TiffinHub account you set up and never used. This is the last
  one I will send about it.</p>

  <p style="margin:0 0 16px;">The offer stands and it is a real one: send me your customer list however you keep it and I
  will set the whole thing up myself, so the first time you see it, it is running on your own numbers rather than a demo.
  It takes me about an hour and costs you nothing.</p>

  <p style="margin:0 0 16px;">And if the answer is that TiffinHub does not do something you need it to do, I would rather
  hear that. Reply and tell me what was missing — I will say honestly whether I can build it.</p>

  <p style="margin:0 0 24px;">
    <a href="${app}/login" style="display:inline-block;background:#EA580C;color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:10px;font-weight:600;">Open your account</a>
  </p>

  <p style="margin:0;">Saif<br /><span style="color:#64748B;">TiffinHub</span></p>`,
      links.unsubUrl
    ),
  };
}
