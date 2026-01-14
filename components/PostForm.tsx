'use client';

import { useState } from 'react';
import type { FacebookPage } from '@/app/page';

interface PostFormProps {
  pages: FacebookPage[];
  onPostCreated: () => void;
}

export default function PostForm({ pages, onPostCreated }: PostFormProps) {
  const [selectedPage, setSelectedPage] = useState('');
  const [postContent, setPostContent] = useState('');
  const [linkUrl, setLinkUrl] = useState('');
  const [scheduledFor, setScheduledFor] = useState('');
  const [publishNow, setPublishNow] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const selectedPageData = pages.find(p => p.id === selectedPage);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccess(null);
    setSubmitting(true);

    try {
      if (!selectedPage) {
        throw new Error('Please select a Facebook page');
      }
      if (!postContent.trim()) {
        throw new Error('Please enter post content');
      }

      const payload = {
        facebook_page_id: selectedPage,
        franchise_name: selectedPageData?.franchise_name || '',
        post_content: postContent.trim(),
        link_url: linkUrl.trim() || null,
        scheduled_for: publishNow ? null : (scheduledFor || null),
        publish_now: publishNow,
      };

      const response = await fetch('/api/posts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to create post');
      }

      if (publishNow) {
        setSuccess('Post published successfully!');
      } else {
        setSuccess('Post scheduled successfully!');
      }

      // Reset form
      setPostContent('');
      setLinkUrl('');
      setScheduledFor('');
      setPublishNow(false);
      onPostCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setSubmitting(false);
    }
  };

  // Get minimum datetime (now)
  const getMinDateTime = () => {
    const now = new Date();
    now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
    return now.toISOString().slice(0, 16);
  };

  return (
    <div className="bg-white rounded-lg shadow p-6">
      <h2 className="text-lg font-semibold text-gray-900 mb-6">Create New Post</h2>

      <form onSubmit={handleSubmit} className="space-y-6">
        {/* Page Selection */}
        <div>
          <label htmlFor="page" className="block text-sm font-medium text-gray-700 mb-2">
            Facebook Page
          </label>
          <select
            id="page"
            value={selectedPage}
            onChange={(e) => setSelectedPage(e.target.value)}
            className="w-full border border-gray-300 rounded-lg px-4 py-2 focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            disabled={submitting}
          >
            <option value="">Select a page...</option>
            {pages.map((page) => (
              <option key={page.id} value={page.id}>
                {page.franchise_name} - {page.name}
              </option>
            ))}
          </select>
          {pages.length === 0 && (
            <p className="mt-2 text-sm text-amber-600">
              No pages configured. Add pages in the facebook_pages Supabase table.
            </p>
          )}
        </div>

        {/* Post Content */}
        <div>
          <label htmlFor="content" className="block text-sm font-medium text-gray-700 mb-2">
            Post Content
          </label>
          <textarea
            id="content"
            value={postContent}
            onChange={(e) => setPostContent(e.target.value)}
            rows={5}
            className="w-full border border-gray-300 rounded-lg px-4 py-2 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 resize-none"
            placeholder="Write your post content here..."
            disabled={submitting}
          />
          <p className="mt-1 text-sm text-gray-500">
            {postContent.length} / 63,206 characters
          </p>
        </div>

        {/* Link URL */}
        <div>
          <label htmlFor="link" className="block text-sm font-medium text-gray-700 mb-2">
            Link URL (optional)
          </label>
          <input
            type="url"
            id="link"
            value={linkUrl}
            onChange={(e) => setLinkUrl(e.target.value)}
            className="w-full border border-gray-300 rounded-lg px-4 py-2 focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            placeholder="https://example.com/article"
            disabled={submitting}
          />
        </div>

        {/* Publish Options */}
        <div className="border-t pt-6">
          <div className="flex items-center gap-6 mb-4">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="radio"
                name="publishOption"
                checked={!publishNow}
                onChange={() => setPublishNow(false)}
                className="w-4 h-4 text-blue-600"
                disabled={submitting}
              />
              <span className="text-sm font-medium text-gray-700">Schedule for later</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="radio"
                name="publishOption"
                checked={publishNow}
                onChange={() => setPublishNow(true)}
                className="w-4 h-4 text-blue-600"
                disabled={submitting}
              />
              <span className="text-sm font-medium text-gray-700">Publish immediately</span>
            </label>
          </div>

          {!publishNow && (
            <div>
              <label htmlFor="scheduledFor" className="block text-sm font-medium text-gray-700 mb-2">
                Schedule Date & Time
              </label>
              <input
                type="datetime-local"
                id="scheduledFor"
                value={scheduledFor}
                onChange={(e) => setScheduledFor(e.target.value)}
                min={getMinDateTime()}
                className="w-full sm:w-auto border border-gray-300 rounded-lg px-4 py-2 focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                disabled={submitting}
              />
              <p className="mt-1 text-sm text-gray-500">
                Leave empty to save as draft
              </p>
            </div>
          )}
        </div>

        {/* Error/Success Messages */}
        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg">
            {error}
          </div>
        )}
        {success && (
          <div className="bg-green-50 border border-green-200 text-green-700 px-4 py-3 rounded-lg">
            {success}
          </div>
        )}

        {/* Submit Button */}
        <div className="flex justify-end gap-3">
          <button
            type="submit"
            disabled={submitting || !selectedPage || !postContent.trim()}
            className={`px-6 py-2 rounded-lg font-medium text-white ${
              submitting || !selectedPage || !postContent.trim()
                ? 'bg-gray-400 cursor-not-allowed'
                : publishNow
                  ? 'bg-green-600 hover:bg-green-700'
                  : 'bg-blue-600 hover:bg-blue-700'
            }`}
          >
            {submitting ? (
              <span className="flex items-center gap-2">
                <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                </svg>
                {publishNow ? 'Publishing...' : 'Saving...'}
              </span>
            ) : publishNow ? (
              'Publish Now'
            ) : (
              'Schedule Post'
            )}
          </button>
        </div>
      </form>
    </div>
  );
}
