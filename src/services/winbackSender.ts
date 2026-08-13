import { prisma } from '../lib/prisma';
import { sendEmail } from './email';
import {
  FOLLOWUP_AFTER_DAYS,
  MAX_ACCOUNT_AGE_DAYS,
  MAX_PER_RUN,
  SEND_INTERVAL_MS,
  looksUndeliverable,
  unsubscribeHeaders,
  unsubscribeUrl,
  winbackEmail,
  winbackFollowupEmail,
} from './winback';

/**
 * Sends the win-back sequence.
 *
 * The eligibility rules and the copy live in `winback.ts`; this is only the part
 * that decides who is next and writes down what went out. Splitting them keeps
 * the rules testable without a database and keeps the reasoning about consent in
 * one file rather than spread across a query.
 *
 * Ordering matters here. The follow-up is filled first: someone already in the
 * sequence has been told a second email is coming, and dropping them halfway to
 * start strangers is both ruder and worse for the reputation that carries the
 * transactional mail. Only what is left of the per-run budget starts new
 * sequences.
 */

/** Where marketing mail comes from. */
function marketingFrom() {
  // A separate subdomain from the transactional sender, so a spam complaint on a
  // campaign lands on a reputation of its own. If MARKETING_FROM is unset we do
  // NOT quietly fall back to support@tiffinhub.me — that address carries
  // password resets and expiry alerts for every merchant, and borrowing it for
  // bulk mail is the specific mistake this whole module is arranged to avoid.
  return process.env.MARKETING_FROM || null;
}

/** The base URL unsubscribe links point at. Must be the API, not the frontend. */
function apiUrl() {
  return process.env.API_URL || process.env.BACKEND_URL || null;
}

type Candidate = {
  id: string;
  email: string;
  full_name: string | null;
  business_name: string | null;
};

const CANDIDATE_FIELDS = { id: true, email: true, full_name: true, business_name: true } as const;

/**
 * Never subscribed, trial is over, still inside the consent window.
 *
 * `stripe_customer_id: null` is the real test for "never paid" — subscription
 * status can read 'expired' for someone who paid for months and then stopped,
 * and that person is a churned customer, not a stalled signup. They get a
 * different conversation, not this one.
 */
function baseWhere() {
  const oldestAllowed = new Date(Date.now() - MAX_ACCOUNT_AGE_DAYS * 24 * 60 * 60 * 1000);
  return {
    subscription_status: 'expired',
    stripe_customer_id: null,
    created_at: { gt: oldestAllowed },
    // A null here means the column predates the default, so it is not an opt-out.
    OR: [{ marketing_opt_out: false }, { marketing_opt_out: null }],
  };
}

async function send(
  user: Candidate,
  build: typeof winbackEmail,
  stampField: 'winback_sent_at' | 'winback_followup_sent_at',
  from: string,
  api: string,
  appUrl: string,
  dryRun: boolean
) {
  const { subject, body } = build(user, { appUrl, unsubUrl: unsubscribeUrl(user.id, api) });

  if (dryRun) {
    // Everything above this line still ran: the query, the eligibility filter,
    // and the template. What is skipped is the send and the stamp, so a dry run
    // can be repeated and always describes the same batch.
    console.log(`[Winback] DRY RUN would send "${subject}" to ${user.email}`);
    return { ok: true as const, dryRun: true };
  }

  const result = await sendEmail({
    to: user.email,
    subject,
    body,
    from,
    // Replies are the point of this sequence — the offer is "send me your list".
    // Without this they would go to a from-address nobody reads.
    replyTo: process.env.SUPER_ADMIN_EMAIL || from,
    headers: unsubscribeHeaders(user.id, api),
  });

  if (!result.success) return { ok: false as const, reason: result.reason };

  // Stamped only after a confirmed send. Stamping first would be the safer
  // choice against double-sends, but it silently drops people when the provider
  // is down — and a merchant who never got the email is not someone we can tell
  // apart later from one who ignored it.
  await prisma.user.update({ where: { id: user.id }, data: { [stampField]: new Date() } });
  return { ok: true as const };
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param dryRun Report the exact batch without sending or stamping anything.
 *   Defaults from WINBACK_DRY_RUN so the first production run can be inspected
 *   by flipping one variable, with no code change and no risk of a half-send.
 */
export async function runWinbackEmails({ dryRun = process.env.WINBACK_DRY_RUN === 'true' } = {}) {
  const from = marketingFrom();
  const api = apiUrl();
  const appUrl = process.env.FRONTEND_URL;

  // Refuse rather than improvise. Each of these missing produces a specific kind
  // of damage — bulk mail on the transactional domain, a dead unsubscribe link,
  // a broken login button — and all three are worse than not sending.
  if (!from) return { skipped: 'MARKETING_FROM is not set' };
  if (!api) return { skipped: 'API_URL is not set — unsubscribe links would be broken' };
  if (!appUrl) return { skipped: 'FRONTEND_URL is not set' };

  const followupCutoff = new Date(Date.now() - FOLLOWUP_AFTER_DAYS * 24 * 60 * 60 * 1000);

  const dueFollowup = await prisma.user.findMany({
    where: {
      ...baseWhere(),
      winback_sent_at: { not: null, lt: followupCutoff },
      winback_followup_sent_at: null,
    },
    select: CANDIDATE_FIELDS,
    orderBy: { winback_sent_at: 'asc' },
    take: MAX_PER_RUN,
  });

  const remaining = MAX_PER_RUN - dueFollowup.length;

  // Newest first. A signup from last week remembers doing it; one from five
  // months ago mostly does not, and if the run is capped it is the recent
  // addresses that are worth the send.
  const dueFirst = remaining > 0
    ? await prisma.user.findMany({
        where: { ...baseWhere(), winback_sent_at: null },
        select: CANDIDATE_FIELDS,
        orderBy: { created_at: 'desc' },
        take: remaining,
      })
    : [];

  const queue: Array<{ user: Candidate; kind: 'followup' | 'first' }> = [
    ...dueFollowup.map((user) => ({ user, kind: 'followup' as const })),
    ...dueFirst.map((user) => ({ user, kind: 'first' as const })),
  ];

  let sent = 0;
  let failed = 0;
  const skipped: string[] = [];
  // Who, not just how many. A count alone cannot answer the question a dry run
  // exists to answer — "is this the right list" — and the per-run cap means a
  // count does not even move when someone drops out of eligibility, because the
  // next candidate takes the freed slot.
  const recipients: Array<{ email: string; kind: 'first' | 'followup' }> = [];

  for (const [index, { user, kind }] of queue.entries()) {
    if (looksUndeliverable(user.email)) {
      // Not stamped. These are test and disposable addresses that should never
      // have entered the list; leaving them unstamped keeps them visible as a
      // data-quality problem instead of recording a send that never happened.
      skipped.push(user.email);
      continue;
    }

    // Between sends only, so the run does not idle after the last one. A dry run
    // talks to nothing, so it has no rate limit to respect.
    if (index > 0 && !dryRun) await wait(SEND_INTERVAL_MS);

    const result = await send(
      user,
      kind === 'followup' ? winbackFollowupEmail : winbackEmail,
      kind === 'followup' ? 'winback_followup_sent_at' : 'winback_sent_at',
      from,
      api,
      appUrl,
      dryRun
    );

    if (result.ok) {
      sent++;
      recipients.push({ email: user.email, kind });
    } else {
      failed++;
      console.error(`[Winback] ${kind} to ${user.email} failed: ${result.reason}`);
    }
  }

  return {
    dry_run: dryRun,
    // Named "would_send" in a dry run so a log line can never be misread as
    // evidence that the backlog already went out.
    [dryRun ? 'would_send' : 'sent']: sent,
    failed,
    skipped_undeliverable: skipped.length,
    recipients,
    first_emails: dueFirst.length,
    followups: dueFollowup.length,
  };
}
