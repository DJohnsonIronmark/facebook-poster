// Email notifications — STOPGAP: sent from a standard no-reply address via Resend (same provider
// as client-dashboard). The long-term home for this workflow is Ignition AI (CAM-NEXT-ORGSOC), which
// sends from its own SES no-reply sender.
//
// Client-facing emails set Reply-To = the client's account manager so replies still reach a person.
//
// Env (server only):
//   RESEND_API_KEY        Resend API key
//   MAIL_FROM             no-reply sender on a Resend-verified domain, e.g. "Ironmark <no-reply@dashboard.ironmarkusa.com>"
//   INTERNAL_EMAIL_DOMAIN optional, default ironmarkusa.com — account managers / CCs must be on it
//   APP_BASE_URL          optional; overrides request origin in links
// If RESEND_API_KEY or MAIL_FROM is missing, emails are skipped (logged) and the UI shows the link to copy.

export type EmailResult = 'sent' | 'skipped' | 'failed';

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

export function allowedSenderDomain(): string {
  return (process.env.INTERNAL_EMAIL_DOMAIN || 'ironmarkusa.com').toLowerCase();
}

/** An Ironmark address (account managers, internal CCs): valid email on the internal domain. */
export function isAllowedSender(email: string | null | undefined): email is string {
  if (!email) return false;
  const e = email.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.endsWith(`@${allowedSenderDomain()}`);
}

async function sendEmail(opts: {
  to: (string | null | undefined)[]; subject: string; html: string;
  replyTo?: (string | null | undefined)[]; cc?: (string | null | undefined)[];
}): Promise<EmailResult> {
  const { subject, html } = opts;
  const clean = (list?: (string | null | undefined)[]) =>
    Array.from(new Set((list || []).filter((e): e is string => !!e).map((e) => e.trim().toLowerCase())))
      .filter((e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));
  const to = clean(opts.to);
  // CC: Ironmark addresses only, never someone already receiving this message
  const cc = clean(opts.cc).filter((e) => isAllowedSender(e) && !to.includes(e));
  const replyTo = clean(opts.replyTo).filter(isAllowedSender);

  if (to.length === 0) {
    console.warn(`[notify] no recipients for "${subject}"`);
    return 'skipped';
  }
  const key = process.env.RESEND_API_KEY;
  const from = process.env.MAIL_FROM;
  if (!key || !from) {
    console.warn(`[notify] RESEND_API_KEY / MAIL_FROM not set; email not sent: "${subject}"`);
    return 'skipped';
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from, to, subject, html,
        ...(cc.length ? { cc } : {}),
        ...(replyTo.length ? { reply_to: replyTo } : {}),
      }),
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) {
      console.error('[notify] Resend error', res.status, (await res.text()).slice(0, 300));
      return 'failed';
    }
    return 'sent';
  } catch (err) {
    console.error('[notify] Resend request failed', err);
    return 'failed';
  }
}

function layout(heading: string, body: string, ctaUrl: string, ctaLabel: string, footer: string): string {
  return `<div style="font-family:Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;color:#1c1e21">
  <h2 style="font-size:18px;margin:0 0 12px">${escapeHtml(heading)}</h2>
  ${body}
  <p style="margin:24px 0"><a href="${escapeHtml(ctaUrl)}" style="background:#1877f2;color:#fff;text-decoration:none;padding:10px 18px;border-radius:6px;font-weight:600">${escapeHtml(ctaLabel)}</a></p>
  <p style="font-size:12px;color:#65676b">${footer}</p>
</div>`;
}

/** Step 1: team member uploaded first drafts → account manager reviews (cc the uploader) */
export function notifyDraftsReady(opts: {
  accountManager: string | null; clientName: string; batchName: string; postCount: number; uploadedBy: string; baseUrl: string;
}): Promise<EmailResult> {
  const body = `<p>${opts.postCount} first-draft Facebook post${opts.postCount === 1 ? '' : 's'} for <strong>${escapeHtml(opts.clientName)}</strong> (${escapeHtml(opts.batchName)}) ${opts.postCount === 1 ? 'is' : 'are'} ready for your review.</p>
  <p>Review and edit as needed, then approve to send ${opts.postCount === 1 ? 'it' : 'them'} to the client.</p>
  <p style="color:#65676b">Uploaded by ${escapeHtml(opts.uploadedBy)}</p>`;
  return sendEmail({
    to: isAllowedSender(opts.accountManager) ? [opts.accountManager] : [],
    cc: [opts.uploadedBy],
    subject: `Drafts ready for your review: ${opts.clientName}`,
    html: layout('Facebook drafts ready for account manager review', body, `${opts.baseUrl}/?tab=approvals`, 'Review drafts',
      'Sent by the Ironmark Facebook Poster. This mailbox is not monitored.'),
  });
}

/** Step 2: account manager approved → email the client a review link (Reply-To: account manager) */
export function notifyClientReview(opts: {
  to: string[]; accountManager: string | null; clientName: string; postCount: number; reviewUrl: string; expiresAt: string;
  cc?: (string | null | undefined)[];  // implementation team member(s) on the batch
}): Promise<EmailResult> {
  const expires = new Date(opts.expiresAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  const body = `<p>Hi ${escapeHtml(opts.clientName)} team,</p>
  <p>${opts.postCount} Facebook post${opts.postCount === 1 ? ' is' : 's are'} ready for your review. You'll see each post exactly as it will appear on Facebook, and you can edit the text directly before approving.</p>
  <p style="color:#65676b">This private link expires ${escapeHtml(expires)}. No login required. Please don't forward it. Questions? Reply to this email and it will reach your account manager.</p>`;
  return sendEmail({
    to: opts.to,
    cc: opts.cc,
    replyTo: [opts.accountManager],
    subject: 'Please review your upcoming Facebook posts',
    html: layout('Your Facebook posts are ready for review', body, opts.reviewUrl, 'Review & approve posts', 'Sent via Ironmark.'),
  });
}

/**
 * Step 3: client approved → "Confirmed: ready to post" to the client AND the account manager,
 * cc the internal team member (uploader). Reply-To: account manager. Client-facing wording.
 */
export function notifyReadyToPost(opts: {
  clientEmails: string[]; accountManager: string | null; uploadedBy?: string | null;
  clientName: string; approvedBy: string; reviewUrl?: string | null;
  posts: { franchise_name: string; scheduled_for: string | null; post_content: string }[];
}): Promise<EmailResult> {
  const when = (d: string | null) =>
    d ? new Date(d).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York', timeZoneName: 'short' }) : 'Date to be confirmed';
  const rows = opts.posts.slice(0, 50).map((p) => {
    const snippet = p.post_content.length > 90 ? `${p.post_content.slice(0, 90)}…` : p.post_content;
    return `<tr><td style="padding:6px 8px;border-top:1px solid #e4e6eb;vertical-align:top">${escapeHtml(p.franchise_name)}</td>
      <td style="padding:6px 8px;border-top:1px solid #e4e6eb;vertical-align:top;white-space:nowrap">${escapeHtml(when(p.scheduled_for))}</td>
      <td style="padding:6px 8px;border-top:1px solid #e4e6eb;vertical-align:top;color:#65676b">${escapeHtml(snippet)}</td></tr>`;
  }).join('');
  const more = opts.posts.length > 50 ? `<p style="color:#65676b">…and ${opts.posts.length - 50} more.</p>` : '';
  const body = `<p>Thanks! ${opts.posts.length} Facebook post${opts.posts.length === 1 ? ' is' : 's are'} approved by ${escapeHtml(opts.approvedBy)} and confirmed ready to post. Our team will schedule ${opts.posts.length === 1 ? 'it' : 'them'} for publication at the planned times.</p>
  <table style="border-collapse:collapse;font-size:13px;width:100%"><thead><tr style="text-align:left;color:#65676b">
    <th style="padding:6px 8px">Page</th><th style="padding:6px 8px">Planned</th><th style="padding:6px 8px">Post</th></tr></thead>
    <tbody>${rows}</tbody></table>${more}`;
  const html = opts.reviewUrl
    ? layout('Confirmed: ready to post', body, opts.reviewUrl, 'View approved posts', 'Sent via Ironmark. Questions? Reply to this email and it will reach your account manager.')
    : `<div style="font-family:Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;color:#1c1e21"><h2 style="font-size:18px;margin:0 0 12px">Confirmed: ready to post</h2>${body}</div>`;
  return sendEmail({
    to: [...opts.clientEmails, isAllowedSender(opts.accountManager) ? opts.accountManager : null],
    cc: [opts.uploadedBy],
    replyTo: [opts.accountManager],
    subject: 'Confirmed: your Facebook posts are ready to post',
    html,
  });
}
