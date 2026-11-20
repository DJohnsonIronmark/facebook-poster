'use client';

import { useState, type ReactNode } from 'react';
import { IG_MAX_RATIO, IG_MIN_RATIO } from '@/lib/instagram/rules';

// Renders a post the way it appears in the Instagram feed (light theme). Instagram captions have
// no link cards and links are not clickable, so URLs render as plain text.

interface Props {
  username: string;              // ig_username, or the page name when no handle is set
  facebookPageId?: string | null; // avatar: the linked Facebook Page's picture
  caption: string;
  mediaType?: string | null;     // 'photo' | 'image' | 'video'
  mediaUrl?: string | null;
  /** width / height of the media as it will be posted (e.g. the cropped derivative); measured when omitted */
  aspectRatio?: number | null;
  note?: string | null;          // e.g. "Cropped from 9:16 to 4:5 for Instagram"
  device?: 'desktop' | 'mobile';
}

const IG_FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
const TRUNCATE_AT = 125;
// RegExp() rather than a literal: the 'u' flag literal is rejected under the ES5 TS target
const TOKEN_RE = new RegExp('([#@][\\p{L}\\p{N}_.]+)', 'gu');
const WORD_CHAR_RE = new RegExp('[\\p{L}\\p{N}_&]', 'u');

function renderCaption(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of Array.from(text.matchAll(TOKEN_RE))) {
    const idx = m.index ?? 0;
    const prev = idx > 0 ? text[idx - 1] : ' ';
    if (WORD_CHAR_RE.test(prev)) continue; // "a#b" or "&#39;" isn't a tag
    if (idx > last) out.push(text.slice(last, idx));
    const tok = m[0].replace(/\.+$/, '');
    out.push(<span key={idx} style={{ color: '#00376b' }}>{tok}</span>);
    last = idx + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function truncateCaption(text: string): string {
  const firstLines = text.split('\n').slice(0, 2).join('\n');
  const cut = firstLines.length > TRUNCATE_AT ? firstLines.slice(0, TRUNCATE_AT) : firstLines;
  return cut.replace(/\s+\S*$/, '').trimEnd() || cut;
}

const clampRatio = (r: number) => Math.min(IG_MAX_RATIO, Math.max(IG_MIN_RATIO, r));

function Avatar({ name, facebookPageId }: { name: string; facebookPageId?: string | null }) {
  const [failed, setFailed] = useState(false);
  const initials = name.replace(/^@/, '').split(/[\s._]+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
  return (
    <span className="rounded-full p-[2px] shrink-0" style={{ background: 'linear-gradient(45deg,#feda75,#fa7e1e,#d62976,#962fbf,#4f5bd5)' }}>
      <span className="block rounded-full bg-white p-[2px]">
        {facebookPageId && !failed ? (
          <img
            src={`https://graph.facebook.com/${encodeURIComponent(facebookPageId)}/picture?type=square&width=64&height=64`}
            alt=""
            onError={() => setFailed(true)}
            className="w-8 h-8 rounded-full object-cover"
          />
        ) : (
          <span className="w-8 h-8 rounded-full bg-gray-200 text-gray-700 flex items-center justify-center text-xs font-semibold">
            {initials || 'IG'}
          </span>
        )}
      </span>
    </span>
  );
}

const icon = 'w-6 h-6';
const Icons = {
  heart: <svg className={icon} viewBox="0 0 24 24" fill="none" stroke="#262626" strokeWidth="1.8" aria-hidden><path d="M12 20.5s-7.5-4.6-9.3-9.2C1.4 8 3.4 4.5 7 4.5c2 0 3.6 1.2 5 3 1.4-1.8 3-3 5-3 3.6 0 5.6 3.5 4.3 6.8-1.8 4.6-9.3 9.2-9.3 9.2z" strokeLinejoin="round" /></svg>,
  comment: <svg className={icon} viewBox="0 0 24 24" fill="none" stroke="#262626" strokeWidth="1.8" aria-hidden><path d="M20.7 16.5A9 9 0 1 0 17 20.3L21 21l-.3-4.5z" strokeLinejoin="round" /></svg>,
  share: <svg className={icon} viewBox="0 0 24 24" fill="none" stroke="#262626" strokeWidth="1.8" aria-hidden><path d="M22 3 9.2 10.1M22 3l-7 18-3.8-8.9L2 8.4 22 3z" strokeLinejoin="round" /></svg>,
  bookmark: <svg className={icon} viewBox="0 0 24 24" fill="none" stroke="#262626" strokeWidth="1.8" aria-hidden><path d="M19 21l-7-5-7 5V4a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v17z" strokeLinejoin="round" /></svg>,
};

export default function InstagramPostPreview({
  username, facebookPageId, caption, mediaType, mediaUrl, aspectRatio, note, device = 'desktop',
}: Props) {
  const [expanded, setExpanded] = useState(false);
  const [measured, setMeasured] = useState<number | null>(null);
  const isPhoto = mediaType === 'photo' || mediaType === 'image';
  const isVideo = mediaType === 'video';
  const handle = username.replace(/^@/, '') || 'instagram';
  // Instagram's feed shows media between 4:5 and 1.91:1 (taller videos are cropped to 4:5 in feed)
  const ratio = clampRatio(aspectRatio || measured || 1);

  const needsTruncate = !expanded && (caption.length > TRUNCATE_AT || caption.split('\n').length > 2);
  const shown = needsTruncate ? truncateCaption(caption) : caption;

  return (
    <article
      aria-label={`Instagram post preview for ${handle}`}
      className="bg-white border border-[#dbdbdb] rounded-lg overflow-hidden mx-auto text-left"
      style={{ fontFamily: IG_FONT, color: '#262626', width: '100%', maxWidth: device === 'mobile' ? 375 : 470 }}
    >
      {/* Header */}
      <div className="flex items-center gap-3 px-3 py-2.5">
        <Avatar name={handle} facebookPageId={facebookPageId} />
        <div className="flex-1 min-w-0 text-sm font-semibold truncate">{handle}</div>
        <div className="text-lg leading-none px-1 select-none" aria-hidden>…</div>
      </div>

      {/* Media */}
      <div className="relative bg-[#efefef] w-full" style={{ aspectRatio: String(ratio) }}>
        {isPhoto && mediaUrl && (
          <img src={mediaUrl} alt="" className="absolute inset-0 w-full h-full object-cover"
            onLoad={(e) => setMeasured(e.currentTarget.naturalWidth / e.currentTarget.naturalHeight)} />
        )}
        {isVideo && mediaUrl && (
          <video src={mediaUrl} controls preload="metadata" muted className="absolute inset-0 w-full h-full object-cover bg-black"
            onLoadedMetadata={(e) => { const v = e.currentTarget; if (v.videoWidth && v.videoHeight) setMeasured(v.videoWidth / v.videoHeight); }} />
        )}
        {(!mediaUrl || (!isPhoto && !isVideo)) && (
          <div className="absolute inset-0 flex items-center justify-center text-sm text-red-700 px-6 text-center">
            Instagram posts need a photo or video
          </div>
        )}
      </div>
      {note && <p className="px-3 pt-2 text-xs text-amber-800">{note}</p>}

      {/* Actions */}
      <div className="flex items-center gap-4 px-3 pt-2.5">
        <span title="Like">{Icons.heart}</span>
        <span title="Comment">{Icons.comment}</span>
        <span title="Share">{Icons.share}</span>
        <span className="ml-auto" title="Save">{Icons.bookmark}</span>
      </div>

      {/* Caption */}
      <div className="px-3 pt-2 pb-3 text-sm leading-[18px] whitespace-pre-wrap break-words">
        <span className="font-semibold mr-1">{handle}</span>
        {renderCaption(shown)}
        {needsTruncate && (
          <>
            {'… '}
            <button type="button" onClick={() => setExpanded(true)} className="text-[#737373]" aria-label="Show the full caption">
              more
            </button>
          </>
        )}
      </div>
    </article>
  );
}
