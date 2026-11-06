// Email notifications. Transport, in order of preference:
//   1. Google Apps Script web app (apps-script/notification-mailer.gs) — MailApp from the deploying
//      Google account. Env: APPS_SCRIPT_MAIL_URL, APPS_SCRIPT_MAIL_SECRET, MAIL_SENDER_NAME (optional)
//   2. Resend REST API. Env: RESEND_API_KEY, RESEND_FROM_EMAIL (optional)
// If neither is configured, emails are skipped (logged) and the UI shows the review link to copy.
// APP_BASE_URL (optional) overrides the request origin used in links.

export type EmailResult = 'sent' | 'skipped' | 'failed';

const RESEND_FROM = process.env.RESEND_FROM_EMAIL || 'social@dashboard.ironmarkusa.com';
const SENDER_NAME = process.env.MAIL_SENDER_NAME || 'Ironmark';

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

async function sendViaAppsScript(url: string, to: string[], subject: string, html: string, replyTo: string[]): Promise<EmailResult> {
  const secret = process.env.APPS_SCRIPT_MAIL_SECRET;
  if (!secret) {
    console.error('[notify] APPS_SCRIPT_MAIL_URL set but APPS_SCRIPT_MAIL_SECRET missing');
    return 'failed';
  }
  try {
    // Apps Script answers POST with a 302 to script.googleusercontent.com; fetch follows it.
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret, to, subject, html, replyTo, senderName: SENDER_NAME }),
      redirect: 'follow',
      signal: AbortSignal.timeout(30000),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.ok) {
      console.error('[notify] Apps Script mailer error', res.status, data?.error);
      return 'failed';
    }
    return 'sent';
  } catch (err) {
    console.error('[notify] Apps Script request failed', err);
    return 'failed';
  }
}

async function sendEmail(to: string[], subject: string, html: string, replyTo: string[] = []): Promise<EmailResult> {
  if (to.length === 0) {
    console.warn(`[notify] no recipients for "${subject}"`);
    return 'skipped';
  }
  const scriptUrl = process.env.APPS_SCRIPT_MAIL_URL;
  if (scriptUrl) return sendViaAppsScript(scriptUrl, to, subject, html, replyTo);

  const key = process.env.RESEND_API_KEY;
  if (!key) {
    console.warn(`[notify] no email transport configured; email not sent: "${subject}"`);
    return 'skipped';
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: `${SENDER_NAME} <${RESEND_FROM}>`, to, subject, html,
        ...(replyTo.length ? { reply_to: replyTo } : {}),
      }),
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
  replyTo?: string[];  // internal team member(s), so client replies reach a person
}): Promise<EmailResult> {
  const expires = new Date(opts.expiresAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  const body = `<p>Hi ${escapeHtml(opts.clientName)} team,</p>
  <p>${opts.postCount} Facebook post${opts.postCount === 1 ? ' is' : 's are'} ready for your review. You'll see each post exactly as it will appear on Facebook, and you can edit the text directly before approving.</p>
  <p style="color:#65676b">This private link expires ${escapeHtml(expires)}. No login required. Please don't forward it.</p>`;
  return sendEmail(
    opts.to,
    `Please review your upcoming Facebook posts`,
    layout('Your Facebook posts are ready for review', body, opts.reviewUrl, 'Review & approve posts'),
    opts.replyTo || [],
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
