import { createClient } from '@/lib/supabase/client';
import { DRAFTS_BUCKET } from './storageRef';

// Browser-side: uploads files straight to Supabase Storage using signed upload targets from
// /api/media/upload-urls (the file never passes through a Vercel function). Returns the
// storage:// reference for each file, in order.

interface UploadTarget {
  path: string;
  token: string;
  ref: string;
  content_type: string;
}

// /api/media/upload-urls accepts at most 200 files per request
const MAX_FILES_PER_REQUEST = 200;

export async function uploadMediaFiles(
  files: File[],
  purpose: 'draft' | 'direct',
  onProgress?: (done: number, total: number) => void,
): Promise<string[]> {
  if (files.length <= MAX_FILES_PER_REQUEST) return uploadChunk(files, purpose, onProgress);
  const refs: string[] = [];
  for (let i = 0; i < files.length; i += MAX_FILES_PER_REQUEST) {
    const offset = i;
    const chunk = await uploadChunk(files.slice(i, i + MAX_FILES_PER_REQUEST), purpose,
      (done) => onProgress?.(offset + done, files.length));
    refs.push(...chunk);
  }
  return refs;
}

async function uploadChunk(
  files: File[],
  purpose: 'draft' | 'direct',
  onProgress?: (done: number, total: number) => void,
): Promise<string[]> {
  if (files.length === 0) return [];
  const res = await fetch('/api/media/upload-urls', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ purpose, files: files.map((f) => ({ name: f.name, type: f.type, size: f.size })) }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = Array.isArray(data.problems)
      ? `: ${data.problems.slice(0, 3).map((p: { index: number; error: string }) => `${files[p.index]?.name}: ${p.error}`).join('; ')}`
      : '';
    throw new Error(`${data.error || 'Could not prepare upload'}${detail}`);
  }
  const targets: UploadTarget[] = Array.isArray(data.uploads) ? data.uploads : [];
  if (targets.length !== files.length) throw new Error('Upload preparation returned the wrong number of targets');

  const bucket = createClient().storage.from(DRAFTS_BUCKET);
  const refs: string[] = new Array(files.length);
  let done = 0;
  let next = 0;
  onProgress?.(0, files.length);
  const worker = async () => {
    while (next < files.length) {
      const i = next++;
      const t = targets[i];
      const { error } = await bucket.uploadToSignedUrl(t.path, t.token, files[i], { contentType: t.content_type });
      if (error) throw new Error(`Upload failed for ${files[i].name}: ${error.message}`);
      refs[i] = t.ref;
      onProgress?.(++done, files.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, files.length) }, worker));
  return refs;
}
