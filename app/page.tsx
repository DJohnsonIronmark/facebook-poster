'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import PostForm from '@/components/PostForm';
import PostList from '@/components/PostList';
import { createClient } from '@/lib/supabase/client';

export interface FacebookPage {
  id: string;
  location_name: string;
  location_number: string | null;
  facebook_page_id: string;
  city: string | null;
  base_url: string | null;
  phone: string | null;
}

export interface ScheduledPost {
  id: string;
  facebook_page_id: string;
  franchise_name: string;
  location_number: string | null;
  post_content: string;
  link_url: string;
  scheduled_for: string | null;
  status: 'pending' | 'published' | 'failed';
  created_at: string;
  published_at: string | null;
}

export default function Home() {
  const [pages, setPages] = useState<FacebookPage[]>([]);
  const [posts, setPosts] = useState<ScheduledPost[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'create' | 'scheduled' | 'published'>('create');
  const router = useRouter();
  const supabase = createClient();

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

  const handlePostCreated = () => {
    fetchPosts();
    setActiveTab('scheduled');
  };

  const handlePostDeleted = (postId: string) => {
    setPosts(posts.filter(p => p.id !== postId));
  };

  const handlePostPublished = (postId: string) => {
    setPosts(posts.map(p =>
      p.id === postId ? { ...p, status: 'published' as const, published_at: new Date().toISOString() } : p
    ));
  };

  const pendingPosts = posts.filter(p => p.status === 'pending');
  const publishedPosts = posts.filter(p => p.status === 'published');

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
          </nav>
        </div>
      </div>

      {/* Content */}
      <main className="max-w-5xl mx-auto px-4 py-8">
        {activeTab === 'create' && (
          <PostForm pages={pages} onPostCreated={handlePostCreated} />
        )}
        {activeTab === 'scheduled' && (
          <PostList
            posts={pendingPosts}
            loading={loading}
            emptyMessage="No scheduled posts"
            showPublishButton={true}
            onPostDeleted={handlePostDeleted}
            onPostPublished={handlePostPublished}
          />
        )}
        {activeTab === 'published' && (
          <PostList
            posts={publishedPosts}
            loading={loading}
            emptyMessage="No published posts yet"
            showPublishButton={false}
            onPostDeleted={handlePostDeleted}
            onPostPublished={handlePostPublished}
          />
        )}
      </main>
    </div>
  );
}
