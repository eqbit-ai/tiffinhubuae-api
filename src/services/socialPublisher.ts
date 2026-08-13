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

  // Wait for the container to be ready — for images as well as video.
  //
  // Publishing an image container immediately fails with "Graph 9007: Media ID
  // is not available", which reads like a bad id and is really a timing
  // problem: Instagram has to fetch the image from its URL before the container
  // can be published. Video is slower because it also transcodes, but neither is
  // instant, and only polling for video is what made the first real publish
  // fail.
  const tries = isVideo ? 30 : 12;
  const gap = isVideo ? 4000 : 2000;
  for (let i = 0; i < tries; i++) {
    await sleep(gap);
    const { status_code } = await graph(`/${container.id}`, { fields: 'status_code', access_token: token }, 'GET');
    if (status_code === 'FINISHED') break;
    if (status_code === 'ERROR') throw new Error(`Instagram could not process the ${isVideo ? 'video' : 'image'}`);
    if (i === tries - 1) {
      throw new Error(`Instagram still processing after ${Math.round((tries * gap) / 1000)}s`);
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

/**
 * How many go out in a single run.
 *
 * The daily cap alone is not pacing. With a cap of 20 and an empty day, one run
 * would take all 20 approved posts and fire them back to back — which is
 * exactly the burst the hourly schedule was meant to avoid. Two per run, every
 * fifteen minutes, spreads a full day's worth across the waking hours and still
 * gets the first post out within a quarter of an hour of approving it.
 */
const PER_RUN = Number(process.env.SOCIAL_PER_RUN || 2);

/**
 * Sends one approved post. Shared by the scheduled run and the "Publish now"
 * button, so both take exactly the same path — a manual publish that skipped
 * the cap or the status guards would be a second, untested way to post.
 */
export async function publishPost(post: {
  id: string; slug: string; media_url: string; caption: string; is_video: boolean; targets: string;
}) {
  const targets = post.targets.split(',').map((t) => t.trim()).filter(Boolean);
  const links: { instagram_url?: string; facebook_url?: string } = {};

  try {
    for (const target of targets) {
      if (target === 'instagram') {
        links.instagram_url = await toInstagram(post.media_url, post.caption, post.is_video);
      } else if (target === 'facebook') {
        links.facebook_url = await toFacebook(post.media_url, post.caption, post.is_video);
      }
      await sleep(1000);
    }
    await prisma.socialPost.update({
      where: { id: post.id },
      data: { status: 'posted', posted_at: new Date(), error: null, ...links },
    });
    return { ok: true as const, links };
  } catch (err: any) {
    // Marked failed rather than left approved, so the next run does not retry it
    // forever. Whatever did go out is recorded, so a partial send is visible in
    // the panel instead of being silently repeated.
    await prisma.socialPost.update({
      where: { id: post.id },
      data: { status: 'failed', error: String(err.message).slice(0, 500), ...links },
    });
    console.error(`[Social] ${post.slug} failed: ${err.message}`);
    return { ok: false as const, reason: String(err.message) };
  }
}

/** Posts already sent today, for the cap. Counted from rows, never a counter. */
export async function postedToday() {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  return prisma.socialPost.count({ where: { status: 'posted', posted_at: { gte: startOfDay } } });
}

export function credentialsConfigured() {
  return !!(process.env.META_ACCESS_TOKEN && process.env.IG_USER_ID && process.env.FB_PAGE_ID);
}

export async function runSocialQueue() {
  if (!credentialsConfigured()) {
    return { skipped: 'Meta credentials are not configured' };
  }

  const alreadyToday = await postedToday();
  const budget = Math.min(PER_RUN, DAILY_CAP - alreadyToday);
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
    const result = await publishPost(post);
    if (result.ok) posted++; else failed++;
  }

  return {
    posted,
    failed,
    per_run: PER_RUN,
    cap: DAILY_CAP,
    remaining_today: Math.max(0, DAILY_CAP - alreadyToday - posted),
  };
}
