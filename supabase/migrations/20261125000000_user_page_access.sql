-- Per-user access to social accounts, from each person's own platform login, for facebook-poster.
-- Additive and idempotent; safe to re-run. NOT APPLIED until approved. Enforcement stays off until
-- PAGE_ACCESS_ENFORCED is on, so people can verify their access first (make-before-break).
--
-- A non-admin user sees a page (and its posts, analytics, inbox, link in bio) only for the platform
-- accounts listed here for them. Admins see everything.
--   facebook  → account_id = facebook_page_id (Instagram follows the page it is linked to)
--   linkedin  → account_id = LinkedIn organization id (ADMINISTRATOR / CONTENT_ADMIN role)  [later]
--   x         → account_id = X user id (the person who connected it, or granted by an admin) [later]

CREATE TABLE IF NOT EXISTS public.fb_user_account_access (
  user_id UUID NOT NULL,                       -- auth.users.id
  platform TEXT NOT NULL CHECK (platform IN ('facebook', 'linkedin', 'x')),
  account_id TEXT NOT NULL CHECK (account_id ~ '^[0-9A-Za-z_:-]{1,80}$'),
  source TEXT NOT NULL DEFAULT 'platform' CHECK (source IN ('platform', 'admin')),  -- verified login, or granted by an admin
  refreshed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, platform, account_id)
);
CREATE INDEX IF NOT EXISTS idx_user_access_account ON public.fb_user_account_access(platform, account_id);

ALTER TABLE public.fb_user_account_access ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.fb_user_account_access FROM anon, authenticated;
COMMENT ON TABLE public.fb_user_account_access IS
  'facebook-poster: which social accounts each user can access on the platforms (ids only). service_role only.';

-- Each user's platform login token for the daily access re-check (encrypted by the app with
-- SOCIAL_TOKEN_KEY; the database never sees plaintext). Deleted when the user disconnects.
CREATE TABLE IF NOT EXISTS public.fb_user_platform_logins (
  user_id UUID NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('facebook', 'linkedin', 'x')),
  access_token_enc TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'needs_reauth')),
  last_error TEXT,
  verified_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, platform)
);

ALTER TABLE public.fb_user_platform_logins ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.fb_user_platform_logins FROM anon, authenticated;
COMMENT ON TABLE public.fb_user_platform_logins IS
  'facebook-poster: per-user platform login tokens (encrypted by the app) for daily access re-checks. service_role only.';
