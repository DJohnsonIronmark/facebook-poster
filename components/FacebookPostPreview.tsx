'use client';

import { useState, type ReactNode } from 'react';

// Renders a post the way it appears in the Facebook News Feed (light theme), so internal
// reviewers and clients approve exactly what will be published.

export interface PreviewLinkCard {
  url: string;
  domain: string;
  title?: string | null;
  description?: string | null;
  image?: string | null;
}

interface Props {
  pageName: string;
  facebookPageId?: string | null;
  content: string;
  linkUrl?: string | null;
  linkPreview?: PreviewLinkCard | null;
  mediaType?: string | null;   // 'photo' | 'image' | 'video' | null
  mediaUrl?: string | null;
  scheduledFor?: string | null;
  device?: 'desktop' | 'mobile';
}

const FB_FONT = 'Segoe UI Historic, Segoe UI, Helvetica, Arial, sans-serif';
// RegExp() rather than a literal: the 'u' flag literal is rejected under the ES5 TS target
const TOKEN_RE = new RegExp('(https?:\\/\\/[^\\s]+|#[\\p{L}\\p{N}_]+)', 'gu');

function renderRichText(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of Array.from(text.matchAll(TOKEN_RE))) {
    const idx = m.index ?? 0;
    if (idx > last) out.push(text.slice(last, idx));
    const tok = m[0];
    out.push(
      tok.startsWith('#') ? (
        <span key={idx} style={{ color: '#0064d1', fontWeight: 600 }}>{tok}</span>
      ) : (
        <a key={idx} href={tok} target="_blank" rel="noopener noreferrer" style={{ color: '#0064d1' }} className="hover:underline break-all">{tok}</a>
      ),
    );
    last = idx + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function timeLabel(scheduledFor?: string | null): string {
  if (!scheduledFor) return 'Just now';
  const d = new Date(scheduledFor);
  if (isNaN(d.getTime())) return 'Just now';
  return d.toLocaleString('en-US', { month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' }).replace(',', ' at');
}

function Avatar({ pageName, facebookPageId }: { pageName: string; facebookPageId?: string | null }) {
  const [failed, setFailed] = useState(false);
  const initials = pageName.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
  if (facebookPageId && !failed) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={`https://graph.facebook.com/${encodeURIComponent(facebookPageId)}/picture?type=square&width=80&height=80`}
        alt=""
        onError={() => setFailed(true)}
        className="w-10 h-10 rounded-full object-cover border border-black/10"
      />
    );
  }
  return (
    <div className="w-10 h-10 rounded-full bg-[#1877f2] text-white flex items-center justify-center text-sm font-semibold">
      {initials || 'P'}
    </div>
  );
}

const Icon = {
  globe: (
    <svg viewBox="0 0 16 16" width="12" height="12" fill="#65676b" aria-label="Public"><path d="M8 0a8 8 0 1 0 0 16A8 8 0 0 0 8 0zm5.9 7h-2.5a12 12 0 0 0-.9-4.4A6 6 0 0 1 13.9 7zM8 2c.6.7 1.4 2.4 1.5 5h-3C6.6 4.4 7.4 2.7 8 2zM5.5 2.6A12 12 0 0 0 4.6 7H2.1a6 6 0 0 1 3.4-4.4zM2.1 9h2.5c.1 1.6.4 3.1.9 4.4A6 6 0 0 1 2.1 9zM8 14c-.6-.7-1.4-2.4-1.5-5h3c-.1 2.6-.9 4.3-1.5 5zm2.5-.6c.5-1.3.8-2.8.9-4.4h2.5a6 6 0 0 1-3.4 4.4z"/></svg>
  ),
  like: (
    <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="#65676b" strokeWidth="1.6"><path d="M6 9v8H3V9h3zm0 0 3.5-6c1.2 0 2 .9 2 2v3h4.2c1 0 1.8 1 1.5 2l-1.4 5.6c-.2.8-.9 1.4-1.7 1.4H6"/></svg>
  ),
  comment: (
    <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="#65676b" strokeWidth="1.6"><path d="M10 2.5c4.4 0 7.5 3 7.5 6.8s-3.1 6.8-7.5 6.8c-.9 0-1.8-.1-2.6-.4L3.5 17l.9-3.2C3.2 12.6 2.5 11 2.5 9.3 2.5 5.5 5.6 2.5 10 2.5z"/></svg>
  ),
  share: (
    <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="#65676b" strokeWidth="1.6"><path d="M11 4v3.5C5 8 3 12 2.5 16c2-3 4.5-4 8.5-4v3.5L17.5 9.8 11 4z" strokeLinejoin="round"/></svg>
  ),
};

export default function FacebookPostPreview({
  pageName, facebookPageId, content, linkUrl, linkPreview, mediaType, mediaUrl, scheduledFor, device = 'desktop',
}: Props) {
  const [expanded, setExpanded] = useState(false);
  const isPhoto = mediaType === 'photo' || mediaType === 'image';
  const isVideo = mediaType === 'video';
  const hasMedia = (isPhoto || isVideo) && !!mediaUrl;
  const card: PreviewLinkCard | null = !hasMedia && linkUrl
    ? linkPreview || { url: linkUrl, domain: safeDomain(linkUrl) }
    : null;

  // Facebook shows short, text-only posts in a large font
  const bigText = !hasMedia && !card && content.length < 85 && content.split('\n').length <= 3;
  // Approximate Facebook's "See more" cutoff (shorter when there's media/a link card)
  const limit = hasMedia || card ? 250 : 480;
  const needsTruncate = !expanded && (content.length > limit || content.split('\n').length > (hasMedia || card ? 4 : 7));
  const shown = needsTruncate ? truncate(content, limit, hasMedia || card ? 4 : 7) : content;

  return (
    <div
      className="bg-white rounded-lg shadow-[0_1px_2px_rgba(0,0,0,0.2)] overflow-hidden mx-auto text-left"
      style={{ fontFamily: FB_FONT, color: '#050505', width: '100%', maxWidth: device === 'mobile' ? 375 : 500 }}
    >
      {/* Header */}
      <div className="flex items-start gap-2 px-4 pt-3 pb-2">
        <Avatar pageName={pageName} facebookPageId={facebookPageId} />
        <div className="flex-1 min-w-0">
          <div className="font-semibold text-[15px] leading-5 truncate">{pageName}</div>
          <div className="flex items-center gap-1 text-[13px] leading-4 text-[#65676b]">
            <span>{timeLabel(scheduledFor)}</span>
            <span aria-hidden>·</span>
            {Icon.globe}
          </div>
        </div>
        <div className="text-[#65676b] text-xl leading-none px-1 select-none" aria-hidden>···</div>
      </div>

      {/* Text */}
      {content && (
        <div
          className="px-4 pb-3 whitespace-pre-wrap break-words"
          style={bigText ? { fontSize: 24, lineHeight: '28px' } : { fontSize: 15, lineHeight: '20px' }}
        >
          {renderRichText(shown)}
          {needsTruncate && (
            <>
              {'… '}
              <button type="button" onClick={() => setExpanded(true)} className="font-semibold hover:underline">
                See more
              </button>
            </>
          )}
        </div>
      )}

      {/* Media */}
      {hasMedia && isPhoto && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={mediaUrl!} alt="" className="w-full max-h-[600px] object-cover bg-[#f0f2f5] border-y border-black/5" />
      )}
      {hasMedia && isVideo && (
        <div className="relative bg-black">
          <video src={mediaUrl!} controls preload="metadata" className="w-full max-h-[600px]" />
        </div>
      )}

      {/* Link card */}
      {card && (
        <a href={card.url} target="_blank" rel="noopener noreferrer" className="block border-y border-black/5">
          {card.image && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={card.image} alt="" className="w-full object-cover bg-[#f0f2f5]" style={{ aspectRatio: '1.91 / 1' }} />
          )}
          <div className="bg-[#f0f2f5] px-3 py-2.5">
            <div className="text-[13px] leading-4 text-[#65676b] uppercase truncate">{card.domain}</div>
            {card.title && <div className="text-[17px] leading-5 font-semibold mt-0.5 line-clamp-2">{card.title}</div>}
            {card.description && <div className="text-[15px] leading-5 text-[#65676b] mt-0.5 line-clamp-1">{card.description}</div>}
            {!card.title && !card.description && (
              <div className="text-[15px] leading-5 text-[#65676b] mt-0.5 truncate">{card.url}</div>
            )}
          </div>
        </a>
      )}

      {/* Action bar */}
      <div className="mx-4 border-t border-[#ced0d4] flex text-[15px] font-semibold text-[#65676b]">
        {[['like', 'Like'], ['comment', 'Comment'], ['share', 'Share']].map(([k, label]) => (
          <div key={k} className="flex-1 flex items-center justify-center gap-2 py-1.5 my-1 rounded-md">
            {Icon[k as keyof typeof Icon]}
            <span>{label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function safeDomain(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, '').toUpperCase(); } catch { return url; }
}

function truncate(text: string, maxChars: number, maxLines: number): string {
  const lines = text.split('\n').slice(0, maxLines).join('\n');
  const cut = lines.length > maxChars ? lines.slice(0, maxChars) : lines;
  return cut.replace(/\s+\S*$/, '').trimEnd() || cut;
}
