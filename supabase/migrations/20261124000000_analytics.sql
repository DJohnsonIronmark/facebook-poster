-- Facebook + Instagram analytics for facebook-poster.
-- Additive and idempotent; safe to re-run. NOT APPLIED until approved. The app keeps analytics off
-- unless ANALYTICS_ENABLED is on, so this can be applied before or after deploying.
--
-- Data minimisation: numbers only, plus each post's public caption excerpt and permalink so top
-- posts can be shown after the app's own post record is removed. No personal data (no commenters,
-- no messages, no audience demographics).

-- 1. Latest lifetime metrics per published post (refreshed daily for ~90 days after publishing)
CREATE TABLE IF NOT EXISTS public.fb_post_metrics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  platform TEXT NOT NULL CHECK (platform IN ('facebook', 'instagram')),
  platform_post_id TEXT NOT NULL CHECK (platform_post_id ~ '^[0-9_]{1,80}$'),
  post_id UUID,                        -- facebook_scheduled_posts.id when the app published it (no FK: metrics outlive "Remove from list")
  facebook_page_id TEXT NOT NULL CHECK (facebook_page_id ~ '^[0-9]{5,25}$'),
  published_at TIMESTAMPTZ,
  media_type TEXT,                     -- photo | video | text (as published)
  caption TEXT CHECK (caption IS NULL OR length(caption) <= 500),
  permalink TEXT CHECK (permalink IS NULL OR length(permalink) <= 500),
  views INTEGER,                       -- Facebook: media views; Instagram: views
  reach INTEGER,                       -- unique accounts reached
  reactions INTEGER,                   -- Facebook reactions / Instagram likes
  comments INTEGER,
  shares INTEGER,
  saves INTEGER,                       -- Instagram only
  clicks INTEGER,                      -- Facebook only
  video_views INTEGER,
  engagements INTEGER,                 -- reactions + comments + shares + saves (+ clicks on Facebook)
  raw JSONB NOT NULL DEFAULT '{}'::jsonb,   -- every metric Meta returned, for future use
  last_error TEXT,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (platform, platform_post_id)
);
CREATE INDEX IF NOT EXISTS idx_post_metrics_page_time ON public.fb_post_metrics(facebook_page_id, published_at DESC);

ALTER TABLE public.fb_post_metrics ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.fb_post_metrics FROM anon, authenticated;
COMMENT ON TABLE public.fb_post_metrics IS
  'facebook-poster analytics: lifetime metrics per published Facebook/Instagram post (numbers only). service_role only.';

-- 2. Daily follower counts per Facebook page / Instagram account
CREATE TABLE IF NOT EXISTS public.fb_account_metrics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  platform TEXT NOT NULL CHECK (platform IN ('facebook', 'instagram')),
  account_id TEXT NOT NULL CHECK (account_id ~ '^[0-9]{5,25}$'),   -- Facebook page id or Instagram user id
  facebook_page_id TEXT NOT NULL CHECK (facebook_page_id ~ '^[0-9]{5,25}$'),
  metric_date DATE NOT NULL,
  followers INTEGER,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (platform, account_id, metric_date)
);
CREATE INDEX IF NOT EXISTS idx_account_metrics_page_date ON public.fb_account_metrics(facebook_page_id, metric_date DESC);

ALTER TABLE public.fb_account_metrics ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.fb_account_metrics FROM anon, authenticated;
COMMENT ON TABLE public.fb_account_metrics IS
  'facebook-poster analytics: daily follower counts per Facebook page / Instagram account. service_role only.';
