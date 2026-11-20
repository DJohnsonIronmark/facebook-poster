import { lookup } from 'dns/promises';
import { BlockList, isIP } from 'net';
import type { LinkPreview } from './types';

// Server-side Open Graph fetch so link posts can be previewed like Facebook's link card.
// SSRF-guarded: http(s) on 80/443 only, public IPs only (re-checked on every redirect),
// 5s timeout, 1MB cap. DNS-rebinding between lookup and fetch is an accepted residual risk.

const blocked = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3],
] as const) blocked.addSubnet(net, prefix, 'ipv4');
for (const [net, prefix] of [
  ['::', 96],          // unspecified, loopback, IPv4-compatible
  // IPv4-mapped (::ffff:0:0/96) is NOT listed: BlockList matches every IPv4 against it.
  // Mapped addresses are expanded by mappedV4() and checked against the IPv4 list instead.
  ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64], ['2001:db8::', 32], ['2002::', 16],
  ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
] as const) blocked.addSubnet(net, prefix, 'ipv6');

/** ::ffff:7f00:1 / ::ffff:127.0.0.1 → 127.0.0.1 */
function mappedV4(ip: string): string | null {
  const m = ip.toLowerCase().match(/^(?:0{0,4}:){0,5}:?ffff:(.+)$/);
  if (!m) return null;
  const tail = m[1];
  if (isIP(tail) === 4) return tail;
  const hex = tail.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (!hex) return null;
  const hi = parseInt(hex[1], 16), lo = parseInt(hex[2], 16);
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
}

export function isPrivateIp(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return blocked.check(ip, 'ipv4');
  if (family === 6) {
    const v4 = mappedV4(ip);
    if (v4) return blocked.check(v4, 'ipv4');
    return blocked.check(ip, 'ipv6');
  }
  return true; // not an IP literal: refuse
}

async function assertPublicUrl(raw: string): Promise<URL> {
  const url = new URL(raw);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('unsupported protocol');
  if (url.username || url.password) throw new Error('credentials in URL');
  if (url.port && url.port !== '80' && url.port !== '443') throw new Error('non-standard port');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true, verbatim: true });
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
