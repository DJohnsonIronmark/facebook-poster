-- Facebook Pages table
-- Stores the Facebook pages that can be posted to
CREATE TABLE IF NOT EXISTS facebook_pages (
  id TEXT PRIMARY KEY,  -- Facebook Page ID
  name TEXT NOT NULL,   -- Page name from Facebook
  franchise_name TEXT NOT NULL,  -- Friendly name (e.g., "Home Instead San Diego")
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Example data (update with actual page IDs)
-- INSERT INTO facebook_pages (id, name, franchise_name) VALUES
--   ('123456789', 'Home Instead Senior Care', 'Home Instead San Diego'),
--   ('987654321', 'Home Instead Senior Care', 'Home Instead Los Angeles');

-- Facebook Scheduled Posts table
-- Stores posts that are scheduled or have been published
CREATE TABLE IF NOT EXISTS facebook_scheduled_posts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  facebook_page_id TEXT NOT NULL,
  franchise_name TEXT NOT NULL,
  post_content TEXT NOT NULL,
  link_url TEXT,
  scheduled_for TIMESTAMPTZ,  -- NULL for drafts or immediate posts
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'published', 'failed')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  published_at TIMESTAMPTZ,

  -- Optional: Add foreign key if you want referential integrity
  -- FOREIGN KEY (facebook_page_id) REFERENCES facebook_pages(id)
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_scheduled_posts_status ON facebook_scheduled_posts(status);
CREATE INDEX IF NOT EXISTS idx_scheduled_posts_scheduled_for ON facebook_scheduled_posts(scheduled_for);
CREATE INDEX IF NOT EXISTS idx_scheduled_posts_facebook_page_id ON facebook_scheduled_posts(facebook_page_id);

-- Enable Row Level Security (optional - uncomment if needed)
-- ALTER TABLE facebook_pages ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE facebook_scheduled_posts ENABLE ROW LEVEL SECURITY;

-- Policy examples (adjust as needed for your auth setup)
-- CREATE POLICY "Allow all for authenticated users" ON facebook_pages FOR ALL USING (true);
-- CREATE POLICY "Allow all for authenticated users" ON facebook_scheduled_posts FOR ALL USING (true);
