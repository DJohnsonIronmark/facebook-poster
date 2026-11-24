'use client';

import { useMemo, useState } from 'react';
import PlatformBadge from './PlatformBadge';

// Month calendar of scheduled posts (Scheduled tab → Calendar). Read-only: each post opens a details
// panel; publishing / deleting stays in the list view. Dates are shown in the viewer's time zone.

export interface CalendarPost {
  id: string;
  franchise_name: string;
  post_content: string;
  scheduled_for: string | null;
  status: string;
  platform?: string | null;
  media_url?: string | null;
  media_type?: string | null;
  link_url?: string | null;
  publish_error?: string | null;
}

const PLATFORM_CHIP: Record<string, string> = {
  facebook: 'bg-blue-50 border-blue-200 text-blue-900',
  instagram: 'bg-pink-50 border-pink-200 text-pink-900',
  linkedin: 'bg-sky-50 border-sky-200 text-sky-900',
  x: 'bg-gray-100 border-gray-300 text-gray-900',
};
const PLATFORM_NAME: Record<string, string> = { facebook: 'Facebook', instagram: 'Instagram', linkedin: 'LinkedIn', x: 'X' };
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MAX_PER_DAY = 3;

const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
const timeLabel = (d: Date) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

export default function PostCalendar({ posts }: { posts: CalendarPost[] }) {
  const today = new Date();
  const [month, setMonth] = useState(() => new Date(today.getFullYear(), today.getMonth(), 1));
  const [openDay, setOpenDay] = useState<string | null>(null);
  const [selected, setSelected] = useState<CalendarPost | null>(null);

  // Posts by local day, earliest first
  const byDay = useMemo(() => {
    const map = new Map<string, { post: CalendarPost; at: Date }[]>();
    for (const post of posts) {
      if (!post.scheduled_for) continue;
      const at = new Date(post.scheduled_for);
      if (isNaN(at.getTime())) continue;
      const k = dayKey(at);
      map.set(k, [...(map.get(k) || []), { post, at }]);
    }
    map.forEach((list) => list.sort((a, b) => a.at.getTime() - b.at.getTime()));
    return map;
  }, [posts]);
  const undated = posts.filter((p) => !p.scheduled_for);

  // 6-week grid starting on the Sunday on/before the 1st
  const cells = useMemo(() => {
    const start = new Date(month);
    start.setDate(1 - start.getDay());
    return Array.from({ length: 42 }, (_, i) => {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      return d;
    });
  }, [month]);

  const inMonth = (d: Date) => d.getMonth() === month.getMonth();
  const monthCount = posts.filter((p) => {
    if (!p.scheduled_for) return false;
    const d = new Date(p.scheduled_for);
    return d.getFullYear() === month.getFullYear() && d.getMonth() === month.getMonth();
  }).length;
  const shift = (n: number) => { setMonth(new Date(month.getFullYear(), month.getMonth() + n, 1)); setOpenDay(null); };

  return (
    <div className="bg-white rounded-lg shadow">
      <div className="flex flex-wrap items-center gap-2 px-4 py-3 border-b">
        <h3 className="text-base font-semibold text-gray-900 mr-auto">
          {month.toLocaleDateString([], { month: 'long', year: 'numeric' })}
          <span className="ml-2 text-sm font-normal text-gray-500">{monthCount} post{monthCount === 1 ? '' : 's'}</span>
        </h3>
        <button onClick={() => shift(-1)} className="px-2.5 py-1 rounded-md border text-sm hover:bg-gray-50" aria-label="Previous month">‹</button>
        <button onClick={() => { setMonth(new Date(today.getFullYear(), today.getMonth(), 1)); setOpenDay(null); }}
          className="px-3 py-1 rounded-md border text-sm hover:bg-gray-50">Today</button>
        <button onClick={() => shift(1)} className="px-2.5 py-1 rounded-md border text-sm hover:bg-gray-50" aria-label="Next month">›</button>
      </div>

      <div className="grid grid-cols-7 border-b text-xs font-medium text-gray-500">
        {WEEKDAYS.map((w) => <div key={w} className="px-2 py-1.5">{w}</div>)}
      </div>
      <div className="grid grid-cols-7">
        {cells.map((d) => {
          const k = dayKey(d);
          const list = byDay.get(k) || [];
          const expanded = openDay === k;
          const shown = expanded ? list : list.slice(0, MAX_PER_DAY);
          const isToday = k === dayKey(today);
          return (
            <div key={k} className={`min-h-[7rem] border-b border-r p-1.5 ${inMonth(d) ? 'bg-white' : 'bg-gray-50'}`}>
              <div className={`text-xs mb-1 ${isToday ? 'inline-flex items-center justify-center w-6 h-6 rounded-full bg-blue-600 text-white font-semibold' : inMonth(d) ? 'text-gray-700' : 'text-gray-400'}`}>
                {d.getDate()}
              </div>
              <div className="space-y-1">
                {shown.map(({ post, at }) => {
                  const platform = post.platform || 'facebook';
                  const failed = post.status === 'failed';
                  return (
                    <button key={post.id} onClick={() => setSelected(post)}
                      title={`${timeLabel(at)} · ${PLATFORM_NAME[platform] || platform} · ${post.franchise_name}\n${post.post_content.slice(0, 200)}`}
                      className={`w-full text-left text-[11px] leading-tight rounded border px-1.5 py-1 hover:shadow-sm ${failed ? 'bg-red-50 border-red-300 text-red-800' : PLATFORM_CHIP[platform] || PLATFORM_CHIP.x}`}>
                      <span className="font-semibold">{timeLabel(at)}</span>{' '}
                      <span className="opacity-80">{PLATFORM_NAME[platform] || platform}</span>
                      <span className="block truncate">{failed ? 'Failed · ' : post.status === 'publishing' ? 'Publishing · ' : ''}{post.franchise_name}</span>
                    </button>
                  );
                })}
                {list.length > MAX_PER_DAY && (
                  <button onClick={() => setOpenDay(expanded ? null : k)} className="text-[11px] text-blue-600 hover:underline">
                    {expanded ? 'Show less' : `+${list.length - MAX_PER_DAY} more`}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {undated.length > 0 && (
        <p className="px-4 py-2 text-xs text-gray-500 border-t">
          {undated.length} post{undated.length === 1 ? '' : 's'} without a date (see List view).
        </p>
      )}

      {selected && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" role="dialog" aria-modal="true"
          aria-label="Post details" onClick={() => setSelected(null)}>
          <div className="bg-white rounded-lg shadow-xl max-w-lg w-full max-h-[85vh] overflow-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start gap-3 px-4 py-3 border-b">
              <div className="mr-auto">
                <div className="flex items-center gap-2">
                  <PlatformBadge platform={selected.platform || 'facebook'} />
                  <span className="font-semibold text-gray-900">{selected.franchise_name}</span>
                </div>
                <p className="text-sm text-gray-500 mt-0.5">
                  {selected.scheduled_for ? new Date(selected.scheduled_for).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'No date'}
                  {' · '}{selected.status === 'pending' ? 'Scheduled' : selected.status.charAt(0).toUpperCase() + selected.status.slice(1)}
                </p>
              </div>
              <button onClick={() => setSelected(null)} className="text-gray-400 hover:text-gray-600 text-xl leading-none" aria-label="Close">×</button>
            </div>
            <div className="px-4 py-3 space-y-3">
              {selected.publish_error && selected.status === 'failed' && (
                <p className="text-sm bg-red-50 border border-red-200 text-red-800 rounded px-3 py-2">{selected.publish_error}</p>
              )}
              {selected.media_url && selected.media_type === 'photo' && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={selected.media_url} alt="" className="w-full max-h-72 object-contain rounded bg-gray-50" />
              )}
              {selected.media_url && selected.media_type === 'video' && (
                <video src={selected.media_url} controls preload="metadata" className="w-full max-h-72 rounded bg-black" />
              )}
              <p className="text-sm text-gray-800 whitespace-pre-wrap">{selected.post_content}</p>
              {selected.link_url && (
                <a href={selected.link_url} target="_blank" rel="noopener noreferrer" className="block text-sm text-blue-600 underline truncate">{selected.link_url}</a>
              )}
              <p className="text-xs text-gray-500">To publish now or delete, switch to List view.</p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
