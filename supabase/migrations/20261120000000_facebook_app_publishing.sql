-- facebook-poster: per-page choice of who publishes Facebook posts.
--   publish_via = 'n8n' (default): the n8n "Facebook Daily Scheduled Publisher" + same-day webhook,
--                                  using n8n's shared "Facebook Graph User" credential (today's behaviour).
--   publish_via = 'app'          : the app runner (/api/publish/social-run) with the page's own token
--                                  from fb_page_tokens (saved by "Connect pages").
--
-- The post column is a copy of its page's setting so n8n can filter with one query parameter
-- (publish_via=eq.n8n). Triggers keep it in sync, whatever code path inserts the post:
--   * BEFORE INSERT / UPDATE OF facebook_page_id on posts → copy from the page
--   * AFTER UPDATE OF publish_via on pages → copy to that page's posts that are not published yet
--
-- ROLLOUT ORDER (each step safe on its own):
--   1. apply this migration (every page and post = 'n8n'; nothing changes)
--   2. n8n Daily Publisher: add publish_via=eq.n8n to "Fetch Scheduled Posts"
--   3. FACEBOOK_APP_PUBLISHING_ENABLED=true in Vercel
--   4. move pages to 'app' one at a time on the Pages tab
-- Step 2 must never come before step 1: a filter on a missing column breaks ALL Facebook publishing.
--
-- Additive only (no DROP statements) and re-runnable: constraints are added only if missing and the
-- triggers use CREATE OR REPLACE. The trigger functions need no REVOKE: Postgres refuses to call a
-- trigger function directly, and they are not SECURITY DEFINER.

ALTER TABLE public.facebook_pages
  ADD COLUMN IF NOT EXISTS publish_via TEXT NOT NULL DEFAULT 'n8n';
ALTER TABLE public.facebook_scheduled_posts
  ADD COLUMN IF NOT EXISTS publish_via TEXT NOT NULL DEFAULT 'n8n';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'facebook_pages_publish_via_check') THEN
    ALTER TABLE public.facebook_pages
      ADD CONSTRAINT facebook_pages_publish_via_check CHECK (publish_via IN ('n8n', 'app'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'facebook_scheduled_posts_publish_via_check') THEN
    ALTER TABLE public.facebook_scheduled_posts
      ADD CONSTRAINT facebook_scheduled_posts_publish_via_check CHECK (publish_via IN ('n8n', 'app'));
  END IF;
END;
$$;

COMMENT ON COLUMN public.facebook_pages.publish_via IS
  'Who publishes this page''s Facebook posts: n8n (shared credential) or app (page token in fb_page_tokens).';
COMMENT ON COLUMN public.facebook_scheduled_posts.publish_via IS
  'Copy of facebook_pages.publish_via, kept in sync by triggers. n8n Daily Publisher filters publish_via=eq.n8n.';

-- Posts: copy the page's setting on insert or when the post moves to another page
CREATE OR REPLACE FUNCTION public.fb_post_copy_publish_via()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.publish_via := COALESCE(
    (SELECT p.publish_via FROM public.facebook_pages p WHERE p.facebook_page_id = NEW.facebook_page_id LIMIT 1),
    'n8n'
  );
  RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER trg_fb_post_copy_publish_via
  BEFORE INSERT OR UPDATE OF facebook_page_id ON public.facebook_scheduled_posts
  FOR EACH ROW EXECUTE FUNCTION public.fb_post_copy_publish_via();

-- Pages: when the setting changes, move the page's unpublished posts with it
CREATE OR REPLACE FUNCTION public.fb_page_cascade_publish_via()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.publish_via IS DISTINCT FROM OLD.publish_via THEN
    UPDATE public.facebook_scheduled_posts
       SET publish_via = NEW.publish_via
     WHERE facebook_page_id = NEW.facebook_page_id
       AND status NOT IN ('published', 'publishing');
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER trg_fb_page_cascade_publish_via
  AFTER UPDATE OF publish_via ON public.facebook_pages
  FOR EACH ROW EXECUTE FUNCTION public.fb_page_cascade_publish_via();
