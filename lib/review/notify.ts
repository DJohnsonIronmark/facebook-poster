// Email notifications via Microsoft 365 (Microsoft Graph sendMail, app-only auth).
//
// Client-facing email is sent FROM the client's account manager (fb_clients.account_manager_email),
// so it lands in their Sent Items and client replies go straight to them. Internal alerts are sent
// from MS_NOTIFY_SENDER (a shared mailbox) when set, otherwise from the account manager.
//
// Env (server only):
//   MS_GRAPH_TENANT_ID, MS_GRAPH_CLIENT_ID, MS_GRAPH_CLIENT_SECRET  Entra app with Mail.Send (application)
//   MS_NOTIFY_SENDER          optional shared mailbox for internal alerts, e.g. social@ironmarkusa.com
//   MS_ALLOWED_SENDER_DOMAIN  optional, default ironmarkusa.com — app refuses to send as anyone else
//   APP_BASE_URL              optional; overrides request origin in links
//
// Mail.Send (application) can send as any mailbox in the tenant, so Exchange must scope the app
// to the account managers + shared mailbox (RBAC for Applications / ApplicationAccessPolicy).

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
  return (process.env.MS_ALLOWED_SENDER_DOMAIN || 'ironmarkusa.com').toLowerCase();
}

/** A mailbox the app may send as: valid address on the allowed M365 domain. */
export function isAllowedSender(email: string | null | undefined): email is string {
  if (!email) return false;
  const e = email.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.endsWith(`@${allowedSenderDomain()}`);
}

// ---- Graph auth (client credentials), cached per server instance ----
let cachedToken: { value: string; expiresAt: number } | null = null;

async function graphToken(): Promise<string | null> {
  const tenant = process.env.MS_GRAPH_TENANT_ID;
  const clientId = process.env.MS_GRAPH_CLIENT_ID;
  const secret = process.env.MS_GRAPH_CLIENT_SECRET;
  if (!tenant || !clientId || !secret) return null;
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.value;

  const res = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: secret,
      scope: 'https://graph.microsoft.com/.default',
      grant_type: 'client_credentials',
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    console.error('[notify] Graph token error', res.status, (await res.text()).slice(0, 300));
    return null;
  }
  const data = await res.json();
  cachedToken = { value: data.access_token, expiresAt: Date.now() + Number(data.expires_in || 3600) * 1000 };
  return cachedToken.value;
}

async function sendEmail(opts: {
  from: string | null | undefined; to: string[]; subject: string; html: string; replyTo?: string[]; cc?: (string | null | undefined)[];
}): Promise<EmailResult> {
  const { to, subject, html } = opts;
  // CC: Ironmark addresses only, never someone already sending/receiving this message
  const already = new Set([...to, opts.from || ''].map((e) => e.trim().toLowerCase()));
  const cc = Array.from(new Set((opts.cc || []).filter(isAllowedSender).map((e) => e.trim().toLowerCase())))
    .filter((e) => !already.has(e));
  if (to.length === 0) {
    console.warn(`[notify] no recipients for "${subject}"`);
    return 'skipped';
  }
  if (!isAllowedSender(opts.from)) {
    console.warn(`[notify] no allowed sender mailbox for "${subject}" (need an @${allowedSenderDomain()} address)`);
    return 'skipped';
  }
  let token: string | null;
  try {
    token = await graphToken();
  } catch (err) {
    console.error('[notify] Graph token request failed', err);
    return 'failed';
  }
  if (!token) {
    console.warn(`[notify] Microsoft Graph not configured; email not sent: "${subject}"`);
    return 'skipped';
  }

  const addr = (address: string) => ({ emailAddress: { address } });
  try {
    const res = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(opts.from.trim().toLowerCase())}/sendMail`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: {
          subject,
          body: { contentType: 'HTML', content: html },
          toRecipients: to.map(addr),
          ...(cc.length ? { ccRecipients: cc.map(addr) } : {}),
          ...(opts.replyTo?.length ? { replyTo: opts.replyTo.map(addr) } : {}),
        },
        saveToSentItems: true,
      }),
      signal: AbortSignal.timeout(20000),
    });
    if (res.status !== 202) {
      if (res.status === 401) cachedToken = null;
      console.error('[notify] Graph sendMail error', res.status, (await res.text()).slice(0, 300));
      return 'failed';
    }
    return 'sent';
  } catch (err) {
    console.error('[notify] Graph sendMail request failed', err);
    return 'failed';
  }
}

const internalSender = (accountManager?: string | null) =>
  isAllowedSender(process.env.MS_NOTIFY_SENDER) ? process.env.MS_NOTIFY_SENDER! : accountManager;

function layout(heading: string, body: string, ctaUrl: string, ctaLabel: string, footer: string): string {
  return `<div style="font-family:Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;color:#1c1e21">
  <h2 style="font-size:18px;margin:0 0 12px">${escapeHtml(heading)}</h2>
  ${body}
  <p style="margin:24px 0"><a href="${escapeHtml(ctaUrl)}" style="background:#1877f2;color:#fff;text-decoration:none;padding:10px 18px;border-radius:6px;font-weight:600">${escapeHtml(ctaLabel)}</a></p>
  <p style="font-size:12px;color:#65676b">${footer}</p>
</div>`;
}

/** Step 1: drafts uploaded → alert the internal team member(s) on the client */
export function notifyDraftsReady(opts: {
  to: string[]; accountManager?: string | null; clientName: string; batchName: string; postCount: number; uploadedBy: string; baseUrl: string;
}): Promise<EmailResult> {
  const body = `<p>${opts.postCount} drafted Facebook post${opts.postCount === 1 ? '' : 's'} for <strong>${escapeHtml(opts.clientName)}</strong> (${escapeHtml(opts.batchName)}) ${opts.postCount === 1 ? 'is' : 'are'} ready for internal review.</p>
  <p style="color:#65676b">Uploaded by ${escapeHtml(opts.uploadedBy)}</p>`;
  return sendEmail({
    from: internalSender(opts.accountManager),
    to: opts.to,
    cc: [opts.uploadedBy],  // implementation team member who uploaded the drafts
    subject: `Drafts ready for review: ${opts.clientName}`,
    html: layout('Facebook drafts ready for review', body, `${opts.baseUrl}/?tab=approvals`, 'Review drafts', 'Sent by the Ironmark Facebook Poster.'),
  });
}

/** Step 2: internal approval → email the client a review link, FROM their account manager */
export function notifyClientReview(opts: {
  to: string[]; accountManager: string | null; clientName: string; postCount: number; reviewUrl: string; expiresAt: string;
  cc?: (string | null | undefined)[];  // implementation team member(s) on the batch
}): Promise<EmailResult> {
  const expires = new Date(opts.expiresAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  const body = `<p>Hi ${escapeHtml(opts.clientName)} team,</p>
  <p>${opts.postCount} Facebook post${opts.postCount === 1 ? ' is' : 's are'} ready for your review. You'll see each post exactly as it will appear on Facebook, and you can edit the text directly before approving.</p>
  <p style="color:#65676b">This private link expires ${escapeHtml(expires)}. No login required. Please don't forward it. Questions? Just reply to this email.</p>`;
  return sendEmail({
    from: opts.accountManager,
    to: opts.to,
    cc: opts.cc,
    subject: 'Please review your upcoming Facebook posts',
    html: layout('Your Facebook posts are ready for review', body, opts.reviewUrl, 'Review & approve posts', 'Sent via Ironmark.'),
  });
}

/** Step 3: client approved final form → email the internal team member(s) on the client */
export function notifyClientApproved(opts: {
  to: string[]; accountManager?: string | null; clientName: string; batchName: string; postCount: number; editedCount: number; approvedBy: string; baseUrl: string;
  cc?: (string | null | undefined)[];  // implementation team member(s) who will finalize + schedule
}): Promise<EmailResult> {
  const body = `<p><strong>${escapeHtml(opts.clientName)}</strong> approved ${opts.postCount} post${opts.postCount === 1 ? '' : 's'} in ${escapeHtml(opts.batchName)}.</p>
  <p>${opts.editedCount} post${opts.editedCount === 1 ? ' was' : 's were'} edited by the client. Approved by: ${escapeHtml(opts.approvedBy)}</p>
  <p>Next step: confirm final copy and schedule.</p>`;
  return sendEmail({
    from: internalSender(opts.accountManager),
    to: opts.to,
    cc: opts.cc,
    subject: `Client approved: ${opts.clientName} Facebook posts`,
    html: layout('Client approved final posts', body, `${opts.baseUrl}/?tab=approvals`, 'Finalize & schedule', 'Sent by the Ironmark Facebook Poster.'),
  });
}
