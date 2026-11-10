// Pure scheduling-release rule for review batches. No imports (runs under plain Node tests).
//
// SAFETY: who publishes each platform once a row is 'pending' (status=pending, scheduled_for passed):
//   * facebook  → n8n "Facebook Daily Scheduled Publisher" (filter platform=eq.facebook) and, for
//                 same-day posts, the Facebook n8n webhook
//   * instagram → n8n "Instagram Scheduled Publisher" (filter platform=eq.instagram)
//   * linkedin / x → the app runner /api/publish/social-run (filters its own platforms)
// So a non-Facebook row must never become 'pending' unless that platform's switch is on, and only
// Facebook rows (or legacy rows with no platform) may ever be sent to the Facebook webhook.

export type ReleasePlatform = 'facebook' | 'instagram' | 'linkedin' | 'x';

/** Which platforms may be released to 'pending'. Facebook is always allowed. */
export type PublishingSwitches = { instagram: boolean; linkedin: boolean; x: boolean };

export interface ReleaseCandidate {
  id: string;
  status: string;
  platform?: string | null;
}

export interface ReleasePlan {
  /** client_approved rows to move to 'pending' */
  release: string[];
  /** Instagram rows kept at client_approved because Instagram publishing is off */
  heldInstagram: string[];
  /** Every row held back because its platform's publishing switch is off (includes heldInstagram) */
  held: string[];
  /**
   * What the batch should end as. It stays 'client_approved' (in "Ready to post") while any row is
   * held back, so it can be scheduled again once that platform is on. Re-scheduling only touches
   * rows that are still client_approved, so released rows are never released or sent twice.
   */
  batchStatus: 'scheduled' | 'client_approved';
}

export function platformOf(p: { platform?: string | null }): ReleasePlatform {
  const v = p.platform;
  return v === 'instagram' || v === 'linkedin' || v === 'x' ? v : 'facebook';
}

/** Accepts the old boolean (Instagram switch only; LinkedIn and X off) or the full switch set. */
function toSwitches(s: boolean | PublishingSwitches): PublishingSwitches {
  return typeof s === 'boolean' ? { instagram: s, linkedin: false, x: false } : s;
}

export function platformEnabled(platform: ReleasePlatform, switches: boolean | PublishingSwitches): boolean {
  if (platform === 'facebook') return true;
  return toSwitches(switches)[platform];
}

export function planScheduleRelease(posts: ReleaseCandidate[], switches: boolean | PublishingSwitches): ReleasePlan {
  const release: string[] = [];
  const heldInstagram: string[] = [];
  const held: string[] = [];
  for (const p of posts) {
    if (p.status !== 'client_approved') continue;
    const platform = platformOf(p);
    if (platformEnabled(platform, switches)) {
      release.push(p.id);
      continue;
    }
    held.push(p.id);
    if (platform === 'instagram') heldInstagram.push(p.id);
  }
  return { release, heldInstagram, held, batchStatus: held.length > 0 ? 'client_approved' : 'scheduled' };
}

/** Only Facebook rows (including legacy rows with no platform) may ever go to the Facebook n8n webhook. */
export function mayUseFacebookWebhook(post: { platform?: string | null }): boolean {
  return platformOf(post) === 'facebook';
}

/** Same-day release: which released rows go straight to the Facebook webhook. */
export function shouldSendSameDay(post: { platform?: string | null }, scheduledToday: boolean): boolean {
  return scheduledToday && mayUseFacebookWebhook(post);
}

const SWITCH_NAME: Record<Exclude<ReleasePlatform, 'facebook'>, string> = {
  instagram: 'Instagram', linkedin: 'LinkedIn', x: 'X',
};

/**
 * Direct (non-approval) scheduling via /api/posts. Non-Facebook rows are refused while their
 * platform's publishing is off; when on they are stored as 'pending' for that platform's publisher
 * and are never published immediately from this route and never use the Facebook webhook.
 */
export function directPostDecision(input: {
  platform: ReleasePlatform;
  publishNow: boolean;
  instagramEnabled: boolean;
  linkedinEnabled?: boolean;
  xEnabled?: boolean;
}): { ok: true; useWebhookIfSameDay: boolean } | { ok: false; status: number; error: string } {
  if (input.platform === 'facebook') return { ok: true, useWebhookIfSameDay: true };
  const on = input.platform === 'instagram' ? input.instagramEnabled
    : input.platform === 'linkedin' ? !!input.linkedinEnabled : !!input.xEnabled;
  const name = SWITCH_NAME[input.platform];
  if (!on) {
    return { ok: false, status: 409, error: `${name} publishing is not enabled yet. ${name} posts can be drafted through the approval workflow but not scheduled.` };
  }
  if (input.publishNow) return { ok: false, status: 400, error: `${name} posts cannot be published immediately; schedule them instead.` };
  return { ok: true, useWebhookIfSameDay: false };
}
