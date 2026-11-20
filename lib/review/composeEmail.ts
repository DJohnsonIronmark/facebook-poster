// "Send from Outlook" (Option A): build pre-filled emails that open in the user's OWN mailbox,
// so each step's email goes from the account manager / team member who clicks — no Microsoft Graph
// app, no sending domain. Plain text only (compose links can't carry HTML). Pure module: no imports.

export interface ComposeEmail {
  to: string[];
  cc: string[];
  subject: string;
  body: string;
}

// Compose links ride in a URL; keep the body well under common URL limits (~2,000 chars total).
const MAX_BODY = 1500;

function cleanList(list: (string | null | undefined)[], exclude: string[] = []): string[] {
  const skip = new Set(exclude.map((e) => e.toLowerCase()));
  const out: string[] = [];
  for (const raw of list) {
    const e = (raw || '').trim().toLowerCase();
    if (!/^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(e) || skip.has(e) || out.includes(e)) continue;
    out.push(e);
  }
  return out;
}

function clip(body: string): string {
  if (body.length <= MAX_BODY) return body;
  return `${body.slice(0, MAX_BODY - 60).trimEnd()}\n…\n(List shortened. See the full list in the app.)`;
}

/** Outlook on the web compose deeplink (Microsoft 365). */
export function outlookComposeUrl(e: ComposeEmail): string {
  const p = new URLSearchParams();
  if (e.to.length) p.set('to', e.to.join(','));
  if (e.cc.length) p.set('cc', e.cc.join(','));
  p.set('subject', e.subject);
  p.set('body', e.body);
  // URLSearchParams encodes spaces as '+'; Outlook expects %20
  return `https://outlook.office.com/mail/deeplink/compose?${p.toString().replace(/\+/g, '%20')}`;
}

/** Standard mailto: link for the default desktop mail app. */
export function mailtoUrl(e: ComposeEmail): string {
  const q = [
    e.cc.length ? `cc=${encodeURIComponent(e.cc.join(','))}` : '',
    `subject=${encodeURIComponent(e.subject)}`,
    `body=${encodeURIComponent(e.body)}`,
  ].filter(Boolean).join('&');
  return `mailto:${e.to.map(encodeURIComponent).join(',')}?${q}`;
}

/** Step 1: drafts uploaded → tell the account manager (cc the uploader). */
export function draftsReadyEmail(opts: {
  accountManager: string | null | undefined; uploadedBy: string | null | undefined;
  clientName: string; batchName: string; postCount: number; appUrl: string;
}): ComposeEmail {
  const to = cleanList([opts.accountManager]);
  return {
    to,
    cc: cleanList([opts.uploadedBy], to),
    subject: `Drafts ready for your review: ${opts.clientName}`,
    body: clip(
      `Hi,\n\n${opts.postCount} first-draft Facebook post${opts.postCount === 1 ? '' : 's'} for ${opts.clientName} (${opts.batchName}) ` +
      `${opts.postCount === 1 ? 'is' : 'are'} ready for your review.\n\nReview and edit as needed, then approve to send ` +
      `${opts.postCount === 1 ? 'it' : 'them'} to the client:\n${opts.appUrl}/?tab=approvals\n\nThanks`,
    ),
  };
}

/** Step 2: account manager approved → send the client their private review link. */
export function clientReviewEmail(opts: {
  clientEmails: string[]; accountManager: string | null | undefined; uploadedBy: string | null | undefined;
  clientName: string; postCount: number; reviewUrl: string; expiresAt?: string | null;
}): ComposeEmail {
  const to = cleanList(opts.clientEmails);
  const expires = opts.expiresAt
    ? new Date(opts.expiresAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
    : null;
  return {
    to,
    cc: cleanList([opts.uploadedBy], [...to, opts.accountManager || '']),
    subject: 'Please review your upcoming Facebook posts',
    body: clip(
      `Hi ${opts.clientName} team,\n\n${opts.postCount} Facebook post${opts.postCount === 1 ? ' is' : 's are'} ready for your review. ` +
      `You'll see each post exactly as it will appear on Facebook, and you can edit the text before approving.\n\n` +
      `Review & approve: ${opts.reviewUrl}\n\n` +
      `${expires ? `This private link expires ${expires}. ` : ''}No login required. Please don't forward it.\n\nThanks`,
    ),
  };
}

/** Step 3: client approved → "ready to post" confirmation to the client, cc the AM and uploader. */
export function readyToPostEmail(opts: {
  clientEmails: string[]; accountManager: string | null | undefined; uploadedBy: string | null | undefined;
  clientName: string; approvedBy: string | null | undefined;
  posts: { franchise_name: string; scheduled_for: string | null; post_content: string }[];
}): ComposeEmail {
  const to = cleanList(opts.clientEmails);
  const when = (d: string | null) =>
    d
      ? new Date(d).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York', timeZoneName: 'short' })
      : 'date to be confirmed';
  const lines = opts.posts.map((p) => {
    const snippet = p.post_content.replace(/\s+/g, ' ').trim();
    return `- ${p.franchise_name}, ${when(p.scheduled_for)}: ${snippet.length > 70 ? `${snippet.slice(0, 70)}…` : snippet}`;
  });
  return {
    to,
    cc: cleanList([opts.accountManager, opts.uploadedBy], to),
    subject: 'Confirmed: your Facebook posts are ready to post',
    body: clip(
      `Hi ${opts.clientName} team,\n\nThanks! ${opts.posts.length} Facebook post${opts.posts.length === 1 ? ' is' : 's are'} ` +
      `${opts.approvedBy ? `approved by ${opts.approvedBy} and ` : ''}confirmed ready to post. We'll schedule ` +
      `${opts.posts.length === 1 ? 'it' : 'them'} for publication at the planned times:\n\n${lines.join('\n')}\n\nThanks`,
    ),
  };
}
