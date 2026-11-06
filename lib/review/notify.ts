// Email notifications via Resend's REST API (same provider as client-dashboard).
// Env: RESEND_API_KEY, RESEND_FROM_EMAIL (optional), APP_BASE_URL (optional; falls back to request origin)

export type EmailResult = 'sent' | 'skipped' | 'failed';

const RESEND_FROM = process.env.RESEND_FROM_EMAIL || 'social@dashboard.ironmarkusa.com';

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function appBaseUrl(request: Request): string {
  if (process.env.APP_BASE_URL) return process.env.APP_BASE_URL.replace(/\/$/, '');
  return new URL(request.url).origin;
}

export function validEmails(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  return list
    .map((e) => String(e).trim().toLowerCase())
    .filter((e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));
}

async function sendEmail(to: string[], subject: string, html: string): Promise<EmailResult> {
  if (to.length === 0) {
    console.warn(`[notify] no recipients for "${subject}"`);
    return 'skipped';
  }
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    console.warn(`[notify] RESEND_API_KEY not set; email not sent: "${subject}"`);
    return 'skipped';
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: RESEND_FROM, to, subject, html }),
    });
    if (!res.ok) {
      console.error('[notify] Resend error', res.status, await res.text());
      return 'failed';
    }
    return 'sent';
  } catch (err) {
    console.error('[notify] Resend request failed', err);
    return 'failed';
  }
}

function layout(heading: string, body: string, ctaUrl: string, ctaLabel: string): string {
  return `<div style="font-family:Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;color:#1c1e21">
  <h2 style="font-size:18px;margin:0 0 12px">${escapeHtml(heading)}</h2>
  ${body}
  <p style="margin:24px 0"><a href="${escapeHtml(ctaUrl)}" style="background:#1877f2;color:#fff;text-decoration:none;padding:10px 18px;border-radius:6px;font-weight:600">${escapeHtml(ctaLabel)}</a></p>
  <p style="font-size:12px;color:#65676b">Sent by the Ironmark Facebook Poster.</p>
</div>`;
}

/** Step 1: drafts uploaded → alert the internal team member(s) on the client */
export function notifyDraftsReady(opts: {
  to: string[]; clientName: string; batchName: string; postCount: number; uploadedBy: string; baseUrl: string;
}): Promise<EmailResult> {
  const body = `<p>${opts.postCount} drafted Facebook post${opts.postCount === 1 ? '' : 's'} for <strong>${escapeHtml(opts.clientName)}</strong> (${escapeHtml(opts.batchName)}) ${opts.postCount === 1 ? 'is' : 'are'} ready for internal review.</p>
  <p style="color:#65676b">Uploaded by ${escapeHtml(opts.uploadedBy)}</p>`;
  return sendEmail(
    opts.to,
    `Drafts ready for review: ${opts.clientName}`,
    layout('Facebook drafts ready for review', body, `${opts.baseUrl}/?tab=approvals`, 'Review drafts'),
  );
}

/** Step 2: internal approval → email the client a review link */
export function notifyClientReview(opts: {
  to: string[]; clientName: string; postCount: number; reviewUrl: string; expiresAt: string;
}): Promise<EmailResult> {
  const expires = new Date(opts.expiresAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  const body = `<p>Hi ${escapeHtml(opts.clientName)} team,</p>
  <p>${opts.postCount} Facebook post${opts.postCount === 1 ? ' is' : 's are'} ready for your review. You'll see each post exactly as it will appear on Facebook, and you can edit the text directly before approving.</p>
  <p style="color:#65676b">This private link expires ${escapeHtml(expires)}. No login required. Please don't forward it.</p>`;
  return sendEmail(
    opts.to,
    `Please review your upcoming Facebook posts`,
    layout('Your Facebook posts are ready for review', body, opts.reviewUrl, 'Review & approve posts'),
  );
}

/** Step 3: client approved final form → email the internal team member(s) on the client */
export function notifyClientApproved(opts: {
  to: string[]; clientName: string; batchName: string; postCount: number; editedCount: number; approvedBy: string; baseUrl: string;
}): Promise<EmailResult> {
  const body = `<p><strong>${escapeHtml(opts.clientName)}</strong> approved ${opts.postCount} post${opts.postCount === 1 ? '' : 's'} in ${escapeHtml(opts.batchName)}.</p>
  <p>${opts.editedCount} post${opts.editedCount === 1 ? ' was' : 's were'} edited by the client. Approved by: ${escapeHtml(opts.approvedBy)}</p>
  <p>Next step: confirm final copy and schedule.</p>`;
  return sendEmail(
    opts.to,
    `Client approved: ${opts.clientName} Facebook posts`,
    layout('Client approved final posts', body, `${opts.baseUrl}/?tab=approvals`, 'Finalize & schedule'),
  );
}
