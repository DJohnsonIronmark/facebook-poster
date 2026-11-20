import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { createServiceClient } from '@/lib/supabase/server';
import { cleanBioSlug } from '@/lib/bio/rules';
import { loadPublicBioPage } from '@/lib/bio/server';

// Public Instagram "link in bio" page: /l/<slug>. No login. Rendered on the server with the service
// role; only published, non-hidden Instagram posts of an enabled page are shown. Re-rendered at most
// once a minute so new posts and link edits appear quickly without a database hit per visitor.

export const revalidate = 60;

async function load(slugParam: string) {
  const slug = cleanBioSlug(decodeURIComponent(slugParam));
  if (!slug.ok) return null;
  return loadPublicBioPage(createServiceClient(), slug.value);
}

export async function generateMetadata({ params }: { params: { slug: string } }): Promise<Metadata> {
  const page = await load(params.slug);
  return {
    title: page ? page.title : 'Not found',
    referrer: 'strict-origin-when-cross-origin',
  };
}

export default async function LinkInBioPage({ params }: { params: { slug: string } }) {
  const page = await load(params.slug);
  if (!page) notFound();

  return (
    <main className="min-h-screen bg-white">
      <div className="max-w-md mx-auto px-4 py-8">
        <header className="text-center mb-6">
          <h1 className="text-xl font-semibold text-gray-900">{page.title}</h1>
          {page.username && (
            <a
              href={`https://www.instagram.com/${encodeURIComponent(page.username)}/`}
              className="text-sm text-gray-500 hover:text-gray-700"
              rel="noopener noreferrer"
            >
              @{page.username}
            </a>
          )}
        </header>

        {page.buttons.length > 0 && (
          <nav className="space-y-2 mb-6" aria-label="Links">
            {page.buttons.map((b, i) => (
              <a
                key={`${i}-${b.url}`}
                href={b.url}
                rel="noopener noreferrer"
                className="block w-full text-center rounded-lg border border-gray-300 px-4 py-3 text-sm font-medium text-gray-900 hover:bg-gray-50"
              >
                {b.label}
              </a>
            ))}
          </nav>
        )}

        {page.tiles.length === 0 ? (
          <p className="text-center text-sm text-gray-500">No posts yet.</p>
        ) : (
          <>
            <p className="text-center text-xs text-gray-500 mb-2">Tap a post to open its link</p>
            <div className="grid grid-cols-3 gap-1">
              {page.tiles.map((t) => {
                const media = t.isVideo ? (
                  <video src={`${t.image}#t=0.1`} muted playsInline preload="metadata" className="h-full w-full object-cover" aria-label={t.alt || 'Video post'} />
                ) : (
                  <img src={t.image} alt={t.alt || 'Instagram post'} loading="lazy" className="h-full w-full object-cover" />
                );
                return t.link ? (
                  <a key={t.id} href={t.link} rel="noopener noreferrer" className="relative block aspect-[4/5] overflow-hidden bg-gray-100">
                    {media}
                  </a>
                ) : (
                  <div key={t.id} className="relative aspect-[4/5] overflow-hidden bg-gray-100 opacity-90">{media}</div>
                );
              })}
            </div>
          </>
        )}
      </div>
    </main>
  );
}
