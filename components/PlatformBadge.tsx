'use client';

// Small label showing which network a post publishes to. Rows from before Instagram support have
// no platform and are Facebook.
const STYLES: Record<'facebook' | 'instagram' | 'linkedin' | 'x', { label: string; className: string }> = {
  facebook: { label: 'Facebook', className: 'bg-blue-100 text-blue-800' },
  instagram: { label: 'Instagram', className: 'bg-pink-100 text-pink-800' },
  linkedin: { label: 'LinkedIn', className: 'bg-[#0a66c2] text-white' },
  x: { label: 'X', className: 'bg-black text-white' },
};

export default function PlatformBadge({ platform, className = '' }: { platform?: string | null; className?: string }) {
  const key = platform === 'instagram' || platform === 'linkedin' || platform === 'x' ? platform : 'facebook';
  const s = STYLES[key];
  return (
    <span className={`inline-flex items-center text-xs font-medium px-2 py-0.5 rounded-full ${s.className} ${className}`}>
      {s.label}
    </span>
  );
}
