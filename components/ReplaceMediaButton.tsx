'use client';

import { useRef, useState } from 'react';
import { uploadMediaFiles } from '@/lib/media/upload';
import { validateIgVideo } from '@/lib/instagram/rules';
import { prepareInstagramImage, readVideoMeta } from '@/lib/instagram/browser';
import { socialMediaProblem, X_IMAGE_MAX_BYTES } from '@/lib/social/rules';

// Replace a post's photo/video during review. The file goes straight to the PRIVATE drafts bucket
// (signed upload), then the post is PATCHed with the storage reference. Instagram photos get the
// same JPEG conversion + crop as bulk upload; Instagram videos are length-checked. LinkedIn and X
// use the original file like Facebook (only the file type, and X's 5 MB photo limit, are checked).

interface Props {
  postId: string;
  platform: string | null | undefined;
  mediaType: 'photo' | 'video';
  onReplaced: () => void;
}

export default function ReplaceMediaButton({ postId, platform, mediaType, onReplaced }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const isIg = platform === 'instagram';

  const handle = async (file: File) => {
    setBusy(true);
    setMessage(null);
    try {
      const isImage = file.type.startsWith('image/');
      const isVideo = file.type.startsWith('video/');
      if (mediaType === 'photo' && !isImage) throw new Error('Choose an image (JPG, PNG, GIF or WEBP)');
      if (mediaType === 'video' && !isVideo) throw new Error('Choose a video (MP4 or MOV)');

      let upload = file;
      const notes: string[] = [];
      if (isIg && mediaType === 'photo') {
        const prepared = await prepareInstagramImage(file);
        upload = prepared.file;
        if (prepared.plan.note) notes.push(prepared.plan.note);
        notes.push(...prepared.warnings);
      } else if (isIg && mediaType === 'video') {
        const issues = validateIgVideo(await readVideoMeta(file));
        if (issues.errors.length) throw new Error(issues.errors.join('; '));
        notes.push(...issues.warnings);
      } else if (platform === 'linkedin' || platform === 'x') {
        const problem = socialMediaProblem(platform, mediaType, file.name);
        if (problem) throw new Error(problem);
        if (platform === 'x' && mediaType === 'photo' && file.size > X_IMAGE_MAX_BYTES) throw new Error('X photos must be 5 MB or smaller');
      }

      const [ref] = await uploadMediaFiles([upload], 'draft');
      const res = await fetch(`/api/review/posts/${postId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ media_url: ref }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Could not save the new file');
      setMessage({ kind: 'ok', text: `Replaced${notes.length ? ` (${notes.join('; ')})` : ''}.` });
      onReplaced();
    } catch (e) {
      setMessage({ kind: 'error', text: e instanceof Error ? e.message : 'Replace failed' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <span className="inline-flex flex-col items-end gap-1">
      <button type="button" disabled={busy} onClick={() => inputRef.current?.click()}
        className="px-3 py-1 rounded-lg bg-gray-100 text-gray-800 hover:bg-gray-200 disabled:opacity-50">
        {busy ? 'Uploading…' : `Replace ${mediaType}`}
      </button>
      <input ref={inputRef} type="file" className="hidden" aria-label={`Replace ${mediaType}`}
        accept={mediaType === 'photo' ? 'image/jpeg,image/png,image/gif,image/webp' : 'video/mp4,video/quicktime'}
        onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void handle(f); }} />
      {message && (
        <span className={`text-xs ${message.kind === 'ok' ? 'text-green-700' : 'text-red-600'}`} role="status">{message.text}</span>
      )}
    </span>
  );
}
