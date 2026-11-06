import { lookup } from 'dns/promises';
import { isIP } from 'net';
import type { LinkPreview } from './types';

// Server-side Open Graph fetch so link posts can be previewed like Facebook's link card.
// SSRF-guarded: http(s) only, public IPs only, no redirects to private hosts, 5s timeout, 1MB cap.

function isPrivateIp(ip: string): boolean {
  if (ip.includes(':')) {
    const v = ip.toLowerCase();
    if (v.startsWith('::ffff:')) return isPrivateIp(v.slice(7));
    return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80');
  }
  const [a, b] = ip.split('.').map(Number);
  return (
    a === 10 || a === 127 || a === 0 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    a >= 224
  );
}

async function assertPublicUrl(raw: string): Promise<URL> {
  const url = new URL(raw);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('unsupported protocol');
  if (url.username || url.password) throw new Error('credentials in URL');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  if (addrs.length === 0 || addrs.some((a) => isPrivateIp(a.address))) throw new Error('non-public host');
  return url;
}

function meta(html: string, keys: string[]): string | null {
  for (const key of keys) {
    const re = new RegExp(
      `<meta[^>]+(?:property|name)=["']${key}["'][^>]*content=["']([^"']*)["']|<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${key}["']`,
      'i',
    );
    const m = html.match(re);
    const v = m?.[1] ?? m?.[2];
    if (v) return decodeEntities(v.trim());
  }
  return null;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

export async function fetchLinkPreview(rawUrl: string | null | undefined): Promise<LinkPreview | null> {
  if (!rawUrl || !rawUrl.trim()) return null;
  let url: URL;
  try {
    url = await assertPublicUrl(rawUrl.trim());
  } catch {
    return null;
  }
  const fallback: LinkPreview = { url: url.toString(), domain: url.hostname.replace(/^www\./, '').toUpperCase() };

  try {
    let current = url;
    let res: Response | null = null;
    for (let hop = 0; hop < 4; hop++) {
      res = await fetch(current, {
        redirect: 'manual',
        signal: AbortSignal.timeout(5000),
        headers: { 'User-Agent': 'facebookexternalhit/1.1 (link preview)', Accept: 'text/html' },
      });
      const loc = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && loc) {
        current = await assertPublicUrl(new URL(loc, current).toString());
        continue;
      }
      break;
    }
    if (!res || !res.ok || !(res.headers.get('content-type') || '').includes('html')) return fallback;

    const reader = res.body?.getReader();
    let html = '';
    if (reader) {
      const decoder = new TextDecoder();
      while (html.length < 1_000_000) {
        const { done, value } = await reader.read();
        if (done) break;
        html += decoder.decode(value, { stream: true });
        if (/<\/head>/i.test(html)) break;
      }
      reader.cancel().catch(() => {});
    }

    const title = meta(html, ['og:title', 'twitter:title']) || html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim() || null;
    const description = meta(html, ['og:description', 'twitter:description', 'description']);
    let image = meta(html, ['og:image', 'og:image:url', 'twitter:image']);
    if (image) {
      try { image = new URL(image, url).toString(); } catch { image = null; }
    }
    return { ...fallback, title: title ? decodeEntities(title) : null, description, image };
  } catch {
    return fallback;
  }
}
