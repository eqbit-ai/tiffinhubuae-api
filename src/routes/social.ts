import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { authMiddleware, superAdminOnly, AuthRequest } from '../middleware/auth';
import { publishPost, postedToday, credentialsConfigured } from '../services/socialPublisher';

const router = Router();

/**
 * The social review queue.
 *
 * Every route here is super-admin only, and mounted behind authMiddleware —
 * these publish to a public brand account, and there is no version of this that
 * a merchant should be able to reach.
 *
 * The design rule is that approval is the only path to an audience. A generator
 * can write a thousand rows; each one sits at `pending` until a human opens the
 * panel, looks at the rendered image and the exact caption, and presses a
 * button. Nothing here can be approved in bulk without seeing it, and there is
 * deliberately no "approve everything" endpoint.
 */

/**
 * How many posts may go out in one calendar day.
 *
 * Twenty, to Instagram and Facebook. Instagram's own API ceiling is 50 per 24
 * hours, so this sits under it — but the ceiling is not the recommendation, and
 * this number is an env var precisely so it can be lowered without a deploy if
 * reach drops or unfollows climb. Watch those two numbers for a fortnight
 * before deciding twenty was right.
 */
export const DAILY_CAP = Number(process.env.SOCIAL_DAILY_CAP || 20);

router.use(authMiddleware, superAdminOnly);

/** Queue, newest first, filtered by status. */
router.get('/posts', async (req: AuthRequest, res) => {
  const status = String(req.query.status || 'pending');
  const take = Math.min(Number(req.query.limit) || 60, 200);

  const posts = await prisma.socialPost.findMany({
    where: status === 'all' ? {} : { status },
    orderBy: [{ scheduled_for: 'asc' }, { created_at: 'asc' }],
    take,
  });

  return res.json(posts);
});

/** Counts per status, for the tab badges. */
router.get('/stats', async (_req: AuthRequest, res) => {
  const grouped = await prisma.socialPost.groupBy({ by: ['status'], _count: true });

  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const postedToday = await prisma.socialPost.count({
    where: { status: 'posted', posted_at: { gte: startOfDay } },
  });

  return res.json({
    by_status: Object.fromEntries(grouped.map((g) => [g.status, g._count])),
    posted_today: postedToday,
    daily_cap: DAILY_CAP,
    remaining_today: Math.max(0, DAILY_CAP - postedToday),
  });
});

/**
 * Approve one post.
 *
 * Only from `pending` or `failed`. Approving something already `posted` would
 * send it twice, and the guard is here rather than in the UI because the UI is
 * not the only thing that can call this.
 */
router.post('/posts/:id/approve', async (req: AuthRequest, res) => {
  const post = await prisma.socialPost.findUnique({ where: { id: String(req.params.id) } });
  if (!post) return res.status(404).json({ error: 'No such post' });
  if (!['pending', 'failed', 'skipped'].includes(post.status)) {
    return res.status(409).json({ error: `Cannot approve a post that is already ${post.status}` });
  }

  const updated = await prisma.socialPost.update({
    where: { id: post.id },
    data: {
      status: 'approved',
      reviewed_by: req.user!.email,
      reviewed_at: new Date(),
      error: null,
      // An approval with no date means "as soon as the next run comes round".
      scheduled_for: post.scheduled_for ?? new Date(),
    },
  });

  return res.json(updated);
});

/** Reject one post. Reversible — a skipped post can be approved later. */
router.post('/posts/:id/skip', async (req: AuthRequest, res) => {
  const post = await prisma.socialPost.findUnique({ where: { id: String(req.params.id) } });
  if (!post) return res.status(404).json({ error: 'No such post' });
  if (post.status === 'posted') {
    return res.status(409).json({ error: 'That one has already gone out' });
  }

  const updated = await prisma.socialPost.update({
    where: { id: post.id },
    data: { status: 'skipped', reviewed_by: req.user!.email, reviewed_at: new Date() },
  });

  return res.json(updated);
});

/** Edit a caption before approving. The one thing worth fixing in place. */
router.put('/posts/:id', async (req: AuthRequest, res) => {
  const { caption, scheduled_for, targets } = req.body;
  const post = await prisma.socialPost.findUnique({ where: { id: String(req.params.id) } });
  if (!post) return res.status(404).json({ error: 'No such post' });
  if (post.status === 'posted') {
    return res.status(409).json({ error: 'That one has already gone out' });
  }

  const updated = await prisma.socialPost.update({
    where: { id: post.id },
    data: {
      ...(typeof caption === 'string' ? { caption } : {}),
      ...(targets ? { targets } : {}),
      ...(scheduled_for ? { scheduled_for: new Date(scheduled_for) } : {}),
    },
  });

  return res.json(updated);
});

/**
 * Register rendered posts.
 *
 * Called by the local build after it has rendered the images and pushed them to
 * Cloudinary. Upserts on slug so re-running the generator corrects a row rather
 * than filling the queue with duplicates — but it will not touch anything
 * already reviewed, because silently reverting an approved post back to pending
 * is how something goes out that a person thought they had rejected.
 */
router.post('/posts', async (req: AuthRequest, res) => {
  const incoming = Array.isArray(req.body) ? req.body : [req.body];

  const results = { created: 0, updated: 0, left_alone: 0 };
  for (const item of incoming) {
    if (!item.slug || !item.media_url || !item.caption) {
      return res.status(400).json({ error: 'Each post needs slug, media_url and caption' });
    }

    const existing = await prisma.socialPost.findUnique({ where: { slug: item.slug } });
    if (existing && existing.status !== 'pending') {
      results.left_alone++;
      continue;
    }

    const data = {
      layout: item.layout || 'statement',
      caption: item.caption,
      media_url: item.media_url,
      is_video: !!item.is_video,
      targets: item.targets || 'instagram,facebook',
      scheduled_for: item.scheduled_for ? new Date(item.scheduled_for) : null,
    };

    if (existing) {
      await prisma.socialPost.update({ where: { slug: item.slug }, data });
      results.updated++;
    } else {
      await prisma.socialPost.create({ data: { slug: item.slug, ...data } });
      results.created++;
    }
  }

  return res.json(results);
});

/**
 * Send one approved post immediately.
 *
 * The scheduled run goes every fifteen minutes, which is fine once it is
 * trusted and useless when you are testing — approving something and staring at
 * an unchanged screen is how a working feature gets reported as broken. This
 * takes the same code path as the scheduler, including the daily cap, so it is
 * not a second untested way to publish.
 *
 * Only from `approved`. Publishing straight from `pending` would make the
 * review step optional, which is the one thing this whole design exists to
 * prevent.
 */
router.post('/posts/:id/publish-now', async (req: AuthRequest, res) => {
  if (!credentialsConfigured()) {
    return res.status(503).json({ error: 'Meta credentials are not configured on the server.' });
  }

  const post = await prisma.socialPost.findUnique({ where: { id: String(req.params.id) } });
  if (!post) return res.status(404).json({ error: 'No such post' });
  if (post.status !== 'approved') {
    return res.status(409).json({ error: `Only an approved post can be published — this one is ${post.status}.` });
  }

  const today = await postedToday();
  if (today >= DAILY_CAP) {
    return res.status(429).json({ error: `Daily cap of ${DAILY_CAP} already reached.` });
  }

  const result = await publishPost(post);
  if (!result.ok) return res.status(502).json({ error: result.reason });

  return res.json(await prisma.socialPost.findUnique({ where: { id: post.id } }));
});

export default router;
