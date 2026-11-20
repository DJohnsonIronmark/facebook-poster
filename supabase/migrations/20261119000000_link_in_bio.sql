-- Instagram "link in bio" pages for facebook-poster. Additive and idempotent; safe to re-run.
-- NOT APPLIED. Apply BEFORE deploying the app version that reads these columns (the Link in bio tab
-- and /l/<slug> error until then; nothing else is affected).
--
-- * One link in bio page per Instagram account (keyed by ig_user_id, because several facebook_pages
--   rows can share one Instagram account). Off until the team turns it on.
-- * Each Instagram post can carry the link its grid tile opens (bio_link_url) and can be hidden
--   from the grid (bio_hidden).
-- * Public visitors never touch the database: /l/<slug> is rendered on the server with the service
--   role and only shows published, non-hidden Instagram posts of an enabled page.

-- 1. Per-post link and visibility
ALTER TABLE public.facebook_scheduled_posts
  ADD COLUMN IF NOT EXISTS bio_link_url TEXT,
  ADD COLUMN IF NOT EXISTS bio_hidden BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE public.facebook_scheduled_posts DROP CONSTRAINT IF EXISTS facebook_scheduled_posts_bio_link_url_check;
ALTER TABLE public.facebook_scheduled_posts ADD CONSTRAINT facebook_scheduled_posts_bio_link_url_check
  CHECK (bio_link_url IS NULL OR (bio_link_url ~* '^https?://' AND length(bio_link_url) <= 2000));

COMMENT ON COLUMN public.facebook_scheduled_posts.bio_link_url IS
  'Instagram rows: where this post''s tile on the link in bio page goes (http/https).';
COMMENT ON COLUMN public.facebook_scheduled_posts.bio_hidden IS
  'Instagram rows: true = left off the link in bio grid.';

-- 2. Link in bio page settings, one row per Instagram account
CREATE TABLE IF NOT EXISTS public.fb_bio_pages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ig_user_id TEXT NOT NULL UNIQUE CHECK (ig_user_id ~ '^[0-9]{5,25}$'),
  slug TEXT NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9._-]{1,39}$'),
  title TEXT CHECK (title IS NULL OR length(title) <= 80),
  buttons JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(buttons) = 'array'),
  enabled BOOLEAN NOT NULL DEFAULT false,
  updated_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.fb_bio_pages ENABLE ROW LEVEL SECURITY;
-- No policies: only the service role (server routes and the server-rendered public page) reads or writes.
REVOKE ALL ON public.fb_bio_pages FROM anon, authenticated;

COMMENT ON TABLE public.fb_bio_pages IS
  'facebook-poster: Instagram link in bio pages (/l/<slug>). service_role only.';

CREATE INDEX IF NOT EXISTS idx_scheduled_posts_ig_published
  ON public.facebook_scheduled_posts(facebook_page_id, published_at DESC)
  WHERE platform = 'instagram' AND status = 'published';
