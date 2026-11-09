import { randomUUID } from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, requireRole } from '@/lib/auth';
import { createServiceClient } from '@/lib/supabase/server';
import { validateMediaFile } from '@/lib/media/mapping';
import { DRAFTS_BUCKET, draftPathFor, formatStorageRef } from '@/lib/media/storageRef';

// POST { purpose: 'draft' | 'direct', files: [{ name, type, size }] }
//   → { uploads: [{ path, token, ref, content_type }] } in the same order
//
// Returns one-time signed upload targets in the PRIVATE drafts bucket so the browser uploads
// straight to Supabase Storage (no Vercel ~4.5 MB request-body limit). Paths are generated here;
// the client's file name is only used to validate type/extension. Files become public only
// when their post is scheduled (copied to the public bucket server-side).

const MAX_FILES = 200;

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  const purpose = body?.purpose === 'draft' ? 'draft' : body?.purpose === 'direct' ? 'direct' : null;
  if (!purpose) return NextResponse.json({ error: "purpose must be 'draft' or 'direct'" }, { status: 400 });

  // Approval-workflow drafts follow /api/review/drafts (admin/manager); direct posts follow /api/posts
  const { error: authError } = purpose === 'draft' ? await requireRole(['admin', 'manager']) : await requireAuth();
  if (authError) return authError;

  const files: unknown[] = Array.isArray(body?.files) ? body.files : [];
  if (files.length === 0) return NextResponse.json({ error: 'No files provided' }, { status: 400 });
  if (files.length > MAX_FILES) return NextResponse.json({ error: `Max ${MAX_FILES} files per request` }, { status: 400 });

  const problems: { index: number; error: string }[] = [];
  const checked = files.map((f, index) => {
    const rec = (f && typeof f === 'object' ? f : {}) as Record<string, unknown>;
    const v = validateMediaFile({
      name: typeof rec.name === 'string' ? rec.name.slice(0, 255) : '',
      type: typeof rec.type === 'string' ? rec.type.slice(0, 100) : '',
      size: typeof rec.size === 'number' ? rec.size : NaN,
    });
    if (!v.ok) problems.push({ index, error: v.message });
    return v;
  });
  if (problems.length > 0) return NextResponse.json({ error: 'Some files are not allowed', problems }, { status: 400 });

  const supabase = createServiceClient();
  const bucket = supabase.storage.from(DRAFTS_BUCKET);
  const uploads: { path: string; token: string; ref: string; content_type: string }[] = [];
  for (const v of checked) {
    if (!v.ok) continue; // unreachable: rejected above
    const path = draftPathFor(v.ext, randomUUID());
    const { data, error } = await bucket.createSignedUploadUrl(path);
    if (error || !data) {
      console.error('upload-urls: createSignedUploadUrl', error);
      return NextResponse.json({ error: 'Could not prepare upload' }, { status: 500 });
    }
    uploads.push({ path: data.path, token: data.token, ref: formatStorageRef(path), content_type: v.contentType });
  }
  return NextResponse.json({ uploads });
}
