'use client';

import { IG_CAPTION_MAX, IG_HASHTAG_MAX, countHashtags, validateIgCaption } from '@/lib/instagram/rules';

/** Live caption length / hashtag count with Instagram's limits; errors and warnings below. */
export default function IgCaptionMeter({ caption, id }: { caption: string; id?: string }) {
  const { errors, warnings } = validateIgCaption(caption);
  const tags = countHashtags(caption);
  return (
    <div id={id} className="text-xs space-y-0.5" aria-live="polite">
      <p className={errors.length ? 'text-red-700' : 'text-gray-500'}>
        Instagram: {caption.length.toLocaleString('en-US')} / {IG_CAPTION_MAX.toLocaleString('en-US')} characters · {tags} / {IG_HASHTAG_MAX} hashtags
      </p>
      {errors.map((e) => <p key={e} className="text-red-700">{e}</p>)}
      {warnings.map((w) => <p key={w} className="text-amber-700">{w}</p>)}
    </div>
  );
}
