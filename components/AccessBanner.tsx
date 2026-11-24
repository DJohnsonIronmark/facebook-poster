'use client';

import { useEffect, useState } from 'react';

// "Verify my page access": each person signs in with their own Facebook account so the app knows
// which pages they manage. Shown to non-admins until they verify (before and after enforcement),
// after a verification (result), and when their Facebook login has expired.

interface AccessMe {
  enforced: boolean;
  sees_all: boolean;
  role: string | null;
  facebook: { verified: boolean; status: string | null; verified_at: string | null; pages: number };
}

const VERIFY_URL = '/api/facebook/oauth/start?purpose=access';

export default function AccessBanner() {
  const [me, setMe] = useState<AccessMe | null>(null);
  const [result, setResult] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const flag = params.get('access');
    if (flag) {
      setResult(flag === 'verified'
        ? `Verified: you have access to ${params.get('pages') || 0} page(s) in this app.`
        : flag === 'denied' ? 'Facebook sign-in was cancelled.'
        : 'Could not verify your page access. Try again, or ask an admin.');
      params.delete('access'); params.delete('pages');
      const qs = params.toString();
      window.history.replaceState(null, '', `${window.location.pathname}${qs ? `?${qs}` : ''}`);
    }
    fetch('/api/access/me', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).then(setMe).catch(() => {});
  }, []);

  if (result) {
    const ok = result.startsWith('Verified');
    return (
      <div className={`max-w-5xl mx-auto mt-4 px-4`}>
        <div className={`rounded-lg border px-4 py-2 text-sm flex items-center gap-3 ${ok ? 'bg-green-50 border-green-200 text-green-800' : 'bg-red-50 border-red-200 text-red-700'}`} role="status">
          <span className="mr-auto">{result}</span>
          <button onClick={() => setResult(null)} className="text-xs underline">Dismiss</button>
        </div>
      </div>
    );
  }
  if (!me || me.role === 'admin') return null;

  const expired = me.facebook.status === 'needs_reauth';
  if (me.facebook.verified && !expired) return null;

  return (
    <div className="max-w-5xl mx-auto mt-4 px-4">
      <div className={`rounded-lg border px-4 py-3 text-sm flex flex-wrap items-center gap-3 ${me.enforced ? 'bg-amber-50 border-amber-200 text-amber-900' : 'bg-blue-50 border-blue-100 text-blue-900'}`} role="status">
        <span className="mr-auto">
          {expired
            ? 'Your Facebook sign-in has expired, so pages are hidden until you verify again.'
            : me.enforced
              ? 'You only see pages you manage on Facebook. Verify your page access to see them.'
              : 'Soon you will only see the pages you manage on Facebook. Verify your page access now so nothing disappears.'}
        </span>
        <a href={VERIFY_URL} className="px-3 py-1.5 rounded-md bg-[#1877f2] text-white font-medium hover:bg-[#166fe5]">
          Verify my page access
        </a>
      </div>
    </div>
  );
}
