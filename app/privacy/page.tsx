import type { Metadata } from 'next';
import Link from 'next/link';

// Public privacy notice for the Ironmark Social Publisher (facebook-poster). Required for Meta App
// Review / Platform Terms.

export const metadata: Metadata = {
  title: 'Privacy Notice – Ironmark Social Publisher',
  description: 'How the Ironmark Social Publisher uses Facebook, Instagram, LinkedIn and X data.',
};

const LAST_UPDATED = 'November 24, 2026';
const CONTACT_EMAIL = 'websupport@ironmarkusa.com';

export default function PrivacyPage() {
  return (
    <main className="max-w-3xl mx-auto px-6 py-12 text-gray-800">
      <h1 className="text-3xl font-bold text-gray-900">Privacy Notice – Ironmark Social Publisher</h1>
      <p className="mt-2 text-sm text-gray-500">Last updated: {LAST_UPDATED}</p>

      <section className="mt-8 space-y-3">
        <p>
          The Ironmark Social Publisher (&ldquo;the Publisher&rdquo;) is an internal tool operated by Ironmark, LLC (&ldquo;Ironmark&rdquo;,
          &ldquo;we&rdquo;, &ldquo;us&rdquo;). Ironmark staff use it to plan, approve, publish and measure social media posts for Ironmark
          and for clients who have authorized Ironmark to manage their pages and accounts.
        </p>
        <p>
          This notice explains what data the Publisher accesses from Facebook, Instagram, LinkedIn and X, and how we use it. For
          everything else, Ironmark&apos;s{' '}
          <a href="https://www.ironmarkusa.com/privacy-policy" className="text-blue-700 underline" target="_blank" rel="noopener noreferrer">company privacy policy</a>{' '}
          applies. If the two differ about data the Publisher receives from these platforms, this notice applies.
        </p>
      </section>

      <h2 className="mt-10 text-xl font-semibold text-gray-900">Who uses the Publisher</h2>
      <ul className="mt-3 list-disc pl-6 space-y-1">
        <li>Ironmark employees with a Publisher account, who sign in with their work email.</li>
        <li>Client reviewers, who receive a private review link by email to approve draft posts. They do not create an account.</li>
      </ul>

      <h2 className="mt-10 text-xl font-semibold text-gray-900">Data we access from the platforms, and why</h2>
      <div className="mt-3 space-y-4">
        <div>
          <h3 className="font-semibold">When someone connects their Facebook account</h3>
          <ul className="mt-1 list-disc pl-6 space-y-1">
            <li><strong>The list of Facebook Pages they manage</strong> (page IDs and names). Used to connect those pages and to show each
              person only the pages they manage.</li>
            <li><strong>Page access tokens</strong> for those pages and their linked Instagram professional accounts. Used to publish posts,
              read post and page statistics, and show and reply to comments and messages, on behalf of the page.</li>
            <li><strong>A login token for their own Facebook account</strong>, used once a day only to re-check which pages they still manage.</li>
          </ul>
        </div>
        <div>
          <h3 className="font-semibold">To publish and manage posts</h3>
          <ul className="mt-1 list-disc pl-6 space-y-1">
            <li>The text, images, videos and links our team writes, and the IDs Facebook, Instagram, LinkedIn or X return for each published post.</li>
            <li>The connected Instagram account&apos;s ID and username, LinkedIn company page ID and name, and X account ID and username.</li>
          </ul>
        </div>
        <div>
          <h3 className="font-semibold">To measure performance</h3>
          <ul className="mt-1 list-disc pl-6 space-y-1">
            <li>Aggregate statistics for posts on connected pages and accounts (views, reach, reactions or likes, comments, shares, saves,
              clicks, video views), each post&apos;s public caption excerpt and link, and daily follower counts.</li>
            <li>We do not collect demographic or personal information about the people who view or engage with posts.</li>
          </ul>
        </div>
        <div>
          <h3 className="font-semibold">Inbox (comments and messages)</h3>
          <ul className="mt-1 list-disc pl-6 space-y-1">
            <li>Comments and direct messages on connected pages are read live from Facebook and Instagram when our team opens the Inbox,
              so they can be answered. <strong>We do not store comment or message content.</strong> We only store which items a team member
              marked as handled, and who handled them.</li>
          </ul>
        </div>
      </div>

      <h2 className="mt-10 text-xl font-semibold text-gray-900">How we use this data</h2>
      <ul className="mt-3 list-disc pl-6 space-y-1">
        <li>Only to provide the Publisher&apos;s features to Ironmark and the clients we serve: publishing, approvals, scheduling, the
          inbox, link in bio pages and performance reporting.</li>
        <li><strong>We do not sell data obtained from Facebook, Instagram, LinkedIn or X, and we do not use it for advertising or to build
          profiles of individuals.</strong></li>
        <li>We do not share this data with third parties, except the service providers that host and run the Publisher on our behalf
          (Vercel for hosting, Supabase for the database), under contracts that restrict their use of it, or where required by law.</li>
        <li>The Publisher does not use this data with AI tools today. If that changes, we will update this notice before it does.</li>
      </ul>

      <h2 className="mt-10 text-xl font-semibold text-gray-900">Storage and security</h2>
      <ul className="mt-3 list-disc pl-6 space-y-1">
        <li>Access tokens are encrypted (AES-256-GCM) before they are stored. The encryption key is held separately from the database.</li>
        <li>The database is only accessible to the Publisher&apos;s servers. It is not reachable with public credentials, and staff
          access is limited to authorized people.</li>
        <li>Data is stored in the United States.</li>
      </ul>

      <h2 className="mt-10 text-xl font-semibold text-gray-900">How long we keep data</h2>
      <ul className="mt-3 list-disc pl-6 space-y-1">
        <li>Access tokens: until the page or account is disconnected, the token expires, or the person&apos;s access is removed.</li>
        <li>The list of pages a person manages: re-checked daily, and removed if their Facebook login expires or is revoked.</li>
        <li>Posts and their statistics: for as long as needed to provide the service to Ironmark and the client the page belongs to.
          They are deleted on request (see below) or when the client relationship ends.</li>
      </ul>

      <h2 className="mt-10 text-xl font-semibold text-gray-900">Your choices and deletion</h2>
      <p className="mt-3">
        You can disconnect a page or account at any time, or remove the app in your Facebook settings. To ask us to delete data we hold
        about you or your page, see our{' '}
        <Link href="/data-deletion" className="text-blue-700 underline">data deletion instructions</Link> or email{' '}
        <a href={`mailto:${CONTACT_EMAIL}`} className="text-blue-700 underline">{CONTACT_EMAIL}</a>.
      </p>

      <h2 className="mt-10 text-xl font-semibold text-gray-900">Children</h2>
      <p className="mt-3">The Publisher is a business tool for Ironmark staff and clients. It is not directed to children.</p>

      <h2 className="mt-10 text-xl font-semibold text-gray-900">Changes</h2>
      <p className="mt-3">We will update this notice if the Publisher&apos;s use of platform data changes, and change the date above.</p>

      <h2 className="mt-10 text-xl font-semibold text-gray-900">Contact</h2>
      <p className="mt-3">
        Ironmark, LLC – Attn: Data Protection Officer, 9040 Junction Drive, Annapolis Junction, MD 20701 ·{' '}
        <a href={`mailto:${CONTACT_EMAIL}`} className="text-blue-700 underline">{CONTACT_EMAIL}</a> · 888-775-3737
      </p>
    </main>
  );
}
