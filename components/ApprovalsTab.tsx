'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import FacebookPostPreview from './FacebookPostPreview';
import InstagramPostPreview from './InstagramPostPreview';
import PlatformBadge from './PlatformBadge';
import IgCaptionMeter from './IgCaptionMeter';
import LinkedInPostPreview from './LinkedInPostPreview';
import XPostPreview from './XPostPreview';
import SocialTextMeter from './SocialTextMeter';
import ReplaceMediaButton from './ReplaceMediaButton';
import DeviceToggle from './DeviceToggle';
import ClientSettings from './ClientSettings';
import type { ReviewBatch, ReviewPost } from '@/lib/review/types';
import { groupPosts } from '@/lib/review/grouping';
import { validateIgCaption, PLATFORM_LABEL, rowPlatform } from '@/lib/instagram/rules';
import { countByPlatform, platformCountPhrase, platformPublishingOn, socialTextIssues, SOCIAL_STATUS_OFF, type SocialStatus } from '@/lib/social/ui';
import { downloadCSV, formatScheduledDate, parseCSVObjects, parseScheduledDate, toCSV } from '@/lib/csv';
import {
  type ComposeEmail, clientReviewEmail, draftsReadyEmail, mailtoUrl, outlookComposeUrl, readyToPostEmail,
} from '@/lib/review/composeEmail';

/** "Send from Outlook" (Option A): opens a pre-filled email in the user's own mailbox. */
function ComposeButtons({ email, label }: { email: ComposeEmail; label: string }) {
  if (email.to.length === 0) {
    return <span className="text-xs text-gray-500">No recipients set. Add them under Client settings.</span>;
  }
  return (
    <span className="inline-flex items-center gap-1">
      <a href={outlookComposeUrl(email)} target="_blank" rel="noopener noreferrer"
        title={`To: ${email.to.join(', ')}${email.cc.length ? ` · Cc: ${email.cc.join(', ')}` : ''}`}
        className="px-3 py-1.5 text-sm rounded-lg bg-[#0f6cbd] text-white hover:bg-[#115ea3]">
        {label}
      </a>
      <a href={mailtoUrl(email)} className="px-2 py-1.5 text-xs rounded-lg text-gray-600 hover:bg-gray-100" title="Open in your default mail app instead">
        Mail app
      </a>
    </span>
  );
}

type Stage = 'internal_review' | 'client_review' | 'client_approved';

const STAGES: { key: Stage; label: string; hint: string }[] = [
  { key: 'internal_review', label: 'Account manager review', hint: 'First drafts waiting on the account manager' },
  { key: 'client_review', label: 'With client', hint: 'Client has the review link' },
  { key: 'client_approved', label: 'Ready to post', hint: 'Client approved: upload final posts and schedule' },
];

// 'platform' is informational (read-only): the import is keyed by post_id and ignores it
const FINAL_HEADERS = ['post_id', 'platform', 'client', 'location_number', 'location_name', 'post_content', 'link_url', 'media_url', 'scheduled_for', 'client_comment'];

interface Props {
  canEdit: boolean;   // admin/manager
  isAdmin: boolean;
  userEmail: string | null;
  onScheduled: () => void;
}

export default function ApprovalsTab({ canEdit, isAdmin, userEmail, onScheduled }: Props) {
  const [batches, setBatches] = useState<ReviewBatch[]>([]);
  const [loading, setLoading] = useState(true);
  const [stage, setStage] = useState<Stage>('internal_review');
  const [openId, setOpenId] = useState<string | null>(null);
  const [device, setDevice] = useState<'desktop' | 'mobile'>('desktop');
  const [banner, setBanner] = useState<{ kind: 'ok' | 'error'; text: string; link?: string; compose?: ComposeEmail } | null>(null);
  const [showClients, setShowClients] = useState(false);
  const [igEnabled, setIgEnabled] = useState(false);
  // Publishing switches from GET /api/review/batches (publishing_enabled: { instagram, linkedin, x })
  const [socialStatus, setSocialStatus] = useState<SocialStatus | null>(null);
  const finalInputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/review/batches', { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load approvals');
      setBatches(data.batches || []);
      setIgEnabled(data.instagram_publishing_enabled === true);
      const pe = data.publishing_enabled && typeof data.publishing_enabled === 'object' ? data.publishing_enabled : null;
      setSocialStatus(pe ? {
        ...SOCIAL_STATUS_OFF,
        instagram: { enabled: pe.instagram === true },
        linkedin: { enabled: pe.linkedin === true, configured: false },
        x: { enabled: pe.x === true, configured: false },
      } : null);
    } catch (e) {
      setBanner({ kind: 'error', text: e instanceof Error ? e.message : 'Failed to load approvals' });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const byStage = useMemo(() => {
    const m: Record<Stage, ReviewBatch[]> = { internal_review: [], client_review: [], client_approved: [] };
    for (const b of batches) if (b.status in m) m[b.status as Stage].push(b);
    return m;
  }, [batches]);

  const act = async (batch: ReviewBatch, action: string, extra: Record<string, unknown> = {}) => {
    setBanner(null);
    const res = await fetch(`/api/review/batches/${batch.id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, ...extra }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setBanner({ kind: 'error', text: data.error || 'Action failed' });
      return null;
    }
    return data;
  };


  // ---------- final-form bulk export / upload across all client-approved batches ----------
  const exportFinal = () => {
    // Only posts still waiting to be scheduled (a batch can hold posts for a platform whose publishing is off
    // after its Facebook posts went out). Instagram and X never take link_url.
    const rows = byStage.client_approved.flatMap((b) =>
      (b.posts || []).filter((p) => p.status === 'client_approved').map((p) => [
        p.id, p.platform || 'facebook', b.client?.name || '', p.location_number, p.franchise_name, p.post_content,
        p.platform === 'instagram' || p.platform === 'x' ? '' : p.link_url, p.media_url, formatScheduledDate(p.scheduled_for), p.client_comment,
      ]),
    );
    downloadCSV(`facebook_final_posts_${new Date().toISOString().slice(0, 10)}.csv`, toCSV(FINAL_HEADERS, rows));
  };

  const uploadFinal = async (file: File) => {
    setBanner(null);
    const rows = parseCSVObjects(await file.text());
    if (rows.length === 0 || !('post_id' in rows[0])) {
      setBanner({ kind: 'error', text: 'CSV needs a post_id column. Start from "Export approved posts".' });
      return;
    }
    const batchOfPost = new Map<string, ReviewBatch>();
    byStage.client_approved.forEach((b) => (b.posts || []).forEach((p) => batchOfPost.set(p.id, b)));

    const grouped = new Map<string, { batch: ReviewBatch; rows: Record<string, unknown>[] }>();
    const problems: string[] = [];
    rows.forEach((r, i) => {
      const b = batchOfPost.get(r.post_id);
      if (!b) { problems.push(`Row ${i + 2}: post ${r.post_id || '(blank)'} is not in a client-approved batch`); return; }
      const scheduled = r.scheduled_for ? parseScheduledDate(r.scheduled_for) : undefined;
      if (r.scheduled_for && !scheduled) { problems.push(`Row ${i + 2}: can't read date "${r.scheduled_for}"`); return; }
      const g = grouped.get(b.id) || { batch: b, rows: [] };
      g.rows.push({ post_id: r.post_id, post_content: r.post_content, link_url: r.link_url, media_url: r.media_url, scheduled_for: scheduled });
      grouped.set(b.id, g);
    });

    let updated = 0;
    for (const { batch, rows: bRows } of Array.from(grouped.values())) {
      const data = await act(batch, 'final_upload', { rows: bRows });
      if (data) { updated += data.updated; problems.push(...(data.problems || []).map((p: string) => `${batch.name}: ${p}`)); }
    }
    await load();
    setBanner({
      kind: problems.length ? 'error' : 'ok',
      text: `Updated ${updated} post(s) from ${file.name}.${problems.length ? ` ${problems.length} issue(s): ${problems.slice(0, 5).join('; ')}${problems.length > 5 ? '…' : ''}` : ' Review the previews, then schedule.'}`,
    });
  };

  const counts = { internal_review: byStage.internal_review.length, client_review: byStage.client_review.length, client_approved: byStage.client_approved.length };

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="inline-flex rounded-lg bg-white shadow-sm p-1" role="tablist">
          {STAGES.map((s) => (
            <button key={s.key} role="tab" aria-selected={stage === s.key} title={s.hint}
              onClick={() => setStage(s.key)}
              className={`px-3 py-1.5 rounded-md text-sm font-medium ${stage === s.key ? 'bg-blue-600 text-white' : 'text-gray-600 hover:bg-gray-100'}`}>
              {s.label} <span className="opacity-75">({counts[s.key]})</span>
            </button>
          ))}
        </div>
        <DeviceToggle value={device} onChange={setDevice} />
        <div className="ml-auto flex gap-2">
          <button onClick={load} className="px-3 py-1.5 text-sm rounded-lg bg-white shadow-sm text-gray-700 hover:bg-gray-50">Refresh</button>
          {isAdmin && (
            <button onClick={() => setShowClients(!showClients)} className="px-3 py-1.5 text-sm rounded-lg bg-white shadow-sm text-gray-700 hover:bg-gray-50">
              {showClients ? 'Hide client settings' : 'Client settings'}
            </button>
          )}
        </div>
      </div>

      {showClients && isAdmin && <ClientSettings />}

      {banner && (
        <div className={`rounded-lg px-4 py-3 border text-sm ${banner.kind === 'ok' ? 'bg-green-50 border-green-200 text-green-800' : 'bg-red-50 border-red-200 text-red-700'}`} role="status">
          {banner.text}
          {banner.link && (
            <div className="mt-2 flex gap-2 items-center">
              <input readOnly value={banner.link} className="flex-1 border rounded px-2 py-1 text-xs font-mono bg-white text-gray-800" onFocus={(e) => e.target.select()} />
              <button onClick={() => { if (banner.link) navigator.clipboard.writeText(banner.link); }} className="px-2 py-1 text-xs rounded bg-white border">Copy</button>
            </div>
          )}
          {banner.compose && (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <ComposeButtons email={banner.compose} label="Email client from Outlook" />
              <span className="text-xs text-gray-600">Opens a ready-to-send email from your own mailbox.</span>
            </div>
          )}
        </div>
      )}

      {stage === 'client_approved' && canEdit && byStage.client_approved.length > 0 && (
        <div className="bg-white rounded-lg shadow-sm px-4 py-3 flex flex-wrap items-center gap-3 text-sm">
          <span className="text-gray-700 mr-auto">
            Bulk final form: export, adjust copy/dates in Excel or Sheets, upload, then schedule.
          </span>
          <button onClick={exportFinal} className="px-3 py-1.5 rounded-lg bg-blue-50 text-blue-700 font-medium hover:bg-blue-100">Export approved posts (CSV)</button>
          <button onClick={() => finalInputRef.current?.click()} className="px-3 py-1.5 rounded-lg bg-blue-600 text-white font-medium hover:bg-blue-700">Upload final CSV</button>
          <input ref={finalInputRef} type="file" accept=".csv" className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadFinal(f); e.target.value = ''; }} />
        </div>
      )}

      {loading ? (
        <div className="bg-white rounded-lg shadow p-8 text-center text-gray-600">Loading approvals…</div>
      ) : byStage[stage].length === 0 ? (
        <div className="bg-white rounded-lg shadow p-8 text-center text-gray-500">
          Nothing in {STAGES.find((s) => s.key === stage)!.label.toLowerCase()}.
        </div>
      ) : (
        byStage[stage].map((batch) => (
          <BatchCard
            key={batch.id}
            batch={batch}
            open={openId === batch.id}
            onToggle={() => setOpenId(openId === batch.id ? null : batch.id)}
            device={device}
            canEdit={canEdit}
            igEnabled={igEnabled}
            socialStatus={socialStatus}
            isAccountManager={!!userEmail && userEmail.toLowerCase() === (batch.client?.account_manager_email || '').toLowerCase()}
            canApproveForClient={isAdmin || (!!userEmail && userEmail.toLowerCase() === (batch.client?.account_manager_email || '').toLowerCase())}
            onChanged={load}
            onAction={async (action) => {
              // approve_internal sends the drafts on screen, so drafts that joined the batch after the
              // account manager loaded it are never approved unseen (the server asks for a refresh).
              const data = await act(batch, action, action === 'approve_internal'
                ? { post_ids: (batch.posts || []).filter((p) => p.status === 'internal_review').map((p) => p.id) }
                : {});
              if (!data) return;
              if (action === 'approve_internal' || action === 'resend_link') {
                setBanner({
                  kind: 'ok',
                  text: data.email === 'sent'
                    ? `${batch.name} is with the client. The review email was sent automatically.`
                    : `${batch.name} is with the client. Send them the review link: use "Email client from Outlook" below, or copy the link.`,
                  link: data.review_url,
                  compose: data.review_url
                    ? clientReviewEmail({
                        clientEmails: batch.client?.client_reviewer_emails || [],
                        accountManager: batch.client?.account_manager_email,
                        uploadedBy: batch.created_by_email,
                        clientName: batch.client?.name || 'Client',
                        postCount: batch.posts?.length || 0,
                        reviewUrl: data.review_url,
                        expiresAt: data.expires_at,
                      })
                    : undefined,
                });
              } else if (action === 'schedule') {
                setBanner({
                  kind: data.failures?.length ? 'error' : 'ok',
                  text: `Scheduled ${data.scheduled} post(s) for ${batch.client?.name}.`
                    + `${data.instagram_message ? ` ${data.instagram_message}` : ''}`
                    + `${typeof data.held_message === 'string' && data.held_message !== data.instagram_message ? ` ${data.held_message}` : ''}`
                    + `${data.failures?.length ? ` Failed: ${data.failures.join('; ')}` : ''}`,
                });
                onScheduled();
              } else if (action === 'cancel') {
                setBanner({
                  kind: 'ok',
                  text: `${batch.name} cancelled. Its unscheduled posts will not publish.${data.already_scheduled ? ` ${data.already_scheduled} post(s) already scheduled earlier will still publish; delete them from the Scheduled tab if needed.` : ''}`,
                });
              }
              await load();
            }}
          />
        ))
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------

function BatchCard({
  batch, open, onToggle, device, canEdit, igEnabled, socialStatus, canApproveForClient, isAccountManager, onChanged, onAction,
}: {
  batch: ReviewBatch; open: boolean; onToggle: () => void; device: 'desktop' | 'mobile'; canEdit: boolean; igEnabled: boolean;
  socialStatus: SocialStatus | null;
  canApproveForClient: boolean; isAccountManager: boolean;
  onChanged: () => void; onAction: (action: string) => Promise<void>;
}) {
  const [confirm, setConfirm] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const posts = batch.posts || [];
  const groups = useMemo(() => groupPosts(posts), [posts]);
  const edited = posts.filter((p) => p.client_edited).length;
  const comments = posts.filter((p) => p.client_comment).length;
  // Scheduling releases only client_approved posts; Instagram / LinkedIn / X ones wait while that
  // platform's publishing switch is off
  const approved = posts.filter((p) => p.status === 'client_approved');
  const isOn = (p: ReviewPost) => platformPublishingOn(rowPlatform(p), socialStatus, igEnabled);
  const waiting = approved.filter((p) => !isOn(p));
  const releasable = approved.filter(isOn);
  const waitingPhrase = platformCountPhrase(countByPlatform(waiting));
  const waitingSentence = waiting.length
    ? `${waitingPhrase} ${waiting.length === 1 ? 'is' : 'are'} waiting for ${waiting.length === 1 ? 'its' : 'their'} publishing to be switched on`
    : '';
  const platformCounts = countByPlatform(posts);
  const alreadyScheduled = posts.filter((p) => p.status === 'pending').length;
  const unscheduled = releasable.filter((p) => !p.scheduled_for).length;
  const fmt = (d?: string | null) => (d ? new Date(d).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');

  const run = async (action: string) => {
    setWorking(true);
    await onAction(action);
    setWorking(false);
    setConfirm(null);
  };

  const confirmText: Record<string, string> = {
    approve_internal: `Email the review link (from the no-reply address, replies to ${batch.client?.account_manager_email || '(no account manager set)'}) to ${batch.client?.client_reviewer_emails?.join(', ') || '(no client emails configured)'}${batch.created_by_email && batch.created_by_email !== batch.client?.account_manager_email ? ` (cc ${batch.created_by_email})` : ''}?`,
    resend_link: 'Send a new link? The previous link will stop working.',
    schedule: `Schedule ${releasable.length} post(s) for ${batch.client?.name}? They will publish at their scheduled times.`
      + (waiting.length ? ` ${waitingSentence}; ${waiting.length === 1 ? 'it stays' : 'they stay'} here.` : ''),
    cancel: alreadyScheduled
      ? `Cancel this batch? Its ${approved.length} unscheduled post(s) will never publish. ${alreadyScheduled} post(s) already scheduled will still publish (delete them from the Scheduled tab).`
      : 'Cancel this batch? Its posts will never publish and the client link stops working.',
  };

  return (
    <div className="bg-white rounded-lg shadow">
      <div className="p-4 flex flex-wrap items-start gap-3">
        <button onClick={onToggle} className="text-left flex-1 min-w-[240px]" aria-expanded={open}>
          <div className="font-semibold text-gray-900">{batch.name}</div>
          <div className="text-sm text-gray-500 mt-0.5 space-x-2">
            <span>{posts.length} post{posts.length === 1 ? '' : 's'}</span>
            {batch.created_by_email && <span>· uploaded by {batch.created_by_email}</span>}
            {batch.status === 'client_review' && batch.sent_to_client_at && <span>· sent {fmt(batch.sent_to_client_at)}, link expires {fmt(batch.client_token_expires_at)}</span>}
            {batch.status === 'client_approved' && <span>· approved by {batch.client_approved_by} {fmt(batch.client_approved_at)}</span>}
          </div>
          <div className="flex flex-wrap gap-2 mt-2">
            {edited > 0 && <span className="text-xs bg-amber-100 text-amber-800 px-2 py-0.5 rounded-full">{edited} edited by client</span>}
            {comments > 0 && <span className="text-xs bg-purple-100 text-purple-800 px-2 py-0.5 rounded-full">{comments} client note{comments === 1 ? '' : 's'}</span>}
            {batch.status === 'client_approved' && unscheduled > 0 && <span className="text-xs bg-red-100 text-red-700 px-2 py-0.5 rounded-full">{unscheduled} missing a schedule date</span>}
            {(platformCounts.instagram || 0) > 0 && (
              <span className="text-xs bg-pink-100 text-pink-800 px-2 py-0.5 rounded-full">{platformCounts.instagram} Instagram</span>
            )}
            {(platformCounts.linkedin || 0) > 0 && (
              <span className="text-xs bg-[#e8f1fa] text-[#0a66c2] px-2 py-0.5 rounded-full">{platformCounts.linkedin} LinkedIn</span>
            )}
            {(platformCounts.x || 0) > 0 && (
              <span className="text-xs bg-gray-900 text-white px-2 py-0.5 rounded-full">{platformCounts.x} X</span>
            )}
            {batch.status === 'client_approved' && waiting.length > 0 && (
              <span className="text-xs bg-gray-100 text-gray-700 px-2 py-0.5 rounded-full"
                title="Each platform has its own publishing switch (INSTAGRAM_ / LINKEDIN_ / X_PUBLISHING_ENABLED); these posts are released when theirs is on">
                {waitingSentence}
              </span>
            )}
            {batch.status === 'client_approved' && alreadyScheduled > 0 && (
              <span className="text-xs bg-green-100 text-green-800 px-2 py-0.5 rounded-full">{alreadyScheduled} already scheduled</span>
            )}
          </div>
        </button>

        {canEdit && (
          <div className="flex flex-wrap items-center gap-2">
            {confirm ? (
              <>
                <span className="text-sm text-gray-700 max-w-xs">{confirmText[confirm]}</span>
                <button disabled={working} onClick={() => setConfirm(null)} className="px-3 py-1.5 text-sm rounded-lg border">No</button>
                <button disabled={working} onClick={() => run(confirm)}
                  className={`px-3 py-1.5 text-sm rounded-lg text-white ${confirm === 'cancel' ? 'bg-red-600' : 'bg-blue-600'} disabled:opacity-50`}>
                  {working ? 'Working…' : 'Yes'}
                </button>
              </>
            ) : (
              <>
                {batch.status === 'internal_review' && !isAccountManager && (
                  <ComposeButtons label="Notify account manager" email={draftsReadyEmail({
                    accountManager: batch.client?.account_manager_email,
                    uploadedBy: batch.created_by_email,
                    clientName: batch.client?.name || 'Client',
                    batchName: batch.name,
                    postCount: posts.length,
                    appUrl: window.location.origin,
                  })} />
                )}
                {batch.status === 'client_approved' && (
                  <ComposeButtons label="Send ready-to-post email" email={readyToPostEmail({
                    clientEmails: batch.client?.client_reviewer_emails || [],
                    accountManager: batch.client?.account_manager_email,
                    uploadedBy: batch.created_by_email,
                    clientName: batch.client?.name || 'Client',
                    approvedBy: batch.client_approved_by,
                    posts,
                  })} />
                )}
                {batch.status === 'internal_review' && (canApproveForClient ? (
                  <button onClick={() => setConfirm('approve_internal')} className="px-3 py-1.5 text-sm rounded-lg bg-blue-600 text-white hover:bg-blue-700">
                    Approve → send to client
                  </button>
                ) : (
                  <span className="text-sm text-gray-500">Waiting on {batch.client?.account_manager_email || 'account manager'}</span>
                ))}
                {batch.status === 'client_review' && (
                  <button onClick={() => setConfirm('resend_link')} className="px-3 py-1.5 text-sm rounded-lg bg-blue-50 text-blue-700 hover:bg-blue-100">
                    Resend client link
                  </button>
                )}
                {batch.status === 'client_approved' && (
                  <button onClick={() => setConfirm('schedule')} disabled={unscheduled > 0 || releasable.length === 0}
                    title={releasable.length === 0 ? `Nothing to schedule until ${Array.from(new Set(waiting.map((p) => PLATFORM_LABEL[rowPlatform(p)]))).join(' / ') || 'a platform'} publishing is switched on` : unscheduled > 0 ? 'Every post needs a schedule date first' : undefined}
                    className="px-3 py-1.5 text-sm rounded-lg bg-green-600 text-white hover:bg-green-700 disabled:bg-gray-300">
                    Schedule {releasable.length} post{releasable.length === 1 ? '' : 's'}
                  </button>
                )}
                <button onClick={() => setConfirm('cancel')} className="px-3 py-1.5 text-sm rounded-lg bg-red-50 text-red-700 hover:bg-red-100">Cancel</button>
              </>
            )}
          </div>
        )}
      </div>

      {open && (
        <div className="border-t bg-[#f0f2f5] p-4 grid gap-5" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${device === 'mobile' ? 340 : 440}px, 1fr))` }}>
          {groups.map((group) => {
            const cards = group.map((p) => (
              <PostReviewCard key={p.id} post={p} device={device}
                editable={canEdit && (batch.status === 'internal_review' || batch.status === 'client_approved') && p.status === batch.status}
                onChanged={onChanged} />
            ));
            // The platform versions of one post: side by side, across the full row
            return group.length > 1 ? (
              <div key={group[0].post_group_id || group[0].id} role="group"
                aria-label={`${group[0].franchise_name}: ${group.map((p) => PLATFORM_LABEL[rowPlatform(p)]).join(', ')} versions`}
                className="grid gap-5 md:grid-cols-2 border border-dashed border-gray-300 rounded-xl p-3" style={{ gridColumn: '1 / -1' }}>
                {cards}
              </div>
            ) : cards[0];
          })}
        </div>
      )}
    </div>
  );
}

function toLocalInput(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}

function PostReviewCard({ post, device, editable, onChanged }: {
  post: ReviewPost; device: 'desktop' | 'mobile'; editable: boolean; onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [content, setContent] = useState(post.post_content);
  const [link, setLink] = useState(post.link_url || '');
  const [when, setWhen] = useState(toLocalInput(post.scheduled_for));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showOriginal, setShowOriginal] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);

  useEffect(() => {
    setContent(post.post_content);
    setLink(post.link_url || '');
    setWhen(toLocalInput(post.scheduled_for));
  }, [post.post_content, post.link_url, post.scheduled_for]);

  const platform = rowPlatform(post);
  const isIg = platform === 'instagram';
  const isSocial = platform === 'linkedin' || platform === 'x';
  // Facebook text posts take a link card and LinkedIn text posts an article card; Instagram and X never take link_url
  const linkEditable = !post.media_type && (platform === 'facebook' || platform === 'linkedin');
  const textBlocked = isIg
    ? validateIgCaption(content).errors.length > 0
    : isSocial && socialTextIssues(platform, content, { hasMedia: !!post.media_type, hasLink: platform === 'linkedin' && !!link.trim() }).errors.length > 0;
  const shownContent = editing ? content : post.post_content;
  const shownLink = editing && linkEditable ? link : post.link_url;
  const shownPreview = editing && link !== (post.link_url || '') ? null : post.link_preview;

  const save = async () => {
    setSaving(true);
    setError(null);
    const body: Record<string, unknown> = { post_content: content, scheduled_for: when ? new Date(when).toISOString() : null };
    if (linkEditable) body.link_url = link;
    const res = await fetch(`/api/review/posts/${post.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    setSaving(false);
    if (!res.ok) { setError(data.error || 'Save failed'); return; }
    setEditing(false);
    onChanged();
  };

  const remove = async () => {
    const res = await fetch(`/api/review/posts/${post.id}`, { method: 'DELETE' });
    if (!res.ok) { setError((await res.json().catch(() => ({}))).error || 'Remove failed'); return; }
    onChanged();
  };

  return (
    <div className="space-y-2">
      {isIg ? (
        <InstagramPostPreview
          username={post.ig_username || post.franchise_name}
          facebookPageId={post.facebook_page_id}
          caption={shownContent}
          mediaType={post.media_type}
          mediaUrl={post.media_url}
          device={device}
        />
      ) : platform === 'linkedin' ? (
        <LinkedInPostPreview
          orgName={post.linkedin_org_name || post.franchise_name}
          content={shownContent}
          linkUrl={shownLink}
          linkPreview={shownPreview}
          mediaType={post.media_type}
          mediaUrl={post.media_url}
          device={device}
        />
      ) : platform === 'x' ? (
        <XPostPreview
          displayName={post.franchise_name}
          username={post.x_username}
          content={shownContent}
          mediaType={post.media_type}
          mediaUrl={post.media_url}
          device={device}
        />
      ) : (
        <FacebookPostPreview
          pageName={post.franchise_name}
          facebookPageId={post.facebook_page_id}
          content={shownContent}
          linkUrl={shownLink}
          linkPreview={shownPreview}
          mediaType={post.media_type}
          mediaUrl={post.media_url}
          scheduledFor={editing ? (when ? new Date(when).toISOString() : null) : post.scheduled_for}
          device={device}
        />
      )}

      <div className="bg-white rounded-lg p-3 text-sm space-y-2 max-w-[500px] mx-auto">
        <div className="flex flex-wrap items-center gap-2">
          <PlatformBadge platform={post.platform} />
          <span className="font-medium text-gray-800">{post.location_number ? `${post.location_number} · ` : ''}{post.franchise_name}</span>
          {post.status === 'pending' && <span className="text-xs bg-green-100 text-green-800 px-2 py-0.5 rounded-full">Scheduled</span>}
          {post.status === 'publishing' && <span className="text-xs bg-amber-100 text-amber-800 px-2 py-0.5 rounded-full">Publishing…</span>}
          {post.status === 'published' && <span className="text-xs bg-green-100 text-green-800 px-2 py-0.5 rounded-full">Published</span>}
          {post.status === 'failed' && <span className="text-xs bg-red-100 text-red-800 px-2 py-0.5 rounded-full">Failed</span>}
          {post.client_edited && (
            <button onClick={() => setShowOriginal(!showOriginal)} className="text-xs bg-amber-100 text-amber-800 px-2 py-0.5 rounded-full hover:bg-amber-200">
              Edited by client {showOriginal ? '▲' : '▼'}
            </button>
          )}
          {!post.scheduled_for && <span className="text-xs bg-gray-100 text-gray-700 px-2 py-0.5 rounded-full">No date</span>}
        </div>

        {showOriginal && post.original_content && (
          <div className="bg-gray-50 border rounded p-2">
            <div className="text-xs uppercase text-gray-500 mb-1">Original draft</div>
            <p className="whitespace-pre-wrap text-gray-600">{post.original_content}</p>
          </div>
        )}
        {post.status === 'failed' && post.publish_error && (
          <div className="bg-red-50 border border-red-200 rounded p-2 text-red-800">
            <span className="font-medium">Publishing failed:</span> {post.publish_error}
          </div>
        )}
        {post.client_comment && (
          <div className="bg-purple-50 border border-purple-100 rounded p-2 text-purple-900">
            <span className="font-medium">Client note:</span> {post.client_comment}
          </div>
        )}

        {editing ? (
          <div className="space-y-2">
            <textarea value={content} onChange={(e) => setContent(e.target.value)} rows={6}
              aria-label={`${isIg ? 'Instagram caption' : `${PLATFORM_LABEL[platform]} post text`} for ${post.franchise_name}`}
              aria-describedby={isIg || isSocial ? `textmeter-${post.id}` : undefined}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:ring-2 focus:ring-blue-500" />
            {isIg && <IgCaptionMeter caption={content} id={`textmeter-${post.id}`} />}
            {isSocial && (
              <SocialTextMeter platform={platform} text={content} id={`textmeter-${post.id}`}
                hasMedia={!!post.media_type} hasLink={platform === 'linkedin' && !!link.trim()} />
            )}
            {linkEditable && (
              <input value={link} onChange={(e) => setLink(e.target.value)} placeholder="Link URL (optional)"
                className="w-full border border-gray-300 rounded-lg px-3 py-1.5" />
            )}
            <label className="flex items-center gap-2 text-gray-700">
              Schedule
              <input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} className="border border-gray-300 rounded-lg px-2 py-1" />
            </label>
            {error && <p className="text-red-600">{error}</p>}
            <div className="flex gap-2 justify-end">
              <button onClick={() => { setEditing(false); setContent(post.post_content); setLink(post.link_url || ''); setWhen(toLocalInput(post.scheduled_for)); }}
                className="px-3 py-1.5 rounded-lg border">Cancel</button>
              <button onClick={save} disabled={saving || (!content.trim() && !isSocial) || textBlocked} className="px-3 py-1.5 rounded-lg bg-blue-600 text-white disabled:opacity-50">
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        ) : (
          editable && (
            <div className="flex gap-2 justify-end">
              {confirmRemove ? (
                <>
                  <span className="text-gray-600 mr-auto">Remove this post from the batch?</span>
                  <button onClick={() => setConfirmRemove(false)} className="px-3 py-1 rounded-lg border">No</button>
                  <button onClick={remove} className="px-3 py-1 rounded-lg bg-red-600 text-white">Remove</button>
                </>
              ) : (
                <>
                  <button onClick={() => setConfirmRemove(true)} className="px-3 py-1 rounded-lg text-red-700 hover:bg-red-50">Remove</button>
                  {(post.media_type === 'photo' || post.media_type === 'video') && (
                    <ReplaceMediaButton postId={post.id} platform={post.platform} mediaType={post.media_type} onReplaced={onChanged} />
                  )}
                  <button onClick={() => setEditing(true)} className="px-3 py-1 rounded-lg bg-gray-100 text-gray-800 hover:bg-gray-200">Edit</button>
                </>
              )}
            </div>
          )
        )}
        {error && !editing && <p className="text-red-600">{error}</p>}
      </div>
    </div>
  );
}
