// Featured listing scheduling (pure). Max 3 concurrent 24h slots (first come, first served) and max 1 sponsored
// channel post per 24h. Mirrors public.fulfil_order() in supabase/migrations (the DB does the real booking under a lock).
import { FEATURED } from './plans.js';

const H = 3600000;
const live = (l) => l && (l.status === 'scheduled' || l.status === 'active');

/** Earliest start for a new booking given current listings (status scheduled|active, ends_at). */
export function nextStart(listings, now = Date.now(), max = FEATURED.maxConcurrent) {
  const ends = listings.filter(live).map((l) => Date.parse(l.ends_at)).filter((t) => t > now).sort((a, b) => a - b);
  if (ends.length < max) return now;
  return ends[ends.length - max]; // FIFO + equal durations: next slot frees when the (n-max+1)-th listing ends
}

/** Next allowed sponsored-post time: ≥ start and ≥ 24h after the latest planned/sent post. */
export function nextPostAt(listings, startsAt, perDay = FEATURED.maxPostsPerDay) {
  const gap = (24 * H) / Math.max(1, perDay);
  const last = Math.max(0, ...listings.filter((l) => l && l.status !== 'pulled' && (l.post_due_at || l.posted_at)).map((l) => Date.parse(l.posted_at || l.post_due_at) || 0));
  return Math.max(startsAt, last ? last + gap : 0);
}

/** Quote shown before paying. */
export function quote(listings, now = Date.now()) {
  const start = nextStart(listings, now);
  const end = start + FEATURED.hours * H;
  const postAt = nextPostAt(listings, start);
  const waitlisted = start > now;
  return { startsAt: new Date(start).toISOString(), endsAt: new Date(end).toISOString(), postAt: new Date(Math.min(postAt, end - H)).toISOString(), waitlisted, postInWindow: postAt <= end - H };
}

/** One CA can't hold two live slots at once. */
export const alreadyLive = (listings, ca) => listings.some((l) => live(l) && l.ca === ca);

/** Which listings change state now: scheduled→active, active→ended, and which posts are due (respecting the daily cap). */
export function tick(listings, now = Date.now()) {
  const activate = [], end = [], post = [];
  for (const l of listings) {
    if (l.status === 'scheduled' && Date.parse(l.starts_at) <= now && Date.parse(l.ends_at) > now) activate.push(l.id);
    if (live(l) && Date.parse(l.ends_at) <= now) end.push(l.id);
  }
  const lastPost = Math.max(0, ...listings.filter((l) => l.posted_at).map((l) => Date.parse(l.posted_at)));
  const due = listings.filter((l) => live(l) && !end.includes(l.id) && !l.posted_at && l.post_due_at && Date.parse(l.post_due_at) <= now && Date.parse(l.starts_at) <= now)
    .sort((a, b) => Date.parse(a.post_due_at) - Date.parse(b.post_due_at));
  if (due.length && now - lastPost >= 24 * H / FEATURED.maxPostsPerDay) post.push(due[0].id); // max 1 per tick and per day
  return { activate, end, post };
}
