'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import PlatformBadge from './PlatformBadge';

// Analytics tab: Facebook + Instagram performance for posts published from the app.
// Filters (one row): client, page, platform, date range. KPI tiles, an engagements-by-day bar chart
// (single series, hover tooltip), top posts, follower change, and a CSV export of every post.

interface Totals {
  posts: number; views: number; reach: number; engagements: number; reactions: number; comments: number;
  shares: number; saves: number; clicks: number; video_views: number; engagement_rate: number | null;
}
interface PostRow {
  platform: string; platform_post_id: string; facebook_page_id: string; page_name: string; published_at: string | null;
  media_type: string | null; caption: string | null; permalink: string | null; views: number | null; reach: number | null;
  reactions: number | null; comments: number | null; shares: number | null; saves: number | null; clicks: number | null;
  video_views: number | null; engagements: number | null; engagement_rate: number | null; last_error: string | null;
}
interface Data {
  enabled: boolean; from: string; to: string; totals: Totals | null;
  series: { date: string; posts: number; engagements: number; reach: number }[];
  top: PostRow[];
  followers: { platform: string; page_name: string; start: number | null; end: number | null }[];
  posts: PostRow[];
}

const RANGES = [{ days: 7, label: '7 days' }, { days: 30, label: '30 days' }, { days: 90, label: '90 days' }];
const fmt = (n: number | null | undefined) => (n === null || n === undefined ? '–' : n.toLocaleString());
const pct = (n: number | null | undefined) => (n === null || n === undefined ? '–' : `${(n * 100).toFixed(1)}%`);
const isoDay = (d: Date) => d.toISOString().slice(0, 10);

export default function AnalyticsTab({ clients, pages }: {
  clients: { id: string; name: string }[];
  pages: { facebook_page_id: string; location_name: string; client_id?: string | null }[];
}) {
  const [client, setClient] = useState('all');
  const [page, setPage] = useState('');
  const [platform, setPlatform] = useState<'all' | 'facebook' | 'instagram'>('all');
  const [days, setDays] = useState(30);
  const [data, setData] = useState<Data | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hover, setHover] = useState<number | null>(null);

  const pageOptions = useMemo(() => pages
    .filter((p) => (client === 'all' ? true : client === 'none' ? !p.client_id : p.client_id === client))
    .sort((a, b) => a.location_name.localeCompare(b.location_name, undefined, { sensitivity: 'base' })), [pages, client]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const to = new Date();
    const from = new Date(Date.now() - (days - 1) * 86400_000);
    const q = new URLSearchParams({ client, platform, from: isoDay(from), to: isoDay(to) });
    if (page) q.set('page', page);
    try {
      const res = await fetch(`/api/analytics?${q}`, { cache: 'no-store' });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || 'Failed to load analytics');
      setData(d);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load analytics');
    } finally {
      setLoading(false);
    }
  }, [client, page, platform, days]);
  useEffect(() => { load(); }, [load]);

  // Every day in the range on the x-axis (days without posts show as gaps)
  const chartDays = useMemo(() => {
    if (!data) return [];
    const map = new Map(data.series.map((s) => [s.date, s]));
    const out: { date: string; posts: number; engagements: number; reach: number }[] = [];
    for (let t = new Date(`${data.from}T00:00:00Z`).getTime(); t <= new Date(`${data.to}T00:00:00Z`).getTime(); t += 86400_000) {
      const d = new Date(t).toISOString().slice(0, 10);
      out.push(map.get(d) || { date: d, posts: 0, engagements: 0, reach: 0 });
    }
    return out;
  }, [data]);
  const maxEng = Math.max(1, ...chartDays.map((d) => d.engagements));

  const exportCsv = () => {
    if (!data) return;
    const cols: (keyof PostRow)[] = ['published_at', 'page_name', 'platform', 'media_type', 'views', 'reach', 'engagements', 'engagement_rate',
      'reactions', 'comments', 'shares', 'saves', 'clicks', 'video_views', 'permalink', 'caption'];
    const esc = (v: unknown) => { const s = v === null || v === undefined ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const csv = [cols.join(','), ...data.posts.map((r) => cols.map((c) => esc(c === 'engagement_rate' && r[c] !== null ? (r[c] as number).toFixed(4) : r[c])).join(','))].join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url; a.download = `analytics_${data.from}_${data.to}.csv`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const t = data?.totals;
  const tiles: { label: string; value: string; hint?: string }[] = t ? [
    { label: 'Posts', value: fmt(t.posts) },
    { label: 'Reach', value: fmt(t.reach), hint: 'Unique accounts reached (summed across posts)' },
    { label: 'Views', value: fmt(t.views) },
    { label: 'Engagements', value: fmt(t.engagements), hint: 'Reactions/likes, comments, shares, saves and Facebook clicks' },
    { label: 'Engagement rate', value: pct(t.engagement_rate), hint: 'Engagements ÷ reach' },
    { label: 'Video views', value: fmt(t.video_views) },
  ] : [];

  return (
    <div className="space-y-4">
      {/* Filters: one row */}
      <div className="flex flex-wrap items-center gap-3 bg-white rounded-lg shadow px-4 py-3">
        <select value={client} onChange={(e) => { setClient(e.target.value); setPage(''); }} aria-label="Client"
          className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm bg-white">
          <option value="all">All clients</option>
          {[...clients].sort((a, b) => a.name.localeCompare(b.name)).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          <option value="none">No client</option>
        </select>
        <select value={page} onChange={(e) => setPage(e.target.value)} aria-label="Page"
          className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm bg-white max-w-[16rem]">
          <option value="">All pages</option>
          {pageOptions.map((p) => <option key={p.facebook_page_id} value={p.facebook_page_id}>{p.location_name}</option>)}
        </select>
        <select value={platform} onChange={(e) => setPlatform(e.target.value as 'all' | 'facebook' | 'instagram')} aria-label="Platform"
          className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm bg-white">
          <option value="all">Facebook + Instagram</option>
          <option value="facebook">Facebook</option>
          <option value="instagram">Instagram</option>
        </select>
        <div className="inline-flex rounded-lg bg-gray-100 p-1" role="tablist" aria-label="Date range">
          {RANGES.map((r) => (
            <button key={r.days} role="tab" aria-selected={days === r.days} onClick={() => setDays(r.days)}
              className={`px-3 py-1 rounded-md text-sm ${days === r.days ? 'bg-white shadow-sm font-medium text-gray-900' : 'text-gray-600'}`}>{r.label}</button>
          ))}
        </div>
        <button onClick={exportCsv} disabled={!data || data.posts.length === 0}
          className="ml-auto px-3 py-1.5 text-sm rounded-lg border hover:bg-gray-50 disabled:opacity-50">Export CSV</button>
      </div>

      {data && !data.enabled && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          Analytics collection is switched off (ANALYTICS_ENABLED), so numbers here won&apos;t update. Once it&apos;s on, use
          Inbox → Connect pages once so pages grant insights access; metrics then refresh daily.
        </div>
      )}
      {error && <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">{error}</div>}
      {loading && !data && <div className="bg-white rounded-lg shadow p-8 text-center text-gray-600">Loading analytics…</div>}

      {data && t && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
            {tiles.map((k) => (
              <div key={k.label} className="bg-white rounded-lg shadow px-4 py-3" title={k.hint}>
                <div className="text-xs text-gray-500">{k.label}</div>
                <div className="text-2xl font-semibold text-gray-900 tabular-nums mt-1">{k.value}</div>
              </div>
            ))}
          </div>

          {/* Engagements by publish day: single series, so no legend; hover shows the day's numbers */}
          <div className="bg-white rounded-lg shadow p-4">
            <h3 className="text-sm font-medium text-gray-700 mb-3">Engagements by publish day</h3>
            {t.posts === 0 ? (
              <p className="text-sm text-gray-500 py-8 text-center">No published posts with metrics in this range yet.</p>
            ) : (
              <div className="relative">
                <div className="flex items-end gap-[2px] h-40 border-b border-gray-200" onMouseLeave={() => setHover(null)}>
                  {chartDays.map((d, i) => (
                    <div key={d.date} className="flex-1 h-full flex items-end cursor-default" onMouseEnter={() => setHover(i)}
                      aria-label={`${d.date}: ${d.engagements} engagements from ${d.posts} posts`}>
                      <div className={`w-full rounded-t-[4px] ${hover === i ? 'bg-blue-700' : 'bg-blue-500'}`}
                        style={{ height: d.engagements > 0 ? `${Math.max(2, (d.engagements / maxEng) * 100)}%` : 0 }} />
                    </div>
                  ))}
                </div>
                <div className="flex justify-between text-[11px] text-gray-400 mt-1">
                  <span>{chartDays[0]?.date}</span><span>{chartDays[chartDays.length - 1]?.date}</span>
                </div>
                {hover !== null && chartDays[hover] && (
                  <div className="absolute -top-2 pointer-events-none bg-gray-900 text-white text-xs rounded px-2 py-1 shadow"
                    style={{ left: `${Math.min(85, (hover / Math.max(1, chartDays.length - 1)) * 100)}%` }} role="tooltip">
                    <div className="font-medium">{new Date(`${chartDays[hover].date}T12:00:00Z`).toLocaleDateString([], { month: 'short', day: 'numeric' })}</div>
                    <div>{fmt(chartDays[hover].engagements)} engagements · {fmt(chartDays[hover].posts)} post{chartDays[hover].posts === 1 ? '' : 's'}</div>
                    <div>{fmt(chartDays[hover].reach)} reach</div>
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="grid lg:grid-cols-3 gap-4">
            <div className="lg:col-span-2 bg-white rounded-lg shadow overflow-hidden">
              <h3 className="text-sm font-medium text-gray-700 px-4 py-3 border-b">Top posts</h3>
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead className="bg-gray-50 text-xs text-gray-500">
                    <tr>
                      <th className="text-left px-3 py-2 font-medium">Post</th>
                      <th className="text-right px-3 py-2 font-medium">Reach</th>
                      <th className="text-right px-3 py-2 font-medium">Engagements</th>
                      <th className="text-right px-3 py-2 font-medium">Rate</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {data.top.map((p) => (
                      <tr key={`${p.platform}:${p.platform_post_id}`}>
                        <td className="px-3 py-2 max-w-md">
                          <div className="flex items-center gap-2 text-xs text-gray-500">
                            <PlatformBadge platform={p.platform} />
                            <span className="truncate">{p.page_name}</span>
                            {p.published_at && <span>· {new Date(p.published_at).toLocaleDateString([], { month: 'short', day: 'numeric' })}</span>}
                          </div>
                          <div className="truncate text-gray-800">{p.caption || '(no text)'}</div>
                          {p.permalink && <a href={p.permalink} target="_blank" rel="noopener noreferrer" className="text-xs text-blue-600 hover:underline">View post</a>}
                          {p.last_error && <div className="text-xs text-amber-700 truncate" title={p.last_error}>Last refresh failed: {p.last_error}</div>}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">{fmt(p.reach)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{fmt(p.engagements)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{pct(p.engagement_rate)}</td>
                      </tr>
                    ))}
                    {data.top.length === 0 && <tr><td colSpan={4} className="px-3 py-6 text-center text-gray-500">No posts yet.</td></tr>}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="bg-white rounded-lg shadow overflow-hidden">
              <h3 className="text-sm font-medium text-gray-700 px-4 py-3 border-b">Followers</h3>
              <table className="min-w-full text-sm">
                <tbody className="divide-y">
                  {data.followers.map((f) => {
                    const change = f.start !== null && f.end !== null ? f.end - f.start : null;
                    return (
                      <tr key={`${f.platform}:${f.page_name}`}>
                        <td className="px-3 py-2"><div className="flex items-center gap-2"><PlatformBadge platform={f.platform} /><span className="truncate">{f.page_name}</span></div></td>
                        <td className="px-3 py-2 text-right tabular-nums">{fmt(f.end)}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-gray-600">{change === null ? '' : `${change >= 0 ? '+' : ''}${change.toLocaleString()}`}</td>
                      </tr>
                    );
                  })}
                  {data.followers.length === 0 && <tr><td className="px-3 py-6 text-center text-gray-500">Follower counts appear after the first daily refresh.</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
          <p className="text-xs text-gray-500">Metrics are lifetime totals per post, refreshed daily for 90 days after publishing. Posts are grouped by the day they were published.</p>
        </>
      )}
    </div>
  );
}
