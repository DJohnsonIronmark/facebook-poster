-- Client approval workflow for facebook-poster
-- Additive only: new tables + nullable columns + widened CHECK constraints.
-- n8n publishers select status = 'pending' AND scheduled_for IS NOT NULL, so the
-- new review statuses below are never picked up until a team member schedules them.

-- 1. Clients (per-client opt-in to the approval workflow)
CREATE TABLE IF NOT EXISTS public.fb_clients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  approval_workflow_enabled BOOLEAN NOT NULL DEFAULT false,
  internal_reviewer_emails TEXT[] NOT NULL DEFAULT '{}',  -- Ironmark team member(s) on the client
  client_reviewer_emails TEXT[] NOT NULL DEFAULT '{}',    -- client-side approvers
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.facebook_pages
  ADD COLUMN IF NOT EXISTS client_id UUID REFERENCES public.fb_clients(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_facebook_pages_client_id ON public.facebook_pages(client_id);

-- 2. Review batches (one per client per upload)
CREATE TABLE IF NOT EXISTS public.fb_review_batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES public.fb_clients(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'internal_review'
    CHECK (status IN ('internal_review', 'client_review', 'client_approved', 'scheduled', 'cancelled')),
  client_token_hash TEXT UNIQUE,          -- sha256 of the magic-link token; raw token is never stored
  client_token_expires_at TIMESTAMPTZ,
  created_by_email TEXT,
  internal_approved_by_email TEXT,
  internal_approved_at TIMESTAMPTZ,
  sent_to_client_at TIMESTAMPTZ,
  client_approved_by TEXT,                -- name/email the client typed when approving
  client_approved_at TIMESTAMPTZ,
  scheduled_by_email TEXT,
  scheduled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_fb_review_batches_client ON public.fb_review_batches(client_id);
CREATE INDEX IF NOT EXISTS idx_fb_review_batches_status ON public.fb_review_batches(status);

-- 3. Post columns for the workflow
ALTER TABLE public.facebook_scheduled_posts
  ADD COLUMN IF NOT EXISTS review_batch_id UUID REFERENCES public.fb_review_batches(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS client_id UUID REFERENCES public.fb_clients(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS client_comment TEXT,
  ADD COLUMN IF NOT EXISTS link_preview JSONB;   -- cached og:title/description/image/site for in-platform preview
CREATE INDEX IF NOT EXISTS idx_scheduled_posts_review_batch ON public.facebook_scheduled_posts(review_batch_id);

ALTER TABLE public.facebook_scheduled_posts DROP CONSTRAINT IF EXISTS facebook_scheduled_posts_status_check;
ALTER TABLE public.facebook_scheduled_posts ADD CONSTRAINT facebook_scheduled_posts_status_check
  CHECK (status IN ('pending', 'published', 'failed', 'internal_review', 'client_review', 'client_approved'));

-- n8n routes on media_type = 'photo' | 'video' and the app sends 'photo';
-- the old constraint only allowed 'image', so photo posts failed to insert. Keep 'image' for any legacy rows.
ALTER TABLE public.facebook_scheduled_posts DROP CONSTRAINT IF EXISTS facebook_scheduled_posts_media_type_check;
ALTER TABLE public.facebook_scheduled_posts ADD CONSTRAINT facebook_scheduled_posts_media_type_check
  CHECK (media_type IS NULL OR media_type IN ('photo', 'image', 'video'));

-- 4. Revision history (audit of every edit during review)
CREATE TABLE IF NOT EXISTS public.fb_post_revisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id UUID NOT NULL REFERENCES public.facebook_scheduled_posts(id) ON DELETE CASCADE,
  stage TEXT NOT NULL CHECK (stage IN ('draft', 'internal_edit', 'client_edit', 'final_upload')),
  post_content TEXT NOT NULL,
  link_url TEXT,
  media_url TEXT,
  edited_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_fb_post_revisions_post ON public.fb_post_revisions(post_id);

-- 5. RLS: default-deny; service_role only (all access goes through server routes)
ALTER TABLE public.fb_clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fb_review_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fb_post_revisions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS service_role_all ON public.fb_clients;
CREATE POLICY service_role_all ON public.fb_clients
  FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS service_role_all ON public.fb_review_batches;
CREATE POLICY service_role_all ON public.fb_review_batches
  FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS service_role_all ON public.fb_post_revisions;
CREATE POLICY service_role_all ON public.fb_post_revisions
  FOR ALL TO service_role USING (true) WITH CHECK (true);

REVOKE ALL ON public.fb_clients, public.fb_review_batches, public.fb_post_revisions FROM anon, authenticated;
