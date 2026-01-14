'use client';

import { useState, useRef } from 'react';
import type { FacebookPage } from '@/app/page';
import SearchableMultiSelect from './SearchableMultiSelect';

interface PostFormProps {
  pages: FacebookPage[];
  onPostCreated: () => void;
}

interface CSVRow {
  location_name: string;
  post_content: string;
  link_url: string;
  scheduled_for: string;
}

export default function PostForm({ pages, onPostCreated }: PostFormProps) {
  const [selectedPageIds, setSelectedPageIds] = useState<string[]>([]);
  const [postContent, setPostContent] = useState('');
  const [linkUrl, setLinkUrl] = useState('');
  const [scheduledFor, setScheduledFor] = useState('');
  const [publishNow, setPublishNow] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [activeMode, setActiveMode] = useState<'single' | 'bulk'>('single');
  const [csvData, setCsvData] = useState<CSVRow[]>([]);
  const [csvError, setCsvError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const selectedPages = pages.filter(p => selectedPageIds.includes(p.id));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccess(null);
    setSubmitting(true);

    try {
      if (selectedPageIds.length === 0) {
        throw new Error('Please select at least one Facebook page');
      }
      if (!postContent.trim()) {
        throw new Error('Please enter post content');
      }

      // Create a post for each selected page
      const results = await Promise.all(
        selectedPages.map(async (page) => {
          const payload = {
            facebook_page_id: page.facebook_page_id,
            franchise_name: page.location_name,
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

          return { page: page.location_name, response };
        })
      );

      const failed = results.filter(r => !r.response.ok);
      if (failed.length > 0) {
        throw new Error(`Failed to create posts for: ${failed.map(f => f.page).join(', ')}`);
      }

      if (publishNow) {
        setSuccess(`Published to ${results.length} page(s) successfully!`);
      } else {
        setSuccess(`Scheduled ${results.length} post(s) successfully!`);
      }

      // Reset form
      setPostContent('');
      setLinkUrl('');
      setScheduledFor('');
      setPublishNow(false);
      setSelectedPageIds([]);
      onPostCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setSubmitting(false);
    }
  };

  const handleBulkSubmit = async () => {
    setError(null);
    setSuccess(null);
    setSubmitting(true);

    try {
      if (csvData.length === 0) {
        throw new Error('No CSV data to upload');
      }

      let successCount = 0;
      let failedRows: string[] = [];

      for (const row of csvData) {
        // Find the page by location name
        const page = pages.find(p =>
          p.location_name.toLowerCase() === row.location_name.toLowerCase()
        );

        if (!page) {
          failedRows.push(`${row.location_name} (page not found)`);
          continue;
        }

        const payload = {
          facebook_page_id: page.facebook_page_id,
          franchise_name: page.location_name,
          post_content: row.post_content,
          link_url: row.link_url || null,
          scheduled_for: row.scheduled_for || null,
          publish_now: false,
        };

        const response = await fetch('/api/posts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });

        if (response.ok) {
          successCount++;
        } else {
          failedRows.push(`${row.location_name} (API error)`);
        }
      }

      if (failedRows.length > 0) {
        setError(`Failed rows: ${failedRows.join(', ')}`);
      }

      if (successCount > 0) {
        setSuccess(`Successfully created ${successCount} post(s)!`);
        setCsvData([]);
        if (fileInputRef.current) {
          fileInputRef.current.value = '';
        }
        onPostCreated();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setSubmitting(false);
    }
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    setCsvError(null);
    setCsvData([]);

    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.name.endsWith('.csv')) {
      setCsvError('Please upload a CSV file');
      return;
    }

    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const text = event.target?.result as string;
        const rows = parseCSV(text);

        if (rows.length === 0) {
          setCsvError('CSV file is empty or has no valid data rows');
          return;
        }

        setCsvData(rows);
      } catch (err) {
        setCsvError(err instanceof Error ? err.message : 'Failed to parse CSV');
      }
    };
    reader.readAsText(file);
  };

  const parseCSV = (text: string): CSVRow[] => {
    const lines = text.split('\n').map(line => line.trim()).filter(line => line);

    if (lines.length < 2) {
      throw new Error('CSV must have a header row and at least one data row');
    }

    const headers = lines[0].split(',').map(h => h.trim().toLowerCase().replace(/"/g, ''));

    // Validate required headers
    const requiredHeaders = ['location_name', 'post_content'];
    for (const required of requiredHeaders) {
      if (!headers.includes(required)) {
        throw new Error(`Missing required column: ${required}`);
      }
    }

    const rows: CSVRow[] = [];
    for (let i = 1; i < lines.length; i++) {
      const values = parseCSVLine(lines[i]);

      if (values.length !== headers.length) {
        console.warn(`Skipping row ${i + 1}: column count mismatch`);
        continue;
      }

      const row: Record<string, string> = {};
      headers.forEach((header, index) => {
        row[header] = values[index];
      });

      if (!row.location_name || !row.post_content) {
        console.warn(`Skipping row ${i + 1}: missing required fields`);
        continue;
      }

      rows.push({
        location_name: row.location_name,
        post_content: row.post_content,
        link_url: row.link_url || '',
        scheduled_for: row.scheduled_for || '',
      });
    }

    return rows;
  };

  const parseCSVLine = (line: string): string[] => {
    const values: string[] = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const char = line[i];

      if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === ',' && !inQuotes) {
        values.push(current.trim());
        current = '';
      } else {
        current += char;
      }
    }
    values.push(current.trim());

    return values;
  };

  const downloadTemplate = () => {
    const headers = ['location_name', 'post_content', 'link_url', 'scheduled_for'];
    const exampleRow = [
      'Home Instead San Diego',
      'Check out our latest blog post about senior care tips!',
      'https://example.com/blog/senior-care-tips',
      '2025-01-20T10:00'
    ];

    const csv = [
      headers.join(','),
      exampleRow.map(v => `"${v}"`).join(','),
    ].join('\n');

    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'facebook_posts_template.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  // Get minimum datetime (now)
  const getMinDateTime = () => {
    const now = new Date();
    now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
    return now.toISOString().slice(0, 16);
  };

  const pageOptions = pages.map(p => ({
    id: p.id,
    label: p.location_name,
    subLabel: p.facebook_page_id,
  }));

  return (
    <div className="bg-white rounded-lg shadow">
      {/* Mode Tabs */}
      <div className="border-b">
        <div className="flex">
          <button
            onClick={() => setActiveMode('single')}
            className={`flex-1 py-3 px-4 text-sm font-medium border-b-2 ${
              activeMode === 'single'
                ? 'border-blue-500 text-blue-600 bg-blue-50'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            Single Post
          </button>
          <button
            onClick={() => setActiveMode('bulk')}
            className={`flex-1 py-3 px-4 text-sm font-medium border-b-2 ${
              activeMode === 'bulk'
                ? 'border-blue-500 text-blue-600 bg-blue-50'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            Bulk Upload (CSV)
          </button>
        </div>
      </div>

      <div className="p-6">
        {activeMode === 'single' ? (
          <>
            <h2 className="text-lg font-semibold text-gray-900 mb-6">Create New Post</h2>

            <form onSubmit={handleSubmit} className="space-y-6">
              {/* Page Selection - Multi-select */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Facebook Pages ({selectedPageIds.length} selected)
                </label>
                <SearchableMultiSelect
                  options={pageOptions}
                  selectedIds={selectedPageIds}
                  onChange={setSelectedPageIds}
                  placeholder="Search and select pages..."
                  disabled={submitting}
                />
                {pages.length === 0 && (
                  <p className="mt-2 text-sm text-amber-600">
                    No pages configured. Add pages to the facebook_pages Supabase table.
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
                  disabled={submitting || selectedPageIds.length === 0 || !postContent.trim()}
                  className={`px-6 py-2 rounded-lg font-medium text-white ${
                    submitting || selectedPageIds.length === 0 || !postContent.trim()
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
                    `Publish to ${selectedPageIds.length} Page${selectedPageIds.length !== 1 ? 's' : ''}`
                  ) : (
                    `Schedule for ${selectedPageIds.length} Page${selectedPageIds.length !== 1 ? 's' : ''}`
                  )}
                </button>
              </div>
            </form>
          </>
        ) : (
          <>
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-lg font-semibold text-gray-900">Bulk Upload Posts</h2>
              <button
                onClick={downloadTemplate}
                className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-blue-600 bg-blue-50 rounded-lg hover:bg-blue-100"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                </svg>
                Download Template
              </button>
            </div>

            <div className="space-y-6">
              {/* File Upload */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Upload CSV File
                </label>
                <div className="border-2 border-dashed border-gray-300 rounded-lg p-6 text-center hover:border-gray-400 transition-colors">
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".csv"
                    onChange={handleFileUpload}
                    className="hidden"
                    id="csv-upload"
                  />
                  <label htmlFor="csv-upload" className="cursor-pointer">
                    <svg className="mx-auto h-12 w-12 text-gray-400 mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                    </svg>
                    <p className="text-sm text-gray-600">
                      <span className="text-blue-600 font-medium">Click to upload</span> or drag and drop
                    </p>
                    <p className="text-xs text-gray-500 mt-1">CSV files only</p>
                  </label>
                </div>
                {csvError && (
                  <p className="mt-2 text-sm text-red-600">{csvError}</p>
                )}
              </div>

              {/* CSV Preview */}
              {csvData.length > 0 && (
                <div>
                  <h3 className="text-sm font-medium text-gray-700 mb-2">
                    Preview ({csvData.length} posts)
                  </h3>
                  <div className="border rounded-lg overflow-hidden">
                    <div className="max-h-64 overflow-auto">
                      <table className="min-w-full divide-y divide-gray-200">
                        <thead className="bg-gray-50 sticky top-0">
                          <tr>
                            <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Location</th>
                            <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Content</th>
                            <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Scheduled</th>
                          </tr>
                        </thead>
                        <tbody className="bg-white divide-y divide-gray-200">
                          {csvData.map((row, index) => (
                            <tr key={index}>
                              <td className="px-4 py-2 text-sm text-gray-900 whitespace-nowrap">
                                {row.location_name}
                              </td>
                              <td className="px-4 py-2 text-sm text-gray-600 max-w-xs truncate">
                                {row.post_content}
                              </td>
                              <td className="px-4 py-2 text-sm text-gray-500 whitespace-nowrap">
                                {row.scheduled_for || 'Draft'}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>
              )}

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
              <div className="flex justify-end">
                <button
                  onClick={handleBulkSubmit}
                  disabled={submitting || csvData.length === 0}
                  className={`px-6 py-2 rounded-lg font-medium text-white ${
                    submitting || csvData.length === 0
                      ? 'bg-gray-400 cursor-not-allowed'
                      : 'bg-blue-600 hover:bg-blue-700'
                  }`}
                >
                  {submitting ? (
                    <span className="flex items-center gap-2">
                      <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                      </svg>
                      Uploading...
                    </span>
                  ) : (
                    `Upload ${csvData.length} Post${csvData.length !== 1 ? 's' : ''}`
                  )}
                </button>
              </div>

              {/* Instructions */}
              <div className="bg-gray-50 rounded-lg p-4">
                <h4 className="text-sm font-medium text-gray-700 mb-2">CSV Format Instructions</h4>
                <ul className="text-sm text-gray-600 space-y-1">
                  <li>• <strong>location_name</strong> (required): Must match a location in the database exactly</li>
                  <li>• <strong>post_content</strong> (required): The text content of your post</li>
                  <li>• <strong>link_url</strong> (optional): URL to include with the post</li>
                  <li>• <strong>scheduled_for</strong> (optional): Date/time in format YYYY-MM-DDTHH:MM (e.g., 2025-01-20T10:00)</li>
                </ul>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
