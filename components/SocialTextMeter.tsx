'use client';

import { LINKEDIN_TEXT_MAX, X_TEXT_MAX, X_URL_WEIGHT, xWeightedLength } from '@/lib/social/rules';
import { socialTextIssues, type SocialPlatform } from '@/lib/social/ui';

/** Live LinkedIn / X text length against the platform limit; errors and warnings below. */
export default function SocialTextMeter({
  platform, text, hasMedia = false, hasLink = false, id,
}: { platform: SocialPlatform; text: string; hasMedia?: boolean; hasLink?: boolean; id?: string }) {
  const { errors, warnings } = socialTextIssues(platform, text, { hasMedia, hasLink });
  const len = platform === 'x' ? xWeightedLength(text) : text.length;
  const max = platform === 'x' ? X_TEXT_MAX : LINKEDIN_TEXT_MAX;
  const near = len > max * 0.9;
  return (
    <div id={id} className="text-xs space-y-0.5" aria-live="polite">
      <p className={errors.length ? 'text-red-700' : near ? 'text-amber-700' : 'text-gray-500'}>
        {platform === 'x' ? 'X' : 'LinkedIn'}: {len.toLocaleString('en-US')} / {max.toLocaleString('en-US')} characters
        {platform === 'x' ? ` (links count as ${X_URL_WEIGHT})` : ''}
      </p>
      {errors.map((e) => <p key={e} className="text-red-700">{e}</p>)}
      {warnings.map((w) => <p key={w} className="text-amber-700">{w}</p>)}
    </div>
  );
}
