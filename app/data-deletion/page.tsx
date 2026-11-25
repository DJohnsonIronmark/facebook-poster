import type { Metadata } from 'next';
import Link from 'next/link';

// Public data deletion instructions for the Ironmark Social Publisher (facebook-poster). Required
// for apps using Facebook Login (Meta Platform Terms).

export const metadata: Metadata = {
  title: 'Data Deletion – Ironmark Social Publisher',
  description: 'How to remove the Ironmark Social Publisher and ask for your data to be deleted.',
};

const CONTACT_EMAIL = 'websupport@ironmarkusa.com';

export default function DataDeletionPage() {
  return (
    <main className="max-w-3xl mx-auto px-6 py-12 text-gray-800">
      <h1 className="text-3xl font-bold text-gray-900">Data Deletion Instructions – Ironmark Social Publisher</h1>
      <p className="mt-4">
        You can remove the Ironmark Social Publisher&apos;s access to your Facebook account, Pages and Instagram accounts at any time,
        and ask us to delete the data we hold. What we store is described in our{' '}
        <Link href="/privacy" className="text-blue-700 underline">privacy notice</Link>.
      </p>

      <h2 className="mt-10 text-xl font-semibold text-gray-900">1. Remove the app&apos;s access in Facebook</h2>
      <ol className="mt-3 list-decimal pl-6 space-y-1">
        <li>On Facebook, open <strong>Settings &amp; privacy → Settings</strong>.</li>
        <li>Go to <strong>Business integrations</strong> (or <strong>Apps and websites</strong>).</li>
        <li>Find the Ironmark app you used to connect your Pages, choose <strong>Remove</strong>, and confirm.</li>
      </ol>
      <p className="mt-2 text-sm text-gray-600">
        This stops the Publisher from accessing your account, Pages and linked Instagram accounts. Stored tokens stop working
        immediately; the next daily check also removes your page access in the Publisher.
      </p>

      <h2 className="mt-10 text-xl font-semibold text-gray-900">2. Ask us to delete your data</h2>
      <p className="mt-3">
        Email <a href={`mailto:${CONTACT_EMAIL}?subject=Social%20Publisher%20data%20deletion%20request`} className="text-blue-700 underline">{CONTACT_EMAIL}</a>{' '}
        with the subject &ldquo;Social Publisher data deletion request&rdquo; and include:
      </p>
      <ul className="mt-2 list-disc pl-6 space-y-1">
        <li>Your name and the email address you use with us.</li>
        <li>The Facebook Page(s) and/or Instagram account(s) concerned (name or link).</li>
      </ul>
      <p className="mt-3">We will verify the request and then delete:</p>
      <ul className="mt-2 list-disc pl-6 space-y-1">
        <li>Stored access tokens for your Facebook account, Pages and Instagram accounts.</li>
        <li>The record of which Pages you manage.</li>
        <li>Posts, statistics and link in bio settings we hold for those Pages and accounts, unless we must keep them to meet a legal
          obligation or a contract with the client that owns the Page.</li>
      </ul>
      <p className="mt-3">
        We will confirm by email when the deletion is complete, within 30 days of verifying your request.
        Posts already published to Facebook or Instagram stay on those platforms; you can delete them there.
      </p>

      <h2 className="mt-10 text-xl font-semibold text-gray-900">Other ways to reach us</h2>
      <p className="mt-3">
        Phone 888-775-3737, or write to Ironmark, LLC – Attn: Data Protection Officer, 9040 Junction Drive, Annapolis Junction, MD 20701.
      </p>
    </main>
  );
}
