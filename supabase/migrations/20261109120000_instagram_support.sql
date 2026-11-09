-- Instagram support for facebook-poster (app side). Additive and idempotent; safe to re-run.
--
-- * Every existing row gets platform = 'facebook' (column default), so current behaviour is unchanged.
-- * The live n8n "Facebook Daily Scheduled Publisher" selects status = 'pending' AND
--   scheduled_for IS NOT NULL with NO platform filter and posts to Facebook. Before any
--   Instagram row may become 'pending', that workflow must add the filter platform=eq.facebook
--   (and an Instagram branch must exist). Until then the app keeps Instagram rows out of
--   'pending' (server switch INSTAGRAM_PUBLISHING_ENABLED, default off) and never sends them to
--   the Facebook webhook.
-- * Apply this migration BEFORE deploying the app version that reads these columns.

-- 1. Which network a post publishes to
ALTER TABLE public.facebook_scheduled_posts
  ADD COLUMN IF NOT EXISTS platform TEXT NOT NULL DEFAULT 'facebook';

ALTER TABLE public.facebook_scheduled_posts DROP CONSTRAINT IF EXISTS facebook_scheduled_posts_platform_check;
ALTER TABLE public.facebook_scheduled_posts ADD CONSTRAINT facebook_scheduled_posts_platform_check
  CHECK (platform IN ('facebook', 'instagram'));

-- 2. Links the Facebook and Instagram versions of one post (one CSV row with platforms = fb,ig)
ALTER TABLE public.facebook_scheduled_posts
  ADD COLUMN IF NOT EXISTS post_group_id UUID;
CREATE INDEX IF NOT EXISTS idx_scheduled_posts_post_group ON public.facebook_scheduled_posts(post_group_id)
  WHERE post_group_id IS NOT NULL;

COMMENT ON COLUMN public.facebook_scheduled_posts.platform IS
  'facebook | instagram. Existing rows default to facebook. n8n publishers must filter platform=eq.facebook before instagram rows can be pending.';
COMMENT ON COLUMN public.facebook_scheduled_posts.post_group_id IS
  'Shared by the Facebook and Instagram versions of the same post (review UIs show them side by side).';

-- 3. Instagram Business/Creator account linked to each Facebook Page
ALTER TABLE public.facebook_pages
  ADD COLUMN IF NOT EXISTS ig_user_id TEXT,     -- numeric IG business account id (Graph API {ig-user-id})
  ADD COLUMN IF NOT EXISTS ig_username TEXT;    -- display handle, without @

ALTER TABLE public.facebook_pages DROP CONSTRAINT IF EXISTS facebook_pages_ig_user_id_check;
ALTER TABLE public.facebook_pages ADD CONSTRAINT facebook_pages_ig_user_id_check
  CHECK (ig_user_id IS NULL OR ig_user_id ~ '^[0-9]{5,25}$');

COMMENT ON COLUMN public.facebook_pages.ig_user_id IS
  'Numeric Instagram business account id linked to this Facebook Page; required for Instagram posts.';
COMMENT ON COLUMN public.facebook_pages.ig_username IS 'Instagram handle without @ (preview display only).';
