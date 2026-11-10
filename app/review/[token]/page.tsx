'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import FacebookPostPreview, { type PreviewLinkCard } from '@/components/FacebookPostPreview';
import DeviceToggle from '@/components/DeviceToggle';
import InstagramPostPreview from '@/components/InstagramPostPreview';
import PlatformBadge from '@/components/PlatformBadge';
import IgCaptionMeter from '@/components/IgCaptionMeter';
import LinkedInPostPreview from '@/components/LinkedInPostPreview';
import XPostPreview from '@/components/XPostPreview';
import SocialTextMeter from '@/components/SocialTextMeter';
import { groupPosts } from '@/lib/review/grouping';
import { validateIgCaption, PLATFORM_LABEL, rowPlatform } from '@/lib/instagram/rules';
import { socialTextIssues } from '@/lib/social/ui';

interface ClientPost {
  id: string;
  facebook_page_id: string;
  franchise_name: string;
  location_number: string | null;
  post_content: string;
  link_url: string | null;
  media_url: string | null;
  media_type: string | null;
  scheduled_for: string | null;
  client_comment: string | null;
  link_preview: PreviewLinkCard | null;
  platform?: 'facebook' | 'instagram' | 'linkedin' | 'x' | null;
  post_group_id?: string | null;
  ig_username?: string | null;
  linkedin_org_name?: string | null;
  x_username?: string | null;
}

/** Text over a platform's limit can't be saved or approved (the server rejects it too). */
function textInvalid(post: ClientPost, text: string): boolean {
  const platform = rowPlatform(post);
  if (platform === 'instagram') return validateIgCaption(text).errors.length > 0;
  if (platform === 'linkedin' || platform === 'x') {
    return socialTextIssues(platform, text, { hasMedia: !!post.media_type, hasLink: platform === 'linkedin' && !post.media_type && !!post.link_url }).errors.length > 0;
  }
  return false;
}

interface BatchInfo {
  name: string;
  status: 'client_review' | 'client_approved';
  client_name: string;
  client_approved_by: string | null;
  client_approved_at: string | null;
  expires_at: string;
}

type Draft = { post_content: string; client_comment: string };

export default function ClientReviewPage({ params }: { params: { token: string } }) {
  const [batch, setBatch] = useState<BatchInfo | null>(null);
  const [posts, setPosts] = useState<ClientPost[]>([]);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<'save' | 'approve' | null>(null);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [approverName, setApproverName] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [device, setDevice] = useState<'desktop' | 'mobile'>('desktop');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/client-review/${encodeURIComponent(params.token)}`, { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Unable to load posts');
      setBatch(data.batch);
      setPosts(data.posts);
      setDrafts(Object.fromEntries(data.posts.map((p: ClientPost) => [p.id, { post_content: p.post_content, client_comment: p.client_comment || '' }])));
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Unable to load posts');
    } finally {
      setLoading(false);
    }
  }, [params.token]);

  useEffect(() => { load(); }, [load]);

  const readOnly = batch?.status !== 'client_review';
  const changed = useMemo(
    () => posts.filter((p) => drafts[p.id] && (drafts[p.id].post_content !== p.post_content || drafts[p.id].client_comment !== (p.client_comment || ''))),
    [posts, drafts],
  );
  const groups = useMemo(() => groupPosts(posts), [posts]);
  // Instagram captions, LinkedIn text or X text over the platform's limits can't be saved or approved
  const invalidPosts = posts.filter((p) => drafts[p.id] && textInvalid(p, drafts[p.id].post_content));
  const anyInvalid = invalidPosts.length > 0;

  const submit = async (action: 'save' | 'approve') => {
    setBusy(action);
    setMessage(null);
    try {
      const payload = posts.map((p) => ({ id: p.id, ...drafts[p.id] }));
      const res = await fetch(`/api/client-review/${encodeURIComponent(params.token)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, approver_name: approverName, posts: payload }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Something went wrong');
      setConfirming(false);
      await load();
      setMessage({ kind: 'ok', text: action === 'approve' ? 'Thank you! Your posts are approved. You\'ll receive a "ready to post" confirmation email, and your Ironmark team will schedule them.' : 'Your changes are saved. You can come back to this link any time before it expires.' });
    } catch (e) {
      setMessage({ kind: 'error', text: e instanceof Error ? e.message : 'Something went wrong' });
    } finally {
      setBusy(null);
    }
  };

  if (loading && !batch) {
    return <div className="min-h-screen bg-[#f0f2f5] flex items-center justify-center text-gray-600">Loading your posts…</div>;
  }
  if (loadError || !batch) {
    return (
      <div className="min-h-screen bg-[#f0f2f5] flex items-center justify-center px-4">
        <div className="bg-white rounded-lg shadow p-8 max-w-md text-center">
          <h1 className="text-lg font-semibold text-gray-900 mb-2">Link unavailable</h1>
          <p className="text-gray-600">{loadError}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#f0f2f5]">
      <header className="bg-white shadow-sm">
        <div className="max-w-6xl mx-auto px-4 py-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-xs uppercase tracking-wide text-gray-500">Post review for</p>
            <h1 className="text-xl font-bold text-gray-900">{batch.client_name}</h1>
          </div>
          <DeviceToggle value={device} onChange={setDevice} />
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 py-6 pb-40">
        {readOnly ? (
          <div className="bg-green-50 border border-green-200 text-green-800 rounded-lg px-4 py-3 mb-6">
            Approved by {batch.client_approved_by} on{' '}
            {batch.client_approved_at && new Date(batch.client_approved_at).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}.
            Your Ironmark team will schedule these posts.
          </div>
        ) : (
          <div className="bg-white rounded-lg shadow-sm px-5 py-4 mb-6 text-gray-700">
            <p className="font-medium text-gray-900 mb-1">
              {posts.length} post{posts.length === 1 ? '' : 's'} ready for your review
            </p>
            <p className="text-sm">
              Each preview shows the post as it will look on {Array.from(new Set(posts.map((p) => PLATFORM_LABEL[rowPlatform(p)]))).join(', ').replace(/, ([^,]*)$/, ' or $1')}. Edit the text on the right and the preview updates as you type.
              Leave a note if you need something else changed (an image, a link or a date). When everything looks right, approve at the bottom.
            </p>
          </div>
        )}

        {message && (
          <div className={`mb-6 rounded-lg px-4 py-3 border ${message.kind === 'ok' ? 'bg-green-50 border-green-200 text-green-800' : 'bg-red-50 border-red-200 text-red-700'}`} role="status">
            {message.text}
          </div>
        )}

        <div className="space-y-6">
          {groups.map((group, i) => (
            <section key={group[0].post_group_id || group[0].id} aria-label={`Post ${i + 1}: ${group[0].franchise_name}`}
              className="bg-white/60 rounded-xl p-4 space-y-6">
              {group.length > 1 && (
                <h2 className="font-semibold text-gray-900">
                  Post {i + 1} · {group[0].franchise_name}{' '}
                  <span className="font-normal text-sm text-gray-600">
                    {group.map((p) => PLATFORM_LABEL[rowPlatform(p)]).join(', ').replace(/, ([^,]*)$/, ' and $1')} versions. Edit each one separately.
                  </span>
                </h2>
              )}
              {group.map((post) => {
            const d = drafts[post.id] || { post_content: post.post_content, client_comment: '' };
            const isChanged = d.post_content !== post.post_content;
            const platform = rowPlatform(post);
            const isIg = platform === 'instagram';
            const isSocial = platform === 'linkedin' || platform === 'x';
            const Heading = group.length > 1 ? 'h3' : 'h2';
            return (
              <div key={post.id} className="grid gap-5 lg:grid-cols-[minmax(0,520px)_1fr]">
                <div>
                  {isIg ? (
                    <InstagramPostPreview
                      username={post.ig_username || post.franchise_name}
                      facebookPageId={post.facebook_page_id}
                      caption={d.post_content}
                      mediaType={post.media_type}
                      mediaUrl={post.media_url}
                      device={device}
                    />
                  ) : platform === 'linkedin' ? (
                    <LinkedInPostPreview
                      orgName={post.linkedin_org_name || post.franchise_name}
                      content={d.post_content}
                      linkUrl={post.link_url}
                      linkPreview={post.link_preview}
                      mediaType={post.media_type}
                      mediaUrl={post.media_url}
                      device={device}
                    />
                  ) : platform === 'x' ? (
                    <XPostPreview
                      displayName={post.franchise_name}
                      username={post.x_username}
                      content={d.post_content}
                      mediaType={post.media_type}
                      mediaUrl={post.media_url}
                      device={device}
                    />
                  ) : (
                    <FacebookPostPreview
                      pageName={post.franchise_name}
                      facebookPageId={post.facebook_page_id}
                      content={d.post_content}
                      linkUrl={post.link_url}
                      linkPreview={post.link_preview}
                      mediaType={post.media_type}
                      mediaUrl={post.media_url}
                      scheduledFor={post.scheduled_for}
                      device={device}
                    />
                  )}
                </div>
                <div className="space-y-3">
                  <div className="flex items-center justify-between gap-2">
                    <Heading className="font-semibold text-gray-900 flex items-center gap-2">
                      <PlatformBadge platform={post.platform} />
                      {group.length > 1 ? `${PLATFORM_LABEL[platform]} version` : `Post ${i + 1} · ${post.franchise_name}`}
                    </Heading>
                    {isChanged && <span className="text-xs font-medium bg-amber-100 text-amber-800 px-2 py-0.5 rounded-full">Edited</span>}
                  </div>
                  {post.scheduled_for && (
                    <p className="text-sm text-gray-600">
                      Planned for {new Date(post.scheduled_for).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                    </p>
                  )}
                  <label className="block">
                    <span className="text-sm font-medium text-gray-700">{isIg ? 'Instagram caption' : isSocial ? `${PLATFORM_LABEL[platform]} text` : 'Post text'}</span>
                    <textarea
                      value={d.post_content}
                      readOnly={readOnly}
                      onChange={(e) => setDrafts({ ...drafts, [post.id]: { ...d, post_content: e.target.value } })}
                      rows={8}
                      aria-describedby={isIg || isSocial ? `textmeter-${post.id}` : undefined}
                      className="mt-1 w-full border border-gray-300 rounded-lg px-3 py-2 text-[15px] focus:ring-2 focus:ring-blue-500 focus:border-blue-500 read-only:bg-gray-50"
                    />
                  </label>
                  {isIg && !readOnly && <IgCaptionMeter caption={d.post_content} id={`textmeter-${post.id}`} />}
                  {isSocial && !readOnly && (
                    <SocialTextMeter platform={platform} text={d.post_content} id={`textmeter-${post.id}`}
                      hasMedia={!!post.media_type} hasLink={platform === 'linkedin' && !post.media_type && !!post.link_url} />
                  )}
                  {isChanged && !readOnly && (
                    <button type="button" className="text-sm text-blue-600 hover:underline"
                      onClick={() => setDrafts({ ...drafts, [post.id]: { ...d, post_content: post.post_content } })}>
                      Undo my edits
                    </button>
                  )}
                  <label className="block">
                    <span className="text-sm font-medium text-gray-700">Note to the Ironmark team (optional)</span>
                    <textarea
                      value={d.client_comment}
                      readOnly={readOnly}
                      onChange={(e) => setDrafts({ ...drafts, [post.id]: { ...d, client_comment: e.target.value } })}
                      rows={2}
                      maxLength={2000}
                      placeholder="e.g. please swap the photo, change the date…"
                      className="mt-1 w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 read-only:bg-gray-50"
                    />
                  </label>
                </div>
              </div>
            );
              })}
            </section>
          ))}
        </div>
      </main>

      {!readOnly && (
        <div className="fixed bottom-0 inset-x-0 bg-white border-t shadow-[0_-2px_8px_rgba(0,0,0,0.06)]">
          <div className="max-w-6xl mx-auto px-4 py-3 flex flex-wrap items-center gap-3">
            {!confirming ? (
              <>
                <span className="text-sm text-gray-600 mr-auto">
                  {anyInvalid
                    ? <span className="text-red-700">{invalidPosts.length} post{invalidPosts.length === 1 ? ' is' : 's are'} over {invalidPosts.length === 1 ? 'its' : 'their'} platform&apos;s length limit. Shorten {invalidPosts.length === 1 ? 'it' : 'them'} to save or approve.</span>
                    : changed.length > 0 ? `${changed.length} unsaved change${changed.length === 1 ? '' : 's'}` : 'No unsaved changes'}
                </span>
                <button type="button" onClick={() => submit('save')} disabled={busy !== null || changed.length === 0 || anyInvalid}
                  className="px-4 py-2 rounded-lg border border-gray-300 text-gray-700 font-medium hover:bg-gray-50 disabled:opacity-50">
                  {busy === 'save' ? 'Saving…' : 'Save without approving'}
                </button>
                <button type="button" onClick={() => setConfirming(true)} disabled={busy !== null || anyInvalid}
                  className="px-5 py-2 rounded-lg bg-[#1877f2] text-white font-semibold hover:bg-[#166fe5] disabled:opacity-50">
                  Approve {posts.length} post{posts.length === 1 ? '' : 's'}
                </button>
              </>
            ) : (
              <>
                <label className="flex items-center gap-2 mr-auto text-sm text-gray-700">
                  Your name
                  <input value={approverName} onChange={(e) => setApproverName(e.target.value)} autoFocus maxLength={120}
                    className="border border-gray-300 rounded-lg px-3 py-1.5 w-56" placeholder="First and last name" />
                </label>
                <span className="text-sm text-gray-600">Approve all {posts.length} posts as final{changed.length ? ', including your edits' : ''}?</span>
                <button type="button" onClick={() => setConfirming(false)} disabled={busy !== null}
                  className="px-4 py-2 rounded-lg border border-gray-300 text-gray-700 font-medium hover:bg-gray-50">Back</button>
                <button type="button" onClick={() => submit('approve')} disabled={busy !== null || approverName.trim().length < 2}
                  className="px-5 py-2 rounded-lg bg-green-600 text-white font-semibold hover:bg-green-700 disabled:opacity-50">
                  {busy === 'approve' ? 'Approving…' : 'Confirm approval'}
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
