import { Router } from 'express';
import { timingSafeEqual } from 'crypto';
import { runSchedule, SCHEDULES, type ScheduleName } from '../cron';

const router = Router();

/**
 * External trigger for the scheduled jobs.
 *
 * Render's free tier suspends the process after 15 minutes idle, and a
 * suspended process runs no timers — so `node-cron` cannot be relied on there.
 * GitHub Actions calls these endpoints on a schedule instead. The work itself
 * is defined once in `src/cron.ts`; this only pulls the trigger.
 *
 * This router is mounted OUTSIDE the authenticated routes on purpose — there is
 * no user here. It is guarded by a shared secret instead, and refuses to run at
 * all if that secret is not configured. An endpoint that runs billing-adjacent
 * maintenance must never be reachable by an anonymous POST.
 */

/** Constant-time compare that does not leak length through an early return. */
function secretMatches(provided: string, expected: string) {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) {
    // Still burn a comparison so a wrong-length guess is not measurably faster.
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}

router.post('/:schedule', async (req, res) => {
  const expected = process.env.CRON_SECRET;

  // Fail closed. An unset secret means "not configured", never "open to all".
  if (!expected) {
    console.error('[Cron] Refused an external trigger: CRON_SECRET is not set.');
    return res.status(503).json({ error: 'Cron endpoint is not configured.' });
  }

  const header = req.headers.authorization || '';
  const provided = header.startsWith('Bearer ') ? header.slice(7) : String(req.headers['x-cron-secret'] || '');

  if (!provided || !secretMatches(provided, expected)) {
    // Deliberately terse, and logged without the value that was tried.
    console.warn(`[Cron] Rejected an external trigger for "${req.params.schedule}" from ${req.ip}`);
    return res.status(401).json({ error: 'Unauthorized.' });
  }

  const schedule = req.params.schedule as ScheduleName;
  if (!(schedule in SCHEDULES)) {
    return res.status(404).json({ error: `Unknown schedule "${schedule}".`, known: Object.keys(SCHEDULES) });
  }

  const summary = await runSchedule(schedule);

  // 500 when any job failed, so a red GitHub Actions run means something really
  // did not happen. A 200 with failures buried in the body gets ignored.
  return res.status(summary.failed > 0 ? 500 : 200).json(summary);
});

export default router;
