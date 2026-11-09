'use client';

// Small label showing which network a post publishes to. Rows from before Instagram support have
// no platform and are Facebook.
export default function PlatformBadge({ platform, className = '' }: { platform?: string | null; className?: string }) {
  const ig = platform === 'instagram';
  return (
    <span
      className={`inline-flex items-center text-xs font-medium px-2 py-0.5 rounded-full ${ig ? 'bg-pink-100 text-pink-800' : 'bg-blue-100 text-blue-800'} ${className}`}
    >
      {ig ? 'Instagram' : 'Facebook'}
    </span>
  );
}
