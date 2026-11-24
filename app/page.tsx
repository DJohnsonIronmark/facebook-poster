'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import PostForm from '@/components/PostForm';
import PostList from '@/components/PostList';
import PostFilters, { FilterState } from '@/components/PostFilters';
import ApprovalsTab from '@/components/ApprovalsTab';
import PagesManager from '@/components/PagesManager';
import ClientSettings from '@/components/ClientSettings';
import PostCalendar from '@/components/PostCalendar';
import LinkInBioTab from '@/components/LinkInBioTab';
import InboxTab from '@/components/InboxTab';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/context/AuthContext';

export interface FacebookPage {
  id: string;
  location_name: string;
  location_number: string | null;
  facebook_page_id: string;
  city: string | null;
  base_url: string | null;
  phone: string | null;
  client_id?: string | null;
  ig_user_id?: string | null;   // linked Instagram business account (required for Instagram posts)
  ig_username?: string | null;
  linkedin_org_id?: string | null;        // LinkedIn company page (required for LinkedIn posts)
  linkedin_org_name?: string | null;
  linkedin_connection_id?: string | null; // connected LinkedIn admin used to post for this page
  x_connection_id?: string | null;        // connected X account (required for X posts)
  x_username?: string | null;
  linkedin_connection_status?: string | null; // 'active' | 'needs_reauth' | 'disconnected' | 'missing' | null
  x_connection_status?: string | null;
}

export interface ScheduledPost {
  id: string;
  facebook_page_id: string;
  franchise_name: string;
  location_number: string | null;
  post_content: string;
  link_url: string;
  scheduled_for: string | null;
  status: 'pending' | 'publishing' | 'published' | 'failed' | 'internal_review' | 'client_review' | 'client_approved';
  created_at: string;
  published_at: string | null;
  facebook_post_id: string | null;
  platform?: 'facebook' | 'instagram' | 'linkedin' | 'x' | null;
  post_group_id?: string | null;
  platform_post_id?: string | null;   // LinkedIn post URN / X post id once published
  publish_error?: string | null;      // last LinkedIn / X / Instagram / app publishing failure
  media_url?: string | null;
  media_type?: string | null;
  linkedin_org_name?: string | null;
  x_username?: string | null;
}

export default function Home() {
  const [pages, setPages] = useState<FacebookPage[]>([]);
  const [posts, setPosts] = useState<ScheduledPost[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'create' | 'approvals' | 'scheduled' | 'published' | 'inbox' | 'bio' | 'pages' | 'clients'>('create');
  const [filters, setFilters] = useState<FilterState>({ location: '', dateFrom: '', dateTo: '' });
  // Scheduled tab: list or month calendar (remembered per browser)
  const [scheduledView, setScheduledView] = useState<'list' | 'calendar'>('list');
  useEffect(() => {
    const saved = window.localStorage.getItem('scheduledView');
    if (saved === 'calendar' || saved === 'list') setScheduledView(saved);
  }, []);
  const chooseScheduledView = (v: 'list' | 'calendar') => { setScheduledView(v); window.localStorage.setItem('scheduledView', v); };
  // Scheduled tab: filter by client ('all', 'none' = pages with no client, or a client id); remembered per browser
  const [clients, setClients] = useState<{ id: string; name: string }[]>([]);
  const [scheduledClient, setScheduledClient] = useState('all');
  useEffect(() => {
    const saved = window.localStorage.getItem('scheduledClient');
    if (saved) setScheduledClient(saved);
    fetch('/api/clients')
      .then((r) => (r.ok ? r.json() : { clients: [] }))
      .then((d) => setClients((d.clients || []).map((c: { id: string; name: string }) => ({ id: c.id, name: c.name }))))
      .catch(() => {});
  }, []);
  const chooseScheduledClient = (v: string) => { setScheduledClient(v); window.localStorage.setItem('scheduledClient', v); };
  const router = useRouter();
  const supabase = createClient();
  const { role, user } = useAuth();

  // Internal View Only (viewer) accounts can't create posts: start them on Approvals
  useEffect(() => {
    if (role === 'viewer') setActiveTab((t) => (t === 'create' ? 'approvals' : t));
  }, [role]);

  // Deep link from notification emails: /?tab=approvals
  useEffect(() => {
    const tab = new URLSearchParams(window.location.search).get('tab');
    if (tab === 'approvals' || tab === 'scheduled' || tab === 'published' || tab === 'inbox' || tab === 'bio' || tab === 'pages' || tab === 'clients') setActiveTab(tab);
  }, []);

  const handleLogout = async () => {
    await supabase.auth.signOut();
    router.push('/login');
    router.refresh();
  };

  const fetchPages = useCallback(async () => {
    try {
      const response = await fetch('/api/pages');
      if (response.ok) {
        const data = await response.json();
        setPages(data.pages || []);
      }
    } catch (error) {
      console.error('Error fetching pages:', error);
    }
  }, []);

  const fetchPosts = useCallback(async () => {
    try {
      const response = await fetch('/api/posts');
      if (response.ok) {
        const data = await response.json();
        setPosts(data.posts || []);
      }
    } catch (error) {
      console.error('Error fetching posts:', error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchPages();
    fetchPosts();
  }, [fetchPages, fetchPosts]);

  const handlePostCreated = (destination: 'scheduled' | 'approvals' = 'scheduled') => {
    fetchPosts();
    setActiveTab(destination);
  };

  const handlePostDeleted = (postId: string) => {
    setPosts(posts.filter(p => p.id !== postId));
  };

  const handlePostPublished = (postId: string) => {
    setPosts(posts.map(p =>
      p.id === postId ? { ...p, status: 'published' as const, published_at: new Date().toISOString() } : p
    ));
  };

  // Scheduled tab: waiting posts, LinkedIn/X posts the runner is posting right now, and LinkedIn/X
  // posts whose publishing failed (their error is shown; Facebook failures are handled in n8n)
  const pendingPosts = posts.filter(p => p.status === 'pending' || p.status === 'publishing'
    || (p.status === 'failed' && (p.platform === 'linkedin' || p.platform === 'x' || p.platform === 'instagram')));
  const publishedPosts = posts.filter(p => p.status === 'published');
  // Client of each post, through its page (facebook_page_id → page → client_id)
  const clientOfPage = new Map(pages.map((pg) => [pg.facebook_page_id, pg.client_id || null]));
  const clientOfPost = (p: ScheduledPost) => clientOfPage.get(p.facebook_page_id) ?? null;
  const scheduledCount = (key: string) => pendingPosts.filter((p) => (key === 'none' ? !clientOfPost(p) : clientOfPost(p) === key)).length;
  // A remembered client that no longer exists falls back to all clients
  const activeScheduledClient = scheduledClient === 'all' || scheduledClient === 'none' || clients.some((c) => c.id === scheduledClient) ? scheduledClient : 'all';
  const scheduledVisible = activeScheduledClient === 'all' ? pendingPosts
    : pendingPosts.filter((p) => (activeScheduledClient === 'none' ? !clientOfPost(p) : clientOfPost(p) === activeScheduledClient));
  // Apply filters to published posts
  const filteredPublishedPosts = useMemo(() => {
    return publishedPosts.filter(post => {
      // Location filter
      if (filters.location) {
        const matchesLocation =
          post.location_number === filters.location ||
          post.franchise_name === filters.location;
        if (!matchesLocation) return false;
      }

      // Date range filter (based on published_at)
      if (filters.dateFrom && post.published_at) {
        const publishedDate = new Date(post.published_at);
        const fromDate = new Date(filters.dateFrom);
        fromDate.setHours(0, 0, 0, 0);
        if (publishedDate < fromDate) return false;
      }

      if (filters.dateTo && post.published_at) {
        const publishedDate = new Date(post.published_at);
        const toDate = new Date(filters.dateTo);
        toDate.setHours(23, 59, 59, 999);
        if (publishedDate > toDate) return false;
      }

      return true;
    });
  }, [publishedPosts, filters]);

  // Get unique locations from published posts for filter dropdown
  const publishedLocations = useMemo(() => {
    return publishedPosts.map(p => ({
      location_number: p.location_number,
      franchise_name: p.franchise_name
    }));
  }, [publishedPosts]);

  return (
    <div className="min-h-screen bg-gray-100">
      {/* Header */}
      <header className="bg-white shadow">
        <div className="max-w-5xl mx-auto px-4 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-blue-600 rounded-lg flex items-center justify-center">
                <svg className="w-6 h-6 text-white" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/>
                </svg>
              </div>
              <h1 className="text-xl font-bold text-gray-800">Facebook Poster</h1>
            </div>
            <button
              onClick={handleLogout}
              className="text-sm text-gray-500 hover:text-gray-700"
            >
              Sign Out
            </button>
          </div>
        </div>
      </header>

      {/* Tab Navigation */}
      <div className="max-w-5xl mx-auto px-4 mt-6">
        <div className="border-b border-gray-200">
          <nav className="-mb-px flex space-x-6">
            {role !== 'viewer' && (
            <button
              onClick={() => setActiveTab('create')}
              className={`py-4 px-1 border-b-2 font-medium text-sm ${
                activeTab === 'create'
                  ? 'border-blue-500 text-blue-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
            >
              Create Post
            </button>
            )}
            <button
              onClick={() => setActiveTab('approvals')}
              className={`py-4 px-1 border-b-2 font-medium text-sm ${
                activeTab === 'approvals'
                  ? 'border-blue-500 text-blue-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
            >
              Approvals
            </button>
            <button
              onClick={() => setActiveTab('scheduled')}
              className={`py-4 px-1 border-b-2 font-medium text-sm ${
                activeTab === 'scheduled'
                  ? 'border-blue-500 text-blue-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
            >
              Scheduled ({pendingPosts.length})
            </button>
            <button
              onClick={() => setActiveTab('published')}
              className={`py-4 px-1 border-b-2 font-medium text-sm ${
                activeTab === 'published'
                  ? 'border-blue-500 text-blue-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
            >
              Published ({publishedPosts.length})
            </button>
            <button
              onClick={() => setActiveTab('inbox')}
              className={`py-4 px-1 border-b-2 font-medium text-sm ${
                activeTab === 'inbox'
                  ? 'border-blue-500 text-blue-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
            >
              Inbox
            </button>
            <button
              onClick={() => setActiveTab('bio')}
              className={`py-4 px-1 border-b-2 font-medium text-sm ${
                activeTab === 'bio'
                  ? 'border-blue-500 text-blue-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
            >
              Link in bio
            </button>
            {(role === 'admin' || role === 'manager') && (
              <button
                onClick={() => setActiveTab('pages')}
                className={`py-4 px-1 border-b-2 font-medium text-sm ${
                  activeTab === 'pages'
                    ? 'border-blue-500 text-blue-600'
                    : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                }`}
              >
                Pages ({pages.length})
              </button>
            )}
            {role === 'admin' && (
              <button
                onClick={() => setActiveTab('clients')}
                className={`py-4 px-1 border-b-2 font-medium text-sm ${
                  activeTab === 'clients'
                    ? 'border-blue-500 text-blue-600'
                    : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                }`}
              >
                Clients
              </button>
            )}
          </nav>
        </div>
      </div>

      {/* Content */}
      <main className="max-w-5xl mx-auto px-4 py-8">
        {activeTab === 'create' && role !== 'viewer' && (
          <PostForm pages={pages} onPostCreated={handlePostCreated} />
        )}
        {activeTab === 'pages' && (role === 'admin' || role === 'manager') && (
          <PagesManager onPagesChanged={fetchPages} />
        )}
        {activeTab === 'clients' && role === 'admin' && (
          <div className="space-y-4">
            <div className="bg-blue-50 border border-blue-100 rounded-lg px-4 py-3 text-sm text-blue-900">
              <p className="font-medium">Set up a client for the approval workflow</p>
              <ol className="mt-1 list-decimal list-inside space-y-0.5">
                <li>Add the client below (e.g. Home Instead), or open one that already exists.</li>
                <li>Turn on <strong>Approval workflow</strong>, then add the account manager and the client reviewers&apos; emails.</li>
                <li>Choose the client&apos;s pages and save. New posts for those pages then go to the Approvals tab for review.</li>
              </ol>
            </div>
            <ClientSettings />
          </div>
        )}
        {activeTab === 'clients' && role !== 'admin' && (
          <div className="bg-white rounded-lg shadow p-8 text-center text-gray-500">Only admins can set up clients.</div>
        )}
        {activeTab === 'inbox' && (
          <InboxTab canAct={role === 'admin' || role === 'manager'} />
        )}
        {activeTab === 'bio' && (
          <LinkInBioTab canEdit={role === 'admin' || role === 'manager'} />
        )}
        {activeTab === 'approvals' && (
          <ApprovalsTab
            canEdit={role === 'admin' || role === 'manager'}
            isAdmin={role === 'admin'}
            userEmail={user?.email ?? null}
            onScheduled={fetchPosts}
            onOpenClients={() => setActiveTab('clients')}
          />
        )}
        {activeTab === 'scheduled' && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-3">
              <label className="flex items-center gap-2 text-sm text-gray-700">
                <span>Client</span>
                <select value={activeScheduledClient} onChange={(e) => chooseScheduledClient(e.target.value)}
                  className="border border-gray-300 rounded-lg px-3 py-1.5 bg-white text-sm" aria-label="Filter scheduled posts by client">
                  <option value="all">All clients ({pendingPosts.length})</option>
                  {[...clients].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })).map((c) => (
                    <option key={c.id} value={c.id}>{c.name} ({scheduledCount(c.id)})</option>
                  ))}
                  {scheduledCount('none') > 0 && <option value="none">No client ({scheduledCount('none')})</option>}
                </select>
              </label>
              {activeScheduledClient !== 'all' && (
                <button onClick={() => chooseScheduledClient('all')} className="text-sm text-blue-600 hover:underline">Clear</button>
              )}
              <div className="ml-auto inline-flex rounded-lg bg-white shadow-sm p-1" role="tablist" aria-label="Scheduled view">
                {(['list', 'calendar'] as const).map((v) => (
                  <button key={v} role="tab" aria-selected={scheduledView === v} onClick={() => chooseScheduledView(v)}
                    className={`px-3 py-1.5 rounded-md text-sm font-medium ${scheduledView === v ? 'bg-blue-600 text-white' : 'text-gray-600 hover:bg-gray-100'}`}>
                    {v === 'list' ? 'List' : 'Calendar'}
                  </button>
                ))}
              </div>
            </div>
            {scheduledView === 'calendar' ? (
              loading ? <div className="bg-white rounded-lg shadow p-8 text-center text-gray-600">Loading…</div> : <PostCalendar posts={scheduledVisible} />
            ) : (
              <PostList
                posts={scheduledVisible}
                loading={loading}
                emptyMessage={activeScheduledClient === 'all' ? 'No scheduled posts' : 'No scheduled posts for this client'}
                showPublishButton={true}
                onPostDeleted={handlePostDeleted}
                onPostPublished={handlePostPublished}
                canEdit={role !== 'viewer'}
              />
            )}
          </div>
        )}
        {activeTab === 'published' && (
          <>
            <PostFilters
              locations={publishedLocations}
              onFilterChange={setFilters}
            />
            <PostList
              posts={filteredPublishedPosts}
              loading={loading}
              emptyMessage={filters.location || filters.dateFrom || filters.dateTo
                ? "No posts match the current filters"
                : "No published posts yet"}
              showPublishButton={false}
              onPostDeleted={handlePostDeleted}
              onPostPublished={handlePostPublished}
            canEdit={role !== 'viewer'}
            />
            {filteredPublishedPosts.length !== publishedPosts.length && (
              <p className="text-sm text-gray-500 mt-2 text-center">
                Showing {filteredPublishedPosts.length} of {publishedPosts.length} published posts
              </p>
            )}
          </>
        )}
      </main>
    </div>
  );
}
