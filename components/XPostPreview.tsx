'use client';

import { useState, type ReactNode } from 'react';

// Renders a post the way it appears on X (light theme). X shows links shortened (no scheme,
// long paths cut with "…"), and every link counts as 23 characters toward the 280 limit; the
// character count itself is shown by SocialTextMeter, never inside the preview.

interface Props {
  displayName: string;                // page name
  username?: string | null;           // X handle without @
  content: string;
  mediaType?: string | null;          // 'photo' | 'image' | 'video'
  mediaUrl?: string | null;
  device?: 'desktop' | 'mobile';
}

const X_FONT = '"TwitterChirp", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
const X_BLUE = '#1d9bf0';
// RegExp() rather than a literal: the 'u' flag literal is rejected under the ES5 TS target
const TOKEN_RE = new RegExp('(https?:\\/\\/[^\\s]+|[#@][\\p{L}\\p{N}_]+)', 'gu');
const WORD_CHAR_RE = new RegExp('[\\p{L}\\p{N}_&]', 'u');

function displayUrl(url: string): string {
  const bare = url.replace(/^https?:\/\//, '').replace(/^www\./, '');
  return bare.length > 25 ? `${bare.slice(0, 24)}…` : bare;
}

function renderText(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of Array.from(text.matchAll(TOKEN_RE))) {
    const idx = m.index ?? 0;
    const tok = m[0];
    if (!tok.startsWith('http') && idx > 0 && WORD_CHAR_RE.test(text[idx - 1])) continue; // "a#b" isn't a tag
    if (idx > last) out.push(text.slice(last, idx));
    out.push(
      tok.startsWith('http') ? (
        <a key={idx} href={tok} target="_blank" rel="noopener noreferrer" style={{ color: X_BLUE }} className="hover:underline">{displayUrl(tok)}</a>
      ) : (
        <span key={idx} style={{ color: X_BLUE }}>{tok}</span>
      ),
    );
    last = idx + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function Avatar({ name }: { name: string }) {
  const initials = name.replace(/^@/, '').split(/[\s._]+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
  return (
    <div className="w-10 h-10 rounded-full bg-[#0f1419] text-white flex items-center justify-center text-sm font-bold shrink-0" aria-hidden>
      {initials || 'X'}
    </div>
  );
}

const iconProps = { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: '#536471', strokeWidth: 1.8, 'aria-hidden': true } as const;
const Icons: Record<'reply' | 'repost' | 'like' | 'views' | 'bookmark' | 'share', ReactNode> = {
  reply: <svg {...iconProps}><path d="M4 11.5C4 7.4 7.6 4 12 4s8 3.4 8 7.5S16.4 19 12 19c-1 0-1.9-.1-2.8-.4L5 20.5l1.2-3.6C4.8 15.5 4 13.6 4 11.5z" strokeLinejoin="round" /></svg>,
  repost: <svg {...iconProps}><path d="M7 4 4 7l3 3M4 7h11a4 4 0 0 1 4 4v1M17 20l3-3-3-3M20 17H9a4 4 0 0 1-4-4v-1" strokeLinecap="round" strokeLinejoin="round" /></svg>,
  like: <svg {...iconProps}><path d="M12 20s-7.5-4.4-8.8-9.1C2.3 7.6 4.4 4.5 7.6 4.5c1.9 0 3.3 1.1 4.4 2.6 1.1-1.5 2.5-2.6 4.4-2.6 3.2 0 5.3 3.1 4.4 6.4C19.5 15.6 12 20 12 20z" strokeLinejoin="round" /></svg>,
  views: <svg {...iconProps}><path d="M5 20V10M10 20V4M15 20v-7M20 20v-4" strokeLinecap="round" /></svg>,
  bookmark: <svg {...iconProps}><path d="M6 3h12v18l-6-4-6 4V3z" strokeLinejoin="round" /></svg>,
  share: <svg {...iconProps}><path d="M12 3v12M7 8l5-5 5 5M5 14v6h14v-6" strokeLinecap="round" strokeLinejoin="round" /></svg>,
};

export default function XPostPreview({ displayName, username, content, mediaType, mediaUrl, device = 'desktop' }: Props) {
  const [ratio, setRatio] = useState<number | null>(null);
  const isPhoto = mediaType === 'photo' || mediaType === 'image';
  const isVideo = mediaType === 'video';
  const media = (isPhoto || isVideo) && mediaUrl ? mediaUrl : null;
  const name = displayName || 'Your page';
  const handle = (username || '').replace(/^@+/, '') || name.toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 15) || 'handle';
  // X crops feed photos to fit between roughly 16:9 and 3:4; videos keep their shape
  const shownRatio = isPhoto ? Math.min(16 / 9, Math.max(3 / 4, ratio || 16 / 9)) : ratio || 16 / 9;

  return (
    <article
      aria-label={`X post preview for @${handle}`}
      className="bg-white border border-[#eff3f4] rounded-xl mx-auto text-left px-4 pt-3 pb-2"
      style={{ fontFamily: X_FONT, color: '#0f1419', width: '100%', maxWidth: device === 'mobile' ? 375 : 598 }}
    >
      <div className="flex gap-3">
        <Avatar name={name} />
        <div className="flex-1 min-w-0">
          {/* Header */}
          <div className="flex items-center gap-1 text-[15px] leading-5 min-w-0">
            <span className="font-bold truncate">{name}</span>
            <span className="text-[#536471] truncate">@{handle}</span>
            <span className="text-[#536471]" aria-hidden>·</span>
            <span className="text-[#536471] shrink-0">1m</span>
            <span className="ml-auto text-[#536471] select-none" aria-hidden>···</span>
          </div>

          {/* Text */}
          {content && (
            <div className="text-[15px] leading-5 whitespace-pre-wrap break-words mt-0.5">{renderText(content)}</div>
          )}

          {/* Media */}
          {media && (
            <div className="mt-3 rounded-2xl overflow-hidden border border-[#cfd9de] relative bg-[#f7f9f9]" style={{ aspectRatio: String(shownRatio) }}>
              {isPhoto ? (
                <img src={media} alt="" className="absolute inset-0 w-full h-full object-cover"
                  onLoad={(e) => setRatio(e.currentTarget.naturalWidth / e.currentTarget.naturalHeight)} />
              ) : (
                <video src={media} controls preload="metadata" muted className="absolute inset-0 w-full h-full bg-black"
                  onLoadedMetadata={(e) => { const v = e.currentTarget; if (v.videoWidth && v.videoHeight) setRatio(v.videoWidth / v.videoHeight); }} />
              )}
            </div>
          )}

          {/* Actions */}
          <div className="flex items-center justify-between mt-3 max-w-[425px]">
            {(['reply', 'repost', 'like', 'views'] as const).map((k) => <span key={k} title={k}>{Icons[k]}</span>)}
            <span className="flex gap-3">
              <span title="bookmark">{Icons.bookmark}</span>
              <span title="share">{Icons.share}</span>
            </span>
          </div>
        </div>
      </div>
    </article>
  );
}
