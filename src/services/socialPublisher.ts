import { prisma } from '../lib/prisma';
import { DAILY_CAP } from '../routes/social';

const GRAPH = 'https://graph.facebook.com/v21.0';

/**
 * Sends approved posts to Instagram and the Facebook Page.
 *
 * It only ever reads rows already marked `approved`. There is no path from
 * `pending` to an audience that does not go through a person pressing a button
 * in the admin panel, and this file is the reason that guarantee holds: it does
 * not look at pending rows at all.
 *
 * The daily cap is counted from rows already posted today rather than from a
 * counter, so a restart, a double-triggered cron or a second instance cannot
 * lose track of it. Twenty a day to two networks is a lot of posting; the cap
 * exists to make the number one place to change rather than a property of how
 * often the cron happens to fire.
 */

async function graph(pathname: string, params: Record<string, string>, method: 'GET' | 'POST' = 'POST') {
  const body = new URLSearchParams(params);
  const url = method === 'GET' ? `${GRAPH}${pathname}?${body}` : `${GRAPH}${pathname}`;
  const res = await fetch(url, { method, ...(method === 'POST' ? { body } : {}) });
  const data: any = await res.json();
  if (!res.ok) throw new Error(`Graph ${data?.error?.code || res.status}: ${data?.error?.message || 'unknown'}`);
  return data;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function toInstagram(mediaUrl: string, caption: string, isVideo: boolean) {
  const igUser = process.env.IG_USER_ID!;
  const token = process.env.META_ACCESS_TOKEN!;

  const container = await graph(`/${igUser}/media`, {
    ...(isVideo ? { media_type: 'REELS', video_url: mediaUrl } : { image_url: mediaUrl }),
    caption,
    access_token: token,
  });

  // Video containers are transcoded before they can be published, and
  // publishing one still marked IN_PROGRESS fails with a message that does not
  // mention timing at all.
  if (isVideo) {
    for (let i = 0; i < 30; i++) {
      await sleep(4000);
      const { status_code } = await graph(`/${container.id}`, { fields: 'status_code', access_token: token }, 'GET');
      if (status_code === 'FINISHED') break;
      if (status_code === 'ERROR') throw new Error('Instagram could not process the video');
      if (i === 29) throw new Error('Instagram still processing after two minutes');
    }
  }

  const published = await graph(`/${igUser}/media_publish`, { creation_id: container.id, access_token: token });
  return `https://www.instagram.com/p/${published.id}`;
}

async function toFacebook(mediaUrl: string, caption: string, isVideo: boolean) {
  const page = process.env.FB_PAGE_ID!;
  const token = process.env.META_ACCESS_TOKEN!;

  const result = isVideo
    ? await graph(`/${page}/videos`, { file_url: mediaUrl, description: caption, access_token: token })
    : await graph(`/${page}/photos`, { url: mediaUrl, message: caption, access_token: token });

  return `https://www.facebook.com/${result.post_id || result.id}`;
}

export async function runSocialQueue() {
  if (!process.env.META_ACCESS_TOKEN || !process.env.IG_USER_ID || !process.env.FB_PAGE_ID) {
    return { skipped: 'Meta credentials are not configured' };
  }

  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  const postedToday = await prisma.socialPost.count({
    where: { status: 'posted', posted_at: { gte: startOfDay } },
  });

  const budget = DAILY_CAP - postedToday;
  if (budget <= 0) return { posted: 0, reason: `daily cap of ${DAILY_CAP} already reached` };

  const due = await prisma.socialPost.findMany({
    where: {
      status: 'approved',
      OR: [{ scheduled_for: null }, { scheduled_for: { lte: new Date() } }],
    },
    orderBy: [{ scheduled_for: 'asc' }, { created_at: 'asc' }],
    take: budget,
  });

  let posted = 0;
  let failed = 0;

  for (const post of due) {
    const targets = post.targets.split(',').map((t) => t.trim()).filter(Boolean);
    const links: { instagram_url?: string; facebook_url?: string } = {};

    try {
      for (const target of targets) {
        if (target === 'instagram') {
          links.instagram_url = await toInstagram(post.media_url, post.caption, post.is_video);
        } else if (target === 'facebook') {
          links.facebook_url = await toFacebook(post.media_url, post.caption, post.is_video);
        }
        // Meta rate-limits at roughly two calls a second; this is well under.
        await sleep(1000);
      }

      await prisma.socialPost.update({
        where: { id: post.id },
        data: { status: 'posted', posted_at: new Date(), error: null, ...links },
      });
      posted++;
    } catch (err: any) {
      // Marked failed rather than left approved, so the next run does not retry
      // it forever. Whatever did go out is recorded, so a partial send is
      // visible in the panel instead of being silently repeated.
      await prisma.socialPost.update({
        where: { id: post.id },
        data: { status: 'failed', error: String(err.message).slice(0, 500), ...links },
      });
      failed++;
      console.error(`[Social] ${post.slug} failed: ${err.message}`);
    }
  }

  return { posted, failed, cap: DAILY_CAP, remaining_today: Math.max(0, budget - posted) };
}
