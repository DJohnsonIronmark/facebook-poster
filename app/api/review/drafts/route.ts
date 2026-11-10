import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { createServiceClient } from '@/lib/supabase/server';
import { replacePlaceholders } from '@/lib/placeholders';
import { normalizeMediaType } from '@/lib/publisher';
import { fetchLinkPreview } from '@/lib/review/linkPreview';
import { appBaseUrl, notifyDraftsReady, type EmailResult } from '@/lib/review/notify';
import { MAX_POST_LENGTH } from '@/lib/review/types';
import { normalizeIncomingMediaUrl } from '@/lib/media/server';
import { normalizePlatform, type Platform } from '@/lib/instagram/rules';
import { instagramRowProblem } from '@/lib/instagram/server';
import { isSocialPlatform, loadConnectionsLite, pageSocialProblem, socialMediaUrlProblem, socialTextProblem } from '@/lib/social/server';
import { randomUUID } from 'crypto';

export const maxDuration = 300; // large multi-client uploads fetch link previews

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_ROWS = 1000;

interface DraftRow {
  page_id: string;            // facebook_pages.id (uuid)
  post_content: string;
  link_url?: string | null;
  scheduled_for?: string | null;
  media_type?: string | null;
  media_url?: string | null;
  platform?: string | null;        // 'facebook' (default) | 'instagram' | 'linkedin' | 'x'
  post_group_id?: string | null;   // same value on every platform's row of one post (client-generated uuid)
}

/**
 * Client group ids → fresh server-generated ids, so a request can never attach a post to a group
 * that already exists. A group is only kept if all its rows are for one page with one row per platform.
 */
function remapGroups(rows: DraftRow[]): Map<string, string> {
  const seen = new Map<string, { page: string; platforms: string[] }>();
  const bad = new Set<string>();
  for (const r of rows) {
    const g = r.post_group_id ? String(r.post_group_id) : '';
    if (!g) continue;
    if (!UUID_RE.test(g)) { bad.add(g); continue; }
    const platform = normalizePlatform(r.platform) || 'invalid';
    const entry = seen.get(g) || { page: String(r.page_id), platforms: [] };
    if (entry.page !== String(r.page_id) || entry.platforms.includes(platform)) bad.add(g);
    entry.platforms.push(platform);
    seen.set(g, entry);
  }
  const out = new Map<string, string>();
  for (const g of Array.from(seen.keys())) if (!bad.has(g)) out.set(g, randomUUID());
  return out;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx]);
      }
    }),
  );
  return out;
}

// POST - bulk-create drafts for approval-enabled clients (one review batch per client)
export async function POST(request: NextRequest) {
  const { user, error: authError } = await requireRole(['admin', 'manager']);
  if (authError || !user) return authError!;

  const body = await request.json().catch(() => ({}));
  const rows: DraftRow[] = Array.isArray(body.rows) ? body.rows : [];
  const batchLabel = typeof body.batch_name === 'string' ? body.batch_name.trim().slice(0, 120) : '';
  if (rows.length === 0) return NextResponse.json({ error: 'No rows provided' }, { status: 400 });
  if (rows.length > MAX_ROWS) return NextResponse.json({ error: `Max ${MAX_ROWS} rows per upload` }, { status: 400 });

  const supabase = createServiceClient();
  const pageIds = Array.from(new Set(rows.map((r) => String(r.page_id)).filter((id) => UUID_RE.test(id))));
  const { data: pages, error: pagesErr } = await supabase
    .from('facebook_pages')
    .select('id, location_name, location_number, facebook_page_id, city, base_url, phone, ig_user_id, linkedin_org_id, linkedin_org_name, linkedin_connection_id, x_connection_id, client_id, client:fb_clients!client_id(*)')
    .in('id', pageIds);
  if (pagesErr) {
    console.error('drafts: pages lookup', pagesErr);
    return NextResponse.json({ error: 'Failed to load pages' }, { status: 500 });
  }
  const pageById = new Map<string, any>((pages || []).map((p: any) => [p.id, p]));
  const connections = await loadConnectionsLite(supabase, (pages || []).flatMap((p: any) => [p.linkedin_connection_id, p.x_connection_id]));

  const skipped: { row: number; reason: string }[] = [];
  const byClient = new Map<string, { client: any; rows: { row: DraftRow; page: any; index: number; platform: Platform; groupId: string | null }[] }>();
  const groupIds = remapGroups(rows);

  rows.forEach((row, index) => {
    const page = pageById.get(String(row.page_id));
    const content = String(row.post_content || '').trim();
    if (!page) return skipped.push({ row: index + 1, reason: 'page not found' });
    if (!page.client?.approval_workflow_enabled) return skipped.push({ row: index + 1, reason: 'client not enabled for approval workflow' });
    if (!content) return skipped.push({ row: index + 1, reason: 'empty post content' });
    if (content.length > MAX_POST_LENGTH) return skipped.push({ row: index + 1, reason: 'post content too long' });
    const platform = normalizePlatform(row.platform);
    if (!platform) return skipped.push({ row: index + 1, reason: 'platform must be facebook, instagram, linkedin or x' });
    // Uploaded media arrives as a private storage:// reference (kept private until scheduled)
    const media = normalizeIncomingMediaUrl(row.media_url);
    if (!media.ok) return skipped.push({ row: index + 1, reason: 'invalid media_url' });
    if (platform === 'instagram') {
      const values = { city: page.city, franchise_name: page.location_name, location_number: page.location_number, base_url: page.base_url, phone: page.phone };
      const problem = instagramRowProblem({
        caption: replacePlaceholders(content, values),
        mediaType: normalizeMediaType(row.media_type),
        mediaUrl: media.value,
        igUserId: page.ig_user_id,
      });
      if (problem) return skipped.push({ row: index + 1, reason: `Instagram: ${problem}` });
    }
    if (isSocialPlatform(platform)) {
      const values = { city: page.city, franchise_name: page.location_name, location_number: page.location_number, base_url: page.base_url, phone: page.phone };
      const mediaType = normalizeMediaType(row.media_type);
      const mediaUrl = mediaType ? media.value : null;
      const link = platform === 'linkedin' && !mediaType ? replacePlaceholders(String(row.link_url || '').trim(), values) : '';
      const problem = pageSocialProblem(platform, page, connections)
        || socialMediaUrlProblem(platform, mediaType, mediaUrl)
        || socialTextProblem(platform, replacePlaceholders(content, values), { hasMedia: !!mediaUrl, hasLink: !!link });
      if (problem) return skipped.push({ row: index + 1, reason: `${platform === 'x' ? 'X' : 'LinkedIn'}: ${problem}` });
    }
    const groupId = row.post_group_id ? groupIds.get(String(row.post_group_id)) || null : null;
    const entry = byClient.get(page.client.id) || { client: page.client, rows: [] };
    entry.rows.push({ row: { ...row, media_url: media.value }, page, index, platform, groupId });
    byClient.set(page.client.id, entry);
  });

  // Same link is usually repeated across many locations; fetch each URL once
  const previewCache = new Map<string, ReturnType<typeof fetchLinkPreview>>();
  const previewFor = (url: string) => {
    if (!previewCache.has(url)) previewCache.set(url, fetchLinkPreview(url));
    return previewCache.get(url)!;
  };

  const baseUrl = appBaseUrl(request);
  const dateLabel = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const results: { batch_id: string; client: string; posts: number; email: EmailResult }[] = [];

  for (const { client, rows: clientRows } of Array.from(byClient.values())) {
    const name = `${client.name} – ${batchLabel || dateLabel}`;
    const { data: batch, error: batchErr } = await supabase
      .from('fb_review_batches')
      .insert({ client_id: client.id, name, status: 'internal_review', created_by_email: user.email })
      .select('id')
      .single();
    if (batchErr || !batch) {
      console.error('drafts: batch insert', batchErr);
      clientRows.forEach((r) => skipped.push({ row: r.index + 1, reason: 'failed to create review batch' }));
      continue;
    }

    const postRecords = await mapLimit(clientRows, 5, async ({ row, page, platform, groupId }) => {
      const values = {
        city: page.city, franchise_name: page.location_name, location_number: page.location_number,
        base_url: page.base_url, phone: page.phone,
      };
      const mediaType = normalizeMediaType(row.media_type);
      // Instagram has no link cards (links in captions aren't clickable); X keeps links in the text.
      // LinkedIn link_url becomes an article post.
      const linkUrl = mediaType || platform === 'instagram' || platform === 'x' ? null : replacePlaceholders(String(row.link_url || '').trim(), values) || null;
      const scheduled = row.scheduled_for ? new Date(row.scheduled_for) : null;
      return {
        facebook_page_id: page.facebook_page_id,
        franchise_name: page.location_name,
        location_number: page.location_number || null,
        post_content: replacePlaceholders(String(row.post_content).trim(), values),
        link_url: linkUrl,
        media_type: mediaType,
        media_url: mediaType ? String(row.media_url || '').trim() || null : null,
        scheduled_for: scheduled && !isNaN(scheduled.getTime()) ? scheduled.toISOString() : null,
        status: 'internal_review',
        review_batch_id: batch.id,
        client_id: client.id,
        platform,
        post_group_id: groupId,
        link_preview: linkUrl ? await previewFor(linkUrl) : null,
      };
    });

    const { data: inserted, error: postErr } = await supabase
      .from('facebook_scheduled_posts')
      .insert(postRecords)
      .select('id, post_content, link_url, media_url');
    if (postErr || !inserted) {
      console.error('drafts: posts insert', postErr);
      await supabase.from('fb_review_batches').delete().eq('id', batch.id);
      clientRows.forEach((r) => skipped.push({ row: r.index + 1, reason: 'failed to save post' }));
      continue;
    }

    await supabase.from('fb_post_revisions').insert(
      inserted.map((p: any) => ({
        post_id: p.id, stage: 'draft', post_content: p.post_content, link_url: p.link_url, media_url: p.media_url, edited_by: user.email,
      })),
    );

    const email = await notifyDraftsReady({
      accountManager: client.account_manager_email,
      clientName: client.name, batchName: name, postCount: inserted.length, uploadedBy: user.email, baseUrl,
    });
    results.push({ batch_id: batch.id, client: client.name, posts: inserted.length, email });
  }

  return NextResponse.json({ success: results.length > 0, batches: results, skipped });
}
