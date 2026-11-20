-- Community management inbox (Facebook + Instagram comments and messages) for facebook-poster.
-- Additive and idempotent; safe to re-run. NOT APPLIED. The app keeps the inbox off unless
-- COMMUNITY_INBOX_ENABLED is on, so this can be applied before or after deploying.
--
-- Data minimisation: comments and messages are read live from Meta and never stored. The database
-- keeps (1) each page's access token, encrypted by the app, and (2) which items a person marked done.

-- 1. Page access tokens for the inbox. AES-256-GCM encrypted by the app (SOCIAL_TOKEN_KEY, env only)
--    before they are stored; the database never sees plaintext.
CREATE TABLE IF NOT EXISTS public.fb_page_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  facebook_page_id TEXT NOT NULL UNIQUE CHECK (facebook_page_id ~ '^[0-9]{5,25}$'),
  page_name TEXT,
  ig_user_id TEXT CHECK (ig_user_id IS NULL OR ig_user_id ~ '^[0-9]{5,25}$'),
  ig_username TEXT,
  access_token_enc TEXT NOT NULL,
  scopes TEXT,                         -- permissions granted when connected (comma separated)
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'needs_reauth', 'disconnected')),
  last_error TEXT,
  connected_by TEXT,                   -- email of the app user who connected it
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.fb_page_tokens ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.fb_page_tokens FROM anon, authenticated;
COMMENT ON TABLE public.fb_page_tokens IS
  'facebook-poster inbox: page access tokens, encrypted by the app (SOCIAL_TOKEN_KEY). service_role only.';

-- 2. Inbox items a person marked done (no content, just the id and who/when)
CREATE TABLE IF NOT EXISTS public.fb_inbox_state (
  item_key TEXT PRIMARY KEY CHECK (length(item_key) <= 260),   -- platform:kind:external_id
  facebook_page_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'done' CHECK (status IN ('done')),
  last_action TEXT CHECK (last_action IS NULL OR last_action IN ('done', 'replied', 'hidden', 'unhidden')),
  handled_by TEXT,
  handled_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_inbox_state_page ON public.fb_inbox_state(facebook_page_id);

ALTER TABLE public.fb_inbox_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.fb_inbox_state FROM anon, authenticated;
COMMENT ON TABLE public.fb_inbox_state IS
  'facebook-poster inbox: items marked done (ids only, no comment/message text). service_role only.';
