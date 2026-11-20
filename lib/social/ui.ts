'use client';

// Browser helpers for LinkedIn / X in the UI: the publishing-switch status, which pages are mapped
// to a LinkedIn company page / X account, and the per-post checks the create form runs.

import { useEffect, useState } from 'react';
import { socialMediaProblem, validateLinkedInText, validateXText, X_IMAGE_MAX_BYTES, type TextIssues } from './rules';
import { PLATFORM_LABEL, type Platform } from '../instagram/rules';

export type SocialPlatform = 'linkedin' | 'x';

/** GET /api/social/status */
export interface SocialStatus {
  instagram: { enabled: boolean };
  linkedin: { enabled: boolean; configured: boolean };
  x: { enabled: boolean; configured: boolean };
  tokenKeyConfigured: boolean;
}

export const SOCIAL_STATUS_OFF: SocialStatus = {
  instagram: { enabled: false },
  linkedin: { enabled: false, configured: false },
  x: { enabled: false, configured: false },
  tokenKeyConfigured: false,
};

function readBool(v: unknown): boolean {
  return v === true;
}

function readSection(v: unknown): { enabled: boolean; configured: boolean } {
  if (!v || typeof v !== 'object') return { enabled: false, configured: false };
  const o = v as Record<string, unknown>;
  return { enabled: readBool(o.enabled), configured: readBool(o.configured) };
}

/** Parses the status response defensively; anything missing counts as off. */
export function parseSocialStatus(data: unknown): SocialStatus {
  if (!data || typeof data !== 'object') return SOCIAL_STATUS_OFF;
  const o = data as Record<string, unknown>;
  return {
    instagram: { enabled: readSection(o.instagram).enabled },
    linkedin: readSection(o.linkedin),
    x: readSection(o.x),
    tokenKeyConfigured: readBool(o.tokenKeyConfigured),
  };
}

export async function fetchSocialStatus(): Promise<SocialStatus> {
  try {
    const res = await fetch('/api/social/status', { cache: 'no-store' });
    if (!res.ok) return SOCIAL_STATUS_OFF;
    return parseSocialStatus(await res.json());
  } catch {
    return SOCIAL_STATUS_OFF;
  }
}

/** Publishing switches; null until loaded (treat as all off). */
export function useSocialStatus(): SocialStatus | null {
  const [status, setStatus] = useState<SocialStatus | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetchSocialStatus().then((s) => { if (!cancelled) setStatus(s); });
    return () => { cancelled = true; };
  }, []);
  return status;
}

/** Whether a platform's posts may be released to the publisher right now. Facebook always. */
export function platformPublishingOn(platform: Platform, status: SocialStatus | null, igFallback = false): boolean {
  if (platform === 'facebook') return true;
  if (platform === 'instagram') return status ? status.instagram.enabled : igFallback;
  return status ? status[platform].enabled : false;
}

// ---------------------------------------------------------------------------------------------
// Pages

export interface SocialPageFields {
  linkedin_org_id?: string | null;
  linkedin_org_name?: string | null;
  linkedin_connection_id?: string | null;
  x_connection_id?: string | null;
  x_username?: string | null;
  /** from GET /api/pages: 'active' | 'needs_reauth' | 'disconnected' | 'missing' | null (null = not linked) */
  linkedin_connection_status?: string | null;
  x_connection_status?: string | null;
}

/** Mapped AND its connection is active (anything else is "not ready"). */
export const pageHasLinkedIn = (p: SocialPageFields | null | undefined): boolean =>
  !!p?.linkedin_org_id && !!p?.linkedin_connection_id && p?.linkedin_connection_status === 'active';

export const pageHasX = (p: SocialPageFields | null | undefined): boolean =>
  !!p?.x_connection_id && p?.x_connection_status === 'active';

/** Linked, but the connection needs attention (expired, disconnected or deleted). */
export function pageNeedsReconnect(platform: SocialPlatform, p: SocialPageFields | null | undefined): boolean {
  if (!p) return false;
  const linked = platform === 'linkedin' ? !!p.linkedin_org_id && !!p.linkedin_connection_id : !!p.x_connection_id;
  const status = platform === 'linkedin' ? p.linkedin_connection_status : p.x_connection_status;
  return linked && status !== 'active';
}

export const pageReadyFor = (platform: SocialPlatform, p: SocialPageFields | null | undefined): boolean =>
  platform === 'linkedin' ? pageHasLinkedIn(p) : pageHasX(p);

export const NEEDS_RECONNECT: Record<SocialPlatform, string> = {
  linkedin: "This page's LinkedIn account needs to be reconnected (Pages tab → Connected accounts)",
  x: "This page's X account needs to be reconnected (Pages tab → Connected accounts)",
};

export const MISSING_MAPPING: Record<SocialPlatform, string> = {
  linkedin: 'This page has no LinkedIn company page set (Pages tab → LinkedIn column)',
  x: 'This page has no X account set (Pages tab → X column)',
};

// ---------------------------------------------------------------------------------------------
// Text + media checks

// RegExp() rather than a literal: the 'u' flag literal is rejected under the ES5 TS target
const UNDERSCORE_TAG_RE = new RegExp('(^|[^\\p{L}\\p{N}_&])#[\\p{L}\\p{N}]*_', 'u');

export function socialTextIssues(platform: SocialPlatform, text: string, opts: { hasMedia: boolean; hasLink: boolean }): TextIssues {
  if (platform === 'x') return validateXText(text, { hasMedia: opts.hasMedia });
  const r = validateLinkedInText(text, opts);
  // LinkedIn escapes '_' even inside hashtags, so #back_pain only links #back
  if (UNDERSCORE_TAG_RE.test(String(text ?? ''))) {
    return { errors: r.errors, warnings: [...r.warnings, "LinkedIn hashtags stop at '_' (#back_pain only links #back); remove the underscore"] };
  }
  return r;
}

export interface SocialTargetInput {
  platform: SocialPlatform;
  text: string;                       // placeholders already filled in
  pageFound: boolean;
  pageReady: boolean;                 // linkedin org + connection / x connection mapped and active
  /** linked but the connection is not active */
  needsReconnect?: boolean;
  mediaType: 'photo' | 'video' | null;
  /** file name or URL, used to judge the file type; null when no media */
  mediaName: string | null;
  fileSize?: number | null;
  /** LinkedIn: link_url present and no media (article post). Ignored for X. */
  hasLink: boolean;
  /** media is an outside https link (LinkedIn / X need an app upload) */
  externalMediaUrl?: boolean;
  /** X: the row/form has a link_url that X will not use */
  droppedLink?: boolean;
  direct: boolean;                    // not on the approval workflow → goes straight to /api/posts
  enabled: boolean;                   // this platform's publishing switch
  hasSchedule: boolean;
  publishNow?: boolean;
}

/** Everything the create form checks for one LinkedIn / X post before anything is uploaded. */
export function evaluateSocialTarget(input: SocialTargetInput): TextIssues {
  const name = PLATFORM_LABEL[input.platform];
  const errors: string[] = [];
  const warnings: string[] = [];
  if (input.pageFound && !input.pageReady) errors.push(input.needsReconnect ? NEEDS_RECONNECT[input.platform] : MISSING_MAPPING[input.platform]);
  if (input.mediaType && input.externalMediaUrl) {
    errors.push(`${name} media must be uploaded with the post (a file, not a media_url link)`);
  }
  const hasMedia = !!input.mediaType;
  const text = socialTextIssues(input.platform, input.text, { hasMedia, hasLink: input.platform === 'linkedin' && input.hasLink });
  errors.push(...text.errors);
  warnings.push(...text.warnings);
  if (input.mediaType && input.mediaName) {
    const problem = socialMediaProblem(input.platform, input.mediaType, input.mediaName);
    if (problem) errors.push(problem);
  }
  if (input.platform === 'x' && input.mediaType === 'photo' && input.fileSize && input.fileSize > X_IMAGE_MAX_BYTES) {
    errors.push(`X photos must be 5 MB or smaller (this one is ${(input.fileSize / (1024 * 1024)).toFixed(1)} MB)`);
  }
  if (input.platform === 'x' && input.droppedLink) {
    warnings.push('X posts never use link_url; put the URL in the X text if you want it in the post');
  }
  if (input.direct) {
    if (!input.enabled) {
      errors.push(`${name} publishing isn't enabled yet; for now ${name} posts only go through the client approval workflow`);
    } else if (input.publishNow) {
      errors.push(`${name} posts can't be published immediately; schedule them`);
    } else if (!input.hasSchedule) {
      errors.push(`${name} posts need a schedule date`);
    }
  }
  return { errors, warnings };
}

// ---------------------------------------------------------------------------------------------
// Messages

/** "3 LinkedIn and 2 X posts" style list; '' when nothing counted. */
export function platformCountPhrase(counts: Partial<Record<Platform, number>>): string {
  const parts = (['facebook', 'instagram', 'linkedin', 'x'] as const)
    .filter((p) => (counts[p] || 0) > 0)
    .map((p) => `${counts[p]} ${PLATFORM_LABEL[p]}`);
  if (parts.length === 0) return '';
  const total = Object.values(counts).reduce<number>((a, b) => a + (b || 0), 0);
  const list = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
  return `${list} post${total === 1 ? '' : 's'}`;
}

/** Counts posts per platform (missing platform = facebook). */
export function countByPlatform(posts: { platform?: string | null }[]): Partial<Record<Platform, number>> {
  const out: Partial<Record<Platform, number>> = {};
  for (const p of posts) {
    const k: Platform = p.platform === 'instagram' || p.platform === 'linkedin' || p.platform === 'x' ? p.platform : 'facebook';
    out[k] = (out[k] || 0) + 1;
  }
  return out;
}
