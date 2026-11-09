// Pure scheduling-release rule for review batches. No imports (runs under plain Node tests).
//
// SAFETY: the live n8n "Facebook Daily Scheduled Publisher" fetches every row with
// status=eq.pending AND scheduled_for not null, with no platform filter, and posts it to Facebook.
// Same-day rows are sent to the Facebook n8n webhook. So, until an Instagram publisher exists:
//   * an Instagram row must never become 'pending' unless INSTAGRAM_PUBLISHING_ENABLED is on, and
//   * an Instagram row is never sent to the Facebook webhook, whatever the switch says.

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
  /**
   * What the batch should end as. It stays 'client_approved' (in "Ready to post") while any
   * Instagram row is held back, so it can be scheduled again once Instagram publishing is on.
   * Re-scheduling only touches rows that are still client_approved, so released Facebook rows
   * are never released or sent twice.
   */
  batchStatus: 'scheduled' | 'client_approved';
}

const isInstagram = (p: { platform?: string | null }) => p.platform === 'instagram';

export function planScheduleRelease(posts: ReleaseCandidate[], instagramEnabled: boolean): ReleasePlan {
  const release: string[] = [];
  const heldInstagram: string[] = [];
  for (const p of posts) {
    if (p.status !== 'client_approved') continue;
    if (isInstagram(p) && !instagramEnabled) heldInstagram.push(p.id);
    else release.push(p.id);
  }
  return { release, heldInstagram, batchStatus: heldInstagram.length > 0 ? 'client_approved' : 'scheduled' };
}

/** Only Facebook rows (including legacy rows with no platform) may ever go to the Facebook n8n webhook. */
export function mayUseFacebookWebhook(post: { platform?: string | null }): boolean {
  return !isInstagram(post);
}

/** Same-day release: which released rows go straight to the Facebook webhook. */
export function shouldSendSameDay(post: { platform?: string | null }, scheduledToday: boolean): boolean {
  return scheduledToday && mayUseFacebookWebhook(post);
}

/**
 * Direct (non-approval) scheduling via /api/posts. Instagram rows are refused while publishing is
 * off; when on they are stored as 'pending' for the future n8n Instagram branch but are never
 * published immediately (no Instagram publisher exists in the app) and never use the webhook.
 */
export function directPostDecision(input: { platform: 'facebook' | 'instagram'; publishNow: boolean; instagramEnabled: boolean }):
  { ok: true; useWebhookIfSameDay: boolean } | { ok: false; status: number; error: string } {
  if (input.platform !== 'instagram') return { ok: true, useWebhookIfSameDay: true };
  if (!input.instagramEnabled) {
    return { ok: false, status: 409, error: 'Instagram publishing is not enabled yet. Instagram posts can be drafted through the approval workflow but not scheduled.' };
  }
  if (input.publishNow) return { ok: false, status: 400, error: 'Instagram posts cannot be published immediately; schedule them instead.' };
  return { ok: true, useWebhookIfSameDay: false };
}
