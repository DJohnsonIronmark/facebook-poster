-- Private bucket for draft post media (client work product awaiting approval).
--
-- * public = false and NO storage.objects policies for anon/authenticated: only the service role
--   (server routes) can read or write. Browsers upload with one-time signed upload URLs minted
--   server-side (/api/media/upload-urls) and preview with short-lived signed URLs.
-- * Posts store the object as media_url = 'storage://facebook-media-drafts/drafts/<yyyy-mm>/<uuid>.<ext>'
--   (no new column). When a post is scheduled the app copies the object into the existing PUBLIC
--   'facebook-media' bucket (path scheduled/<yyyy-mm>/<uuid>.<ext>) and points media_url at the
--   public URL before the post becomes 'pending', because Facebook/n8n fetch media unauthenticated.
-- * Limits mirror the app: photos JPG/PNG/GIF/WEBP (app enforces 10 MB), videos MP4/MOV (100 MB).
--   The bucket cap is the larger of the two; the app re-checks real size/type before publishing.

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'facebook-media-drafts',
  'facebook-media-drafts',
  false,
  104857600,
  ARRAY['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'video/mp4', 'video/quicktime']
)
ON CONFLICT (id) DO UPDATE
  SET public = false,
      file_size_limit = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types;
