'use client';

import { useState, type ReactNode } from 'react';
import type { PreviewLinkCard } from './FacebookPostPreview';

// Renders a post the way it appears in the LinkedIn feed for a company page (light theme), so
// reviewers and clients approve what will be published. Media URLs arrive already resolved
// (local object URLs in the create form, signed URLs for private drafts in review).

interface Props {
  orgName: string;                    // LinkedIn company page name (falls back to the page name)
  content: string;
  linkUrl?: string | null;            // article post when there is no media
  linkPreview?: PreviewLinkCard | null;
  mediaType?: string | null;          // 'photo' | 'image' | 'video'
  mediaUrl?: string | null;
  device?: 'desktop' | 'mobile';
}

const LI_FONT = '-apple-system, system-ui, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", "Fira Sans", Ubuntu, Oxygen, Arial, sans-serif';
const LI_BLUE = '#0a66c2';
const TRUNCATE_AT = 210;
const MAX_LINES = 3;
// RegExp() rather than a literal: the 'u' flag literal is rejected under the ES5 TS target
const TOKEN_RE = new RegExp('(https?:\\/\\/[^\\s]+|#[\\p{L}\\p{N}_]+)', 'gu');

function renderText(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of Array.from(text.matchAll(TOKEN_RE))) {
    const idx = m.index ?? 0;
    if (idx > last) out.push(text.slice(last, idx));
    const tok = m[0];
    out.push(
      tok.startsWith('#') ? (
        <span key={idx} style={{ color: LI_BLUE, fontWeight: 600 }}>{tok}</span>
      ) : (
        <a key={idx} href={tok} target="_blank" rel="noopener noreferrer" style={{ color: LI_BLUE, fontWeight: 600 }} className="hover:underline break-all">{tok}</a>
      ),
    );
    last = idx + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function truncate(text: string): string {
  const lines = text.split('\n').slice(0, MAX_LINES).join('\n');
  const cut = lines.length > TRUNCATE_AT ? lines.slice(0, TRUNCATE_AT) : lines;
  return cut.replace(/\s+\S*$/, '').trimEnd() || cut;
}

function safeDomain(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
}

function Logo({ name }: { name: string }) {
  const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
  return (
    <div className="w-12 h-12 rounded-full flex items-center justify-center text-white text-sm font-semibold shrink-0" style={{ background: LI_BLUE }} aria-hidden>
      {initials || 'in'}
    </div>
  );
}

const iconProps = { width: 20, height: 20, viewBox: '0 0 24 24', fill: 'none', stroke: '#666', strokeWidth: 1.7, 'aria-hidden': true } as const;
const Icons: Record<'like' | 'comment' | 'repost' | 'send', ReactNode> = {
  like: <svg {...iconProps}><path d="M7 10v10H4V10h3zm0 0 4-7c1.3 0 2.2 1 2.2 2.2V9h5.2c1.1 0 1.9 1 1.6 2.1l-1.6 6.6c-.2.8-1 1.3-1.8 1.3H7" strokeLinejoin="round" /></svg>,
  comment: <svg {...iconProps}><path d="M4 5h16v11H9l-5 4V5z" strokeLinejoin="round" /></svg>,
  repost: <svg {...iconProps}><path d="M17 3l3 3-3 3M20 6H8a4 4 0 0 0-4 4v1M7 21l-3-3 3-3M4 18h12a4 4 0 0 0 4-4v-1" strokeLinecap="round" strokeLinejoin="round" /></svg>,
  send: <svg {...iconProps}><path d="M21 3 3 10.5l7 2.5 2.5 7L21 3zM10 13l5-5" strokeLinejoin="round" /></svg>,
};

const globe = (
  <svg viewBox="0 0 16 16" width="12" height="12" fill="#666" aria-label="Visible to anyone on or off LinkedIn">
    <path d="M8 0a8 8 0 1 0 0 16A8 8 0 0 0 8 0zm5.9 7h-2.5a12 12 0 0 0-.9-4.4A6 6 0 0 1 13.9 7zM8 2c.6.7 1.4 2.4 1.5 5h-3C6.6 4.4 7.4 2.7 8 2zM5.5 2.6A12 12 0 0 0 4.6 7H2.1a6 6 0 0 1 3.4-4.4zM2.1 9h2.5c.1 1.6.4 3.1.9 4.4A6 6 0 0 1 2.1 9zM8 14c-.6-.7-1.4-2.4-1.5-5h3c-.1 2.6-.9 4.3-1.5 5zm2.5-.6c.5-1.3.8-2.8.9-4.4h2.5a6 6 0 0 1-3.4 4.4z" />
  </svg>
);

export default function LinkedInPostPreview({ orgName, content, linkUrl, linkPreview, mediaType, mediaUrl, device = 'desktop' }: Props) {
  const [expanded, setExpanded] = useState(false);
  const isPhoto = mediaType === 'photo' || mediaType === 'image';
  const isVideo = mediaType === 'video';
  const media = (isPhoto || isVideo) && mediaUrl ? mediaUrl : null;
  const card: PreviewLinkCard | null = !media && linkUrl ? linkPreview || { url: linkUrl, domain: safeDomain(linkUrl) } : null;
  const name = orgName || 'Company page';

  const needsTruncate = !expanded && (content.length > TRUNCATE_AT || content.split('\n').length > MAX_LINES);
  const shown = needsTruncate ? truncate(content) : content;

  return (
    <article
      aria-label={`LinkedIn post preview for ${name}`}
      className="bg-white rounded-lg border border-[#e0dfdc] overflow-hidden mx-auto text-left"
      style={{ fontFamily: LI_FONT, color: 'rgba(0,0,0,0.9)', width: '100%', maxWidth: device === 'mobile' ? 375 : 555 }}
    >
      {/* Header */}
      <div className="flex items-start gap-2 px-4 pt-3 pb-2">
        <Logo name={name} />
        <div className="flex-1 min-w-0">
          <div className="font-semibold text-sm leading-5 truncate">{name}</div>
          <div className="text-xs leading-4 text-[#666] truncate">Company page</div>
          <div className="flex items-center gap-1 text-xs leading-4 text-[#666]">
            <span>1m</span><span aria-hidden>•</span>{globe}
          </div>
        </div>
        <div className="text-[#666] text-xl leading-none px-1 select-none" aria-hidden>···</div>
      </div>

      {/* Text */}
      {content && (
        <div className="px-4 pb-2 text-sm leading-5 whitespace-pre-wrap break-words">
          {renderText(shown)}
          {needsTruncate && (
            <>
              {'…'}
              <button type="button" onClick={() => setExpanded(true)} className="text-[#666] hover:underline hover:text-[#0a66c2] ml-0.5">
                see more
              </button>
            </>
          )}
        </div>
      )}

      {/* Media */}
      {media && isPhoto && (
        <img src={media} alt="" className="w-full max-h-[640px] object-contain bg-[#f3f2ef] mt-1" />
      )}
      {media && isVideo && (
        <div className="bg-black mt-1">
          <video src={media} controls preload="metadata" muted className="w-full max-h-[640px]" />
        </div>
      )}

      {/* Article card */}
      {card && (
        <a href={card.url} target="_blank" rel="noopener noreferrer" className="block mt-1 bg-[#eef3f8]">
          {card.image && <img src={card.image} alt="" className="w-full object-cover" style={{ aspectRatio: '1.91 / 1' }} />}
          <div className="px-3 py-2">
            <div className="text-sm font-semibold leading-5 line-clamp-2">{card.title || card.url}</div>
            <div className="text-xs leading-4 text-[#666] truncate mt-0.5">{card.domain.toLowerCase()}</div>
          </div>
        </a>
      )}

      {/* Action bar */}
      <div className="mx-3 mt-2 border-t border-[#e0dfdc] flex text-sm font-semibold text-[#666]">
        {([['like', 'Like'], ['comment', 'Comment'], ['repost', 'Repost'], ['send', 'Send']] as const).map(([k, label]) => (
          <div key={k} className="flex-1 flex items-center justify-center gap-1.5 py-3">
            {Icons[k]}
            <span className={device === 'mobile' ? 'sr-only' : undefined}>{label}</span>
          </div>
        ))}
      </div>
    </article>
  );
}
