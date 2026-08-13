import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { verifyUnsubscribeToken } from '../services/winback';

const router = Router();

/**
 * Unsubscribe from marketing email.
 *
 * Mounted outside the authenticated routes, and it has to be: the person
 * clicking has not signed in, may never sign in again, and requiring a login to
 * stop email is precisely the friction that makes people press "report spam"
 * instead. The HMAC in the link is the authentication — see
 * services/winback.ts for why the raw user id would not do.
 *
 * GET and POST both work, for two different callers. A human clicks the link in
 * the footer, which is a GET. Gmail and Yahoo's one-click button sends a POST
 * with no body it expects us to read (RFC 8058), and it never renders what
 * comes back.
 *
 * Nothing here reveals whether the id or token was the part that was wrong, and
 * a bad link and a good one look the same from outside. This endpoint is
 * unauthenticated and enumerable by construction; it should not also answer
 * questions about who exists.
 */

const PAGE_STYLE =
  "font-family:system-ui,-apple-system,'Segoe UI',sans-serif;max-width:520px;margin:64px auto;padding:0 24px;color:#0F172A;line-height:1.6;";

function page(title: string, body: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${title}</title></head>
<body style="${PAGE_STYLE}"><h1 style="font-size:22px;margin:0 0 12px;">${title}</h1>${body}</body></html>`;
}

async function handleUnsubscribe(userId: string, token: unknown) {
  if (!userId || !verifyUnsubscribeToken(userId, token)) {
    return { ok: false as const };
  }

  // Deliberately not conditional on the user existing or on the current value.
  // updateMany rather than update because a deleted account must not turn a
  // legitimate unsubscribe into a 500 — the click succeeded either way, and
  // there is nothing left to opt out.
  await prisma.user.updateMany({
    where: { id: userId },
    data: { marketing_opt_out: true },
  });

  return { ok: true as const };
}

router.get('/unsubscribe', async (req, res) => {
  const { ok } = await handleUnsubscribe(String(req.query.u || ''), req.query.t);

  if (!ok) {
    return res.status(400).send(
      page(
        'That link did not work',
        `<p>The unsubscribe link looks incomplete — some mail clients cut long links in half.</p>
         <p>Reply to the email with the word "unsubscribe" and it will be handled by hand.</p>`
      )
    );
  }

  return res.send(
    page(
      'Unsubscribed',
      `<p>Done — no more product emails from TiffinHub.</p>
       <p style="color:#64748B;font-size:14px;">If you still have an account, messages about that account itself
       (password resets, an expiring subscription) will still reach you. Those are not marketing and there is no
       way to be a customer without them.</p>`
    )
  );
});

/**
 * One-click. Must return 2xx for the mail client to show the button as having
 * worked, and the body is never displayed, so there is no page to render.
 */
router.post('/unsubscribe', async (req, res) => {
  const userId = String(req.query.u || req.body?.u || '');
  const token = req.query.t ?? req.body?.t;
  const { ok } = await handleUnsubscribe(userId, token);
  return res.status(ok ? 200 : 400).json({ ok });
});

export default router;
