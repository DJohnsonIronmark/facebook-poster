import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { fetchLinkPreview } from '@/lib/review/linkPreview';

// GET ?url= — Open Graph card data for live previews (signed-in users only)
export async function GET(request: NextRequest) {
  const { error: authError } = await requireAuth();
  if (authError) return authError;
  const url = new URL(request.url).searchParams.get('url');
  if (!url || url.length > 2048) return NextResponse.json({ preview: null });
  return NextResponse.json({ preview: await fetchLinkPreview(url) });
}
