import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Review your Facebook posts',
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};

export default function ReviewLayout({ children }: { children: React.ReactNode }) {
  return children;
}
