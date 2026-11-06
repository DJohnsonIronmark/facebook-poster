export type ReviewPostStatus = 'internal_review' | 'client_review' | 'client_approved';
export type BatchStatus = 'internal_review' | 'client_review' | 'client_approved' | 'scheduled' | 'cancelled';

export interface LinkPreview {
  url: string;
  domain: string;
  title?: string | null;
  description?: string | null;
  image?: string | null;
}

export interface FbClient {
  id: string;
  name: string;
  approval_workflow_enabled: boolean;
  account_manager_email: string | null;
  client_reviewer_emails: string[];
}

export interface ReviewPost {
  id: string;
  facebook_page_id: string;
  franchise_name: string;
  location_number: string | null;
  post_content: string;
  link_url: string | null;
  media_url: string | null;
  media_type: string | null;
  scheduled_for: string | null;
  status: string;
  client_comment: string | null;
  link_preview: LinkPreview | null;
  review_batch_id: string | null;
  original_content?: string | null;  // text as first drafted
  client_edited?: boolean;
}

export interface ReviewBatch {
  id: string;
  client_id: string;
  name: string;
  status: BatchStatus;
  created_by_email: string | null;
  internal_approved_by_email: string | null;
  internal_approved_at: string | null;
  sent_to_client_at: string | null;
  client_approved_by: string | null;
  client_approved_at: string | null;
  client_token_expires_at: string | null;
  scheduled_at: string | null;
  created_at: string;
  client?: FbClient;
  posts?: ReviewPost[];
}

// Columns safe to send to the browser (never the token hash)
export const BATCH_PUBLIC_COLUMNS =
  'id, client_id, name, status, created_by_email, internal_approved_by_email, internal_approved_at, sent_to_client_at, client_approved_by, client_approved_at, client_token_expires_at, scheduled_at, created_at';

export const POST_REVIEW_COLUMNS =
  'id, facebook_page_id, franchise_name, location_number, post_content, link_url, media_url, media_type, scheduled_for, status, client_comment, link_preview, review_batch_id';

export const MAX_POST_LENGTH = 63206;
