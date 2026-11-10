-- LinkedIn + X support for facebook-poster (stopgap). Additive and idempotent; safe to re-run.
--
-- Safety (same pattern as Instagram):
-- * n8n "Facebook Daily Scheduled Publisher" filters platform=eq.facebook and the n8n "Instagram
--   Scheduled Publisher" filters platform=eq.instagram, so linkedin / x rows are never picked up by
--   them. LinkedIn and X are published by the app's own runner (/api/publish/social-run).
-- * The app keeps linkedin / x rows out of 'pending' unless LINKEDIN_PUBLISHING_ENABLED /
--   X_PUBLISHING_ENABLED are on, and never sends them to the Facebook webhook.
-- * Apply this migration BEFORE deploying the app version that reads these columns.

-- 1. New platforms and a transient 'publishing' status (claimed by the runner while it posts)
ALTER TABLE public.facebook_scheduled_posts DROP CONSTRAINT IF EXISTS facebook_scheduled_posts_platform_check;
ALTER TABLE public.facebook_scheduled_posts ADD CONSTRAINT facebook_scheduled_posts_platform_check
  CHECK (platform IN ('facebook', 'instagram', 'linkedin', 'x'));

ALTER TABLE public.facebook_scheduled_posts DROP CONSTRAINT IF EXISTS facebook_scheduled_posts_status_check;
ALTER TABLE public.facebook_scheduled_posts ADD CONSTRAINT facebook_scheduled_posts_status_check
  CHECK (status IN ('pending', 'publishing', 'published', 'failed', 'internal_review', 'client_review', 'client_approved'));

-- 2. Result of publishing to LinkedIn / X
ALTER TABLE public.facebook_scheduled_posts
  ADD COLUMN IF NOT EXISTS platform_post_id TEXT,   -- LinkedIn post URN or X post id
  ADD COLUMN IF NOT EXISTS publish_error TEXT,      -- last failure reason (shown in the app)
  ADD COLUMN IF NOT EXISTS publish_started_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_scheduled_posts_platform_status
  ON public.facebook_scheduled_posts(platform, status, scheduled_for);

-- 3. Connected LinkedIn members / X accounts. Tokens are AES-256-GCM encrypted by the app
--    (key SOCIAL_TOKEN_KEY, env only) before they are stored; the database never sees plaintext.
CREATE TABLE IF NOT EXISTS public.fb_social_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider TEXT NOT NULL CHECK (provider IN ('linkedin', 'x')),
  external_id TEXT NOT NULL,                -- LinkedIn member id (sub) or X user id
  display_name TEXT,
  username TEXT,                            -- X handle without @ (null for LinkedIn)
  access_token_enc TEXT NOT NULL,
  refresh_token_enc TEXT,
  access_expires_at TIMESTAMPTZ,
  refresh_expires_at TIMESTAMPTZ,
  scopes TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'needs_reauth', 'disconnected')),
  last_error TEXT,
  connected_by UUID,                        -- auth.users id of the app user who connected it
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, external_id)
);

ALTER TABLE public.fb_social_connections ENABLE ROW LEVEL SECURITY;
-- No policies: only the service role (server routes) can read or write. anon/authenticated get nothing.
REVOKE ALL ON public.fb_social_connections FROM anon, authenticated;

COMMENT ON TABLE public.fb_social_connections IS
  'facebook-poster: connected LinkedIn members and X accounts. Tokens encrypted by the app (SOCIAL_TOKEN_KEY). service_role only.';

-- 4. Which LinkedIn company page / X account each page row publishes to
ALTER TABLE public.facebook_pages
  ADD COLUMN IF NOT EXISTS linkedin_org_id TEXT,
  ADD COLUMN IF NOT EXISTS linkedin_org_name TEXT,
  ADD COLUMN IF NOT EXISTS linkedin_connection_id UUID REFERENCES public.fb_social_connections(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS x_connection_id UUID REFERENCES public.fb_social_connections(id) ON DELETE SET NULL;

ALTER TABLE public.facebook_pages DROP CONSTRAINT IF EXISTS facebook_pages_linkedin_org_id_check;
ALTER TABLE public.facebook_pages ADD CONSTRAINT facebook_pages_linkedin_org_id_check
  CHECK (linkedin_org_id IS NULL OR linkedin_org_id ~ '^[0-9]{1,20}$');

COMMENT ON COLUMN public.facebook_pages.linkedin_org_id IS 'LinkedIn organization id (urn:li:organization:{id}); required for LinkedIn posts.';
COMMENT ON COLUMN public.facebook_pages.linkedin_connection_id IS 'LinkedIn member connection (page admin) used to post for this page.';
COMMENT ON COLUMN public.facebook_pages.x_connection_id IS 'X account connection used for X posts from this page row.';
