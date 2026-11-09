'use client';

import { useState, useRef, useEffect, useMemo } from 'react';
import type { FacebookPage } from '@/app/page';
import SearchableMultiSelect from './SearchableMultiSelect';
import FacebookPostPreview from './FacebookPostPreview';
import InstagramPostPreview from './InstagramPostPreview';
import PlatformBadge from './PlatformBadge';
import IgCaptionMeter from './IgCaptionMeter';
import { replacePlaceholders } from '@/lib/placeholders';
import { ACCEPT_MEDIA, MEDIA_HELP, baseName, fileExtension, mapRowsToFiles, validateMediaFile, type RowMediaStatus } from '@/lib/media/mapping';
import { uploadMediaFiles } from '@/lib/media/upload';
// MM/DD/YYYY [h:mm AM|PM] (local) or ISO → ISO; same rules the CSV importer always used
import { parseScheduledDate } from '@/lib/csv';
import { evaluateInstagramTarget, parsePlatformsCell, type IgTargetMedia, type Platform } from '@/lib/instagram/rules';
import { analyzeInstagramMedia, releaseIgMedia, type IgMediaInfo } from '@/lib/instagram/browser';

interface PostFormProps {
  pages: FacebookPage[];
  onPostCreated: (destination?: 'scheduled' | 'approvals') => void;
}

interface DraftPayload {
  page_id: string;
  post_content: string;
  link_url: string | null;
  scheduled_for: string | null;
  media_type: string | null;
  media_url: string | null;
  platform: Platform;
  post_group_id: string | null;
}

/** Browser analysis of a media file for Instagram → the shape evaluateInstagramTarget expects */
function preparedIssues(info: IgMediaInfo | null | undefined): { errors: string[]; warnings: string[] } | undefined {
  if (!info || info.state === 'loading') return undefined;
  if (info.state === 'error') return { errors: [info.message], warnings: [] };
  if (info.state === 'photo') return { errors: [], warnings: info.plan.cropped ? [info.plan.note, ...info.warnings] : info.warnings };
  return { errors: info.errors, warnings: info.warnings };
}

const pageValues = (pg: FacebookPage | null | undefined) =>
  pg ? { city: pg.city, franchise_name: pg.location_name, location_number: pg.location_number, base_url: pg.base_url, phone: pg.phone } : {};

/** One id per post whose Facebook and Instagram versions are linked (validated and re-issued server-side) */
const newGroupId = (platforms: Platform[]) => (platforms.length > 1 ? crypto.randomUUID() : null);

// Sends rows for approval-enabled clients into the review queue; returns a human summary
async function submitDrafts(rows: DraftPayload[]): Promise<{ ok: boolean; summary: string }> {
  const res = await fetch('/api/review/drafts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rows }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, summary: data.error || 'Failed to submit drafts for review' };
  const batches: { client: string; posts: number; email: string }[] = data.batches || [];
  const parts = batches.map((b) => `${b.client}: ${b.posts} draft(s)${b.email === 'sent' ? ', team notified' : ' (notification email not sent)'}`);
  const skipped: { row: number; reason: string }[] = data.skipped || [];
  if (skipped.length) parts.push(`${skipped.length} skipped (${skipped.slice(0, 3).map((s) => `row ${s.row}: ${s.reason}`).join('; ')})`);
  return { ok: batches.length > 0, summary: `Sent to approval: ${parts.join(' · ')}` };
}

interface CSVRow {
  location_name: string;
  location_number: string;
  post_content: string;
  link_url: string;
  scheduled_for: string;
  media_type: string;
  media_file: string;
  media_url: string;
  platforms: string;
  ig_caption: string;
}

interface RowPlan {
  page: FacebookPage | undefined;
  platforms: Platform[];
  errors: string[];
  warnings: string[];
  pending: boolean;
  igCaption: string;
}

const MEDIA_FILE_EXTS = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'mp4', 'mov'];
const isCsvFile = (f: File) => fileExtension(f.name) === 'csv' || f.type === 'text/csv';
const isMediaCandidate = (f: File) => f.type.startsWith('image/') || f.type.startsWith('video/') || MEDIA_FILE_EXTS.includes(fileExtension(f.name));

function mediaStatusLabel(s: RowMediaStatus): string {
  if (s.state === 'none') return 'text';
  if (s.state === 'url') return `${s.kind} (URL)`;
  if (s.state === 'file') return s.kind;
  return s.message;
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
  const [mediaType, setMediaType] = useState<'text' | 'photo' | 'video'>('text');
  const [mediaUrl, setMediaUrl] = useState('');
  const [mediaInputMode, setMediaInputMode] = useState<'url' | 'file'>('file');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  // storage:// ref of selectedFile once uploaded (private drafts bucket; made public on schedule)
  const [uploadedUrl, setUploadedUrl] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  // Bulk: media files dropped alongside the CSV, mapped to rows by the media_file column
  const [mediaFiles, setMediaFiles] = useState<File[]>([]);
  const [mediaObjectUrls, setMediaObjectUrls] = useState<string[]>([]);
  const [bulkNotice, setBulkNotice] = useState<string | null>(null);
  const [uploadProgress, setUploadProgress] = useState<string | null>(null);
  const [isDraggingCSV, setIsDraggingCSV] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const mediaFileInputRef = useRef<HTMLInputElement>(null);
  const [approvalClientIds, setApprovalClientIds] = useState<Set<string>>(new Set());
  const [showBulkPreviews, setShowBulkPreviews] = useState(false);
  // Instagram
  const [igEnabled, setIgEnabled] = useState(false);
  const [wantFb, setWantFb] = useState(true);
  const [wantIg, setWantIg] = useState(false);
  const [igCaption, setIgCaption] = useState('');
  const [singleIg, setSingleIg] = useState<IgMediaInfo | null>(null);
  // Bulk: Instagram analysis per media file (JPEG derivative for photos, length/shape for videos)
  const [igMedia, setIgMedia] = useState<Map<File, IgMediaInfo>>(new Map());
  const igInFlight = useRef(new Set<File>());
  const mediaFilesRef = useRef<File[]>([]);
  mediaFilesRef.current = mediaFiles;

  // Which clients have the approval workflow turned on; whether Instagram rows may be scheduled
  useEffect(() => {
    fetch('/api/clients')
      .then((r) => (r.ok ? r.json() : { clients: [] }))
      .then((d) => setApprovalClientIds(new Set((d.clients || []).filter((c: any) => c.approval_workflow_enabled).map((c: any) => c.id))))
      .catch(() => {});
    fetch('/api/instagram/status')
      .then((r) => (r.ok ? r.json() : { publishing_enabled: false }))
      .then((d) => setIgEnabled(d.publishing_enabled === true))
      .catch(() => {});
  }, []);

  // Single post: prepare the Instagram version of the selected file
  useEffect(() => {
    if (!wantIg || !selectedFile || mediaType === 'text') { setSingleIg(null); return; }
    let cancelled = false;
    let made: IgMediaInfo | undefined;
    setSingleIg({ state: 'loading' });
    analyzeInstagramMedia(selectedFile, mediaType).then((info) => {
      made = info;
      if (cancelled) releaseIgMedia(info); else setSingleIg(info);
    });
    return () => { cancelled = true; releaseIgMedia(made); };
  }, [wantIg, selectedFile, mediaType]);

  // Local object URLs so previews show the real files before anything is uploaded
  useEffect(() => {
    const urls = mediaFiles.map((f) => URL.createObjectURL(f));
    setMediaObjectUrls(urls);
    return () => urls.forEach((u) => URL.revokeObjectURL(u));
  }, [mediaFiles]);

  useEffect(() => {
    if (!selectedFile) { setPreviewUrl(null); return; }
    const url = URL.createObjectURL(selectedFile);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [selectedFile]);

  const needsApproval = (page: FacebookPage | null | undefined) =>
    !!page?.client_id && approvalClientIds.has(page.client_id);

  const selectedPages = pages.filter(p => selectedPageIds.includes(p.id));
  const singleHasApprovalPages = selectedPages.some(p => p.client_id && approvalClientIds.has(p.client_id));

  // Single post: Instagram checks per selected page (captions differ once placeholders are filled in).
  // Messages that apply to several pages are shown once with the page names.
  const singleIgMedia: IgTargetMedia = mediaType === 'text'
    ? { source: 'none' }
    : mediaInputMode === 'url'
      ? { source: 'url', kind: mediaType, url: mediaUrl.trim() }
      : selectedFile ? { source: 'file', kind: mediaType, prepared: preparedIssues(singleIg) } : { source: 'none' };
  const singleIgCheck = (() => {
    const errors = new Map<string, string[]>();
    const warnings = new Map<string, string[]>();
    let pending = false;
    if (!wantIg) return { errors: [] as string[], warnings: [] as string[], pending };
    for (const pg of selectedPages) {
      const r = evaluateInstagramTarget({
        caption: replacePlaceholders(igCaption.trim() || postContent, pageValues(pg)),
        pageFound: true,
        hasIgAccount: !!pg.ig_user_id,
        media: singleIgMedia,
        direct: !needsApproval(pg),
        instagramEnabled: igEnabled,
        hasSchedule: !!scheduledFor,
        publishNow,
      });
      pending = pending || r.pending;
      r.errors.forEach((e) => errors.set(e, [...(errors.get(e) || []), pg.location_name]));
      r.warnings.forEach((w) => warnings.set(w, [...(warnings.get(w) || []), pg.location_name]));
    }
    const label = (m: Map<string, string[]>) => Array.from(m.entries()).map(([msg, names]) =>
      selectedPages.length > 1 && names.length < selectedPages.length ? `${msg} (${names.slice(0, 3).join(', ')}${names.length > 3 ? '…' : ''})` : msg);
    return { errors: label(errors), warnings: label(warnings), pending };
  })();
  const singleIgBlocked = wantIg && (singleIgCheck.pending || singleIgCheck.errors.length > 0);
  const singlePlatforms: Platform[] = [...(wantFb ? ['facebook' as const] : []), ...(wantIg ? ['instagram' as const] : [])];

  // Handle CSV drag and drop
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDraggingCSV(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDraggingCSV(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDraggingCSV(false);

    handleBulkFiles(Array.from(e.dataTransfer.files || []));
  };

  // Bulk: accept the CSV and any number of media files together (in one or several drops)
  const handleBulkFiles = async (files: File[]) => {
    if (files.length === 0) return;
    setCsvError(null);
    setBulkNotice(null);
    const csvFiles = files.filter(isCsvFile);
    const media = files.filter((f) => !isCsvFile(f) && isMediaCandidate(f));
    const other = files.filter((f) => !isCsvFile(f) && !isMediaCandidate(f));
    const notes: string[] = [];
    if (other.some((f) => fileExtension(f.name) === 'zip')) {
      notes.push('ZIP files are not supported: unzip it and drop the CSV and media files together.');
    }
    const otherNames = other.filter((f) => fileExtension(f.name) !== 'zip').map((f) => f.name);
    if (otherNames.length) notes.push(`Ignored (not a CSV, image or video): ${otherNames.slice(0, 5).join(', ')}${otherNames.length > 5 ? '…' : ''}`);

    if (csvFiles.length > 1) {
      setCsvError('Drop one CSV at a time');
    } else if (csvFiles.length === 1) {
      try {
        const rows = parseCSV(await csvFiles[0].text());
        if (rows.length === 0) setCsvError('CSV file is empty or has no valid data rows');
        else setCsvData(rows);
      } catch (err) {
        setCsvError(err instanceof Error ? err.message : 'Failed to parse CSV');
      }
    }

    if (media.length > 0) {
      // Same file name again (any case) replaces the earlier file
      setMediaFiles((prev) => {
        const incoming = new Set(media.map((f) => baseName(f.name).toLowerCase()));
        return [...prev.filter((f) => !incoming.has(baseName(f.name).toLowerCase())), ...media];
      });
    }
    setBulkNotice(notes.length ? notes.join(' ') : null);
  };

  const removeMediaFile = (index: number) => setMediaFiles((prev) => prev.filter((_, i) => i !== index));

  // Handle media file selection
  const handleMediaFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const check = validateMediaFile(file);
    if (!check.ok) {
      setError(check.message);
      return;
    }
    if (check.kind !== mediaType) {
      setError(mediaType === 'photo' ? 'Please select an image file (JPG, PNG, GIF, WEBP)' : 'Please select a video file (MP4, MOV)');
      return;
    }

    setSelectedFile(file);
    setUploadedUrl(null);
    setError(null);
  };

  // Upload straight to Supabase Storage (private drafts bucket) via a signed upload URL
  const uploadFile = async (purpose: 'draft' | 'direct'): Promise<string | null> => {
    if (!selectedFile) return null;

    setUploading(true);
    setError(null);

    try {
      const [ref] = await uploadMediaFiles([selectedFile], purpose);
      setUploadedUrl(ref);
      return ref;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to upload file');
      return null;
    } finally {
      setUploading(false);
    }
  };

  // Clear media selection
  const clearMediaSelection = () => {
    setSelectedFile(null);
    setUploadedUrl(null);
    setMediaUrl('');
    if (mediaFileInputRef.current) {
      mediaFileInputRef.current.value = '';
    }
  };

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

      if (singlePlatforms.length === 0) throw new Error('Choose Facebook, Instagram or both');
      if (wantIg && singleIgCheck.pending) throw new Error('Still preparing the Instagram version of your media…');
      if (wantIg && singleIgCheck.errors.length > 0) throw new Error(`Instagram: ${singleIgCheck.errors[0]}`);
      const purpose = selectedPages.some(needsApproval) ? 'draft' : 'direct';

      // Media: Facebook keeps the original file; an Instagram photo uses its JPEG derivative
      // (a separate upload); an Instagram video shares the original file.
      let finalMediaUrl: string | null = null;
      if (mediaType !== 'text') {
        if (mediaInputMode === 'file') {
          if (!selectedFile) throw new Error('Please select a media file');
          if (wantFb || mediaType === 'video') {
            finalMediaUrl = uploadedUrl || await uploadFile(purpose);
            if (!finalMediaUrl) throw new Error('Failed to upload media file');
          }
        } else {
          // URL mode
          if (!mediaUrl.trim()) {
            throw new Error('Please enter a media URL');
          }
          finalMediaUrl = mediaUrl.trim();
        }
      }
      let igMediaUrl: string | null = null;
      if (wantIg && mediaType !== 'text') {
        if (mediaInputMode === 'url' || mediaType === 'video') igMediaUrl = finalMediaUrl;
        else if (singleIg?.state === 'photo') [igMediaUrl] = await uploadMediaFiles([singleIg.file], purpose);
        else throw new Error('The Instagram version of the photo is not ready');
      }

      const groupByPage = new Map(selectedPages.map((p) => [p.id, newGroupId(singlePlatforms)]));
      const contentFor = (platform: Platform) => (platform === 'instagram' ? igCaption.trim() || postContent.trim() : postContent.trim());
      const linkFor = (platform: Platform) => (platform === 'facebook' && mediaType === 'text' ? (linkUrl.trim() || null) : null);
      const mediaFor = (platform: Platform) => (platform === 'instagram' ? igMediaUrl : finalMediaUrl);

      // Pages whose client uses the approval workflow go to the review queue instead
      const approvalPages = selectedPages.filter(needsApproval);
      const directPages = selectedPages.filter(p => !needsApproval(p));
      let draftSummary = '';
      if (approvalPages.length > 0) {
        const drafts = await submitDrafts(approvalPages.flatMap((page) => singlePlatforms.map((platform) => ({
          page_id: page.id,
          post_content: contentFor(platform),
          link_url: linkFor(platform),
          scheduled_for: !publishNow && scheduledFor ? new Date(scheduledFor).toISOString() : null,
          media_type: mediaType !== 'text' ? mediaType : null,
          media_url: mediaFor(platform),
          platform,
          post_group_id: groupByPage.get(page.id) ?? null,
        }))));
        if (!drafts.ok) throw new Error(drafts.summary);
        draftSummary = drafts.summary;
      }

      // Create a post for each selected page and platform
      const results = await Promise.all(
        directPages.flatMap((page) => singlePlatforms.map(async (platform) => {
          const payload = {
            facebook_page_id: page.facebook_page_id,
            franchise_name: page.location_name,
            location_number: page.location_number || null,
            post_content: contentFor(platform),
            link_url: linkFor(platform),
            scheduled_for: publishNow ? null : (scheduledFor || null),
            publish_now: publishNow,
            media_type: mediaType !== 'text' ? mediaType : null,
            media_url: mediaFor(platform),
            platform,
            post_group_id: groupByPage.get(page.id) ?? null,
            // Placeholder values
            city: page.city || null,
            base_url: page.base_url || null,
            phone: page.phone || null,
          };

          const response = await fetch('/api/posts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          });

          return { page: platform === 'instagram' ? `${page.location_name} (Instagram)` : page.location_name, response };
        }))
      );

      const failed = results.filter(r => !r.response.ok);
      if (failed.length > 0) {
        throw new Error(`Failed to create posts for: ${failed.map(f => f.page).join(', ')}`);
      }

      const directMsg = results.length === 0
        ? ''
        : publishNow
          ? `Published to ${results.length} page(s) successfully!`
          : `Scheduled ${results.length} post(s) successfully!`;
      setSuccess([directMsg, draftSummary].filter(Boolean).join(' '));

      // Reset form
      setPostContent('');
      setIgCaption('');
      setLinkUrl('');
      setScheduledFor('');
      setPublishNow(false);
      setSelectedPageIds([]);
      setMediaType('text');
      setMediaUrl('');
      setMediaInputMode('file');
      setSelectedFile(null);
      setUploadedUrl(null);
      if (mediaFileInputRef.current) {
        mediaFileInputRef.current.value = '';
      }
      onPostCreated(approvalPages.length > 0 && directPages.length === 0 ? 'approvals' : 'scheduled');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setSubmitting(false);
    }
  };

  // Find the page by location_number first, then fall back to location_name
  const resolvePage = (row: CSVRow): FacebookPage | undefined => {
    let page: FacebookPage | undefined;
    if (row.location_number && row.location_number.trim()) {
      page = pages.find(p =>
        p.location_number && p.location_number.toLowerCase() === row.location_number.toLowerCase()
      );
    }
    if (!page && row.location_name && row.location_name.trim()) {
      page = pages.find(p => p.location_name.toLowerCase() === row.location_name.toLowerCase());
    }
    return page;
  };

  const bulkApprovalCount = csvData.filter(r => {
    const p = resolvePage(r);
    return !!p?.client_id && approvalClientIds.has(p.client_id);
  }).length;

  // Row ↔ file mapping (media_file column), recomputed as rows/files change
  const mediaMapping = useMemo(() => mapRowsToFiles(csvData, mediaFiles), [csvData, mediaFiles]);

  // Files that an Instagram row uses → prepare them for Instagram (JPEG derivative / video checks)
  const igNeeded = useMemo(() => {
    const need = new Map<File, 'photo' | 'video'>();
    csvData.forEach((row, i) => {
      const pp = parsePlatformsCell(row.platforms);
      const ms = mediaMapping.rows[i];
      if (pp.ok && pp.platforms.includes('instagram') && ms?.state === 'file') need.set(mediaFiles[ms.fileIndex], ms.kind);
    });
    return need;
  }, [csvData, mediaMapping, mediaFiles]);

  useEffect(() => {
    // two at a time: large photos are decoded and re-encoded in the browser
    for (const [file, kind] of Array.from(igNeeded.entries())) {
      if (igInFlight.current.size >= 2) break;
      if (igMedia.has(file) || igInFlight.current.has(file)) continue;
      igInFlight.current.add(file);
      analyzeInstagramMedia(file, kind).then((info) => {
        igInFlight.current.delete(file);
        if (!mediaFilesRef.current.includes(file)) { releaseIgMedia(info); return; } // removed meanwhile
        setIgMedia((prev) => new Map(prev).set(file, info));
      });
    }
  }, [igNeeded, igMedia]);

  // Forget analyses (and their object URLs) for files that were removed
  useEffect(() => {
    setIgMedia((prev) => {
      const stale = Array.from(prev.keys()).filter((f) => !mediaFiles.includes(f));
      if (stale.length === 0) return prev;
      const next = new Map(prev);
      stale.forEach((f) => { releaseIgMedia(next.get(f)); next.delete(f); });
      return next;
    });
  }, [mediaFiles]);

  // Per-row checks: media mapping + platforms + Instagram rules. Errors block the upload.
  const rowPlans: RowPlan[] = csvData.map((row, i) => {
    const page = resolvePage(row);
    const ms = mediaMapping.rows[i];
    const pp = parsePlatformsCell(row.platforms);
    const platforms = pp.ok ? pp.platforms : [];
    const errors: string[] = [];
    const warnings: string[] = [];
    if (!pp.ok) errors.push(pp.message);
    if (ms?.state === 'error') errors.push(ms.message);
    const igCaption = replacePlaceholders(row.ig_caption || row.post_content, pageValues(page));
    let pending = false;
    if (platforms.includes('instagram')) {
      const media: IgTargetMedia = ms?.state === 'file'
        ? { source: 'file', kind: ms.kind, prepared: preparedIssues(igMedia.get(mediaFiles[ms.fileIndex])) }
        : ms?.state === 'url' ? { source: 'url', kind: ms.kind, url: row.media_url.trim() } : { source: 'none' };
      const r = evaluateInstagramTarget({
        caption: igCaption, pageFound: !!page, hasIgAccount: !!page?.ig_user_id, media,
        direct: !!page && !needsApproval(page), instagramEnabled: igEnabled, hasSchedule: !!parseScheduledDate(row.scheduled_for),
      });
      errors.push(...r.errors.map((e) => `Instagram: ${e}`));
      warnings.push(...r.warnings.map((w) => `Instagram: ${w}`));
      pending = r.pending;
    }
    return { page, platforms, errors, warnings, pending, igCaption };
  });
  const errorRows = rowPlans.map((p, i) => (p.errors.length ? i : -1)).filter((i) => i >= 0);
  const igPreparing = rowPlans.some((p) => p.pending);
  const bulkIgCount = rowPlans.filter((p) => p.platforms.includes('instagram')).length;

  const removeErroredRows = () => {
    const bad = new Set(errorRows);
    setCsvData((rows) => rows.filter((_, i) => !bad.has(i)));
  };

  /** Instagram preview media for a row: the cropped JPEG derivative, the video file, or the CSV link */
  const igPreviewFor = (index: number, row: CSVRow): { url: string | null; ratio: number | null; note: string | null } => {
    const ms = mediaMapping.rows[index];
    if (ms?.state === 'url') return { url: row.media_url.trim(), ratio: null, note: null };
    if (ms?.state !== 'file') return { url: null, ratio: null, note: null };
    const info = igMedia.get(mediaFiles[ms.fileIndex]);
    if (info?.state === 'photo') return { url: info.url, ratio: info.plan.ratio, note: info.plan.note || null };
    if (info?.state === 'video') return { url: mediaObjectUrls[ms.fileIndex] || null, ratio: info.width && info.height ? info.width / info.height : null, note: null };
    return { url: ms.kind === 'video' ? mediaObjectUrls[ms.fileIndex] || null : null, ratio: null, note: info ? null : 'Preparing Instagram version…' };
  };

  const clearBulk = () => {
    setCsvData([]);
    setMediaFiles([]);
    setCsvError(null);
    setBulkNotice(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleBulkSubmit = async () => {
    setError(null);
    setSuccess(null);
    setSubmitting(true);

    try {
      if (csvData.length === 0) {
        throw new Error('No CSV data to upload');
      }
      const statuses = mediaMapping.rows;
      if (rowPlans.some((p) => p.errors.length > 0)) {
        throw new Error('Fix or remove the rows with problems first');
      }
      if (igPreparing) throw new Error('Still preparing Instagram media; try again in a moment');

      // Upload each referenced file once (rows for unknown pages are skipped), straight to storage.
      // Originals serve Facebook posts and Instagram videos; Instagram photos use their JPEG derivative.
      const originalFiles = new Set<number>();
      const igPhotoFiles = new Set<number>();
      csvData.forEach((_, i) => {
        const s = statuses[i];
        const plan = rowPlans[i];
        if (s.state !== 'file' || !plan.page) return;
        if (plan.platforms.includes('facebook') || (plan.platforms.includes('instagram') && s.kind === 'video')) originalFiles.add(s.fileIndex);
        if (plan.platforms.includes('instagram') && s.kind === 'photo') igPhotoFiles.add(s.fileIndex);
      });
      const uploads: { key: string; file: File }[] = [
        ...Array.from(originalFiles).map((i) => ({ key: `orig:${i}`, file: mediaFiles[i] })),
        ...Array.from(igPhotoFiles).map((i) => {
          const info = igMedia.get(mediaFiles[i]);
          if (info?.state !== 'photo') throw new Error(`Instagram version of ${mediaFiles[i].name} is not ready`);
          return { key: `ig:${i}`, file: info.file };
        }),
      ];
      const refByKey = new Map<string, string>();
      if (uploads.length > 0) {
        const purpose = csvData.some((row) => needsApproval(resolvePage(row))) ? 'draft' : 'direct';
        const refs = await uploadMediaFiles(
          uploads.map((u) => u.file), purpose,
          (done, total) => setUploadProgress(`Uploading media ${done}/${total}…`),
        );
        uploads.forEach((u, k) => refByKey.set(u.key, refs[k]));
      }
      setUploadProgress(null);

      const mediaFor = (index: number, row: CSVRow, platform: Platform): { media_type: string | null; media_url: string | null } => {
        const s = statuses[index];
        if (s.state === 'file') {
          const key = platform === 'instagram' && s.kind === 'photo' ? `ig:${s.fileIndex}` : `orig:${s.fileIndex}`;
          return { media_type: s.kind, media_url: refByKey.get(key) || null };
        }
        if (s.state === 'url') return { media_type: s.kind, media_url: row.media_url.trim() };
        return { media_type: null, media_url: null };
      };

      let successCount = 0;
      let failedRows: string[] = [];
      const draftRows: DraftPayload[] = [];

      for (const [index, row] of Array.from(csvData.entries())) {
        const { page, platforms } = rowPlans[index];

        if (!page) {
          failedRows.push(`${row.location_number || row.location_name} (page not found)`);
          continue;
        }
        // One CSV row for fb,ig → two posts sharing a post_group_id
        const groupId = newGroupId(platforms);

        for (const platform of platforms) {
          const media = mediaFor(index, row, platform);
          const content = platform === 'instagram' ? (row.ig_caption || row.post_content) : row.post_content;
          const link = platform === 'facebook' && !media.media_type ? (row.link_url || null) : null;

          // Approval-workflow clients: queue as drafts for internal → client review
          if (needsApproval(page)) {
            draftRows.push({
              page_id: page.id,
              post_content: content,
              link_url: link,
              scheduled_for: parseScheduledDate(row.scheduled_for),
              media_type: media.media_type,
              media_url: media.media_url,
              platform,
              post_group_id: groupId,
            });
            continue;
          }

          const payload = {
            facebook_page_id: page.facebook_page_id,
            franchise_name: page.location_name,
            location_number: page.location_number || null,
            post_content: content,
            link_url: link,
            scheduled_for: parseScheduledDate(row.scheduled_for),
            publish_now: false,
            media_type: media.media_type,
            media_url: media.media_url,
            platform,
            post_group_id: groupId,
            // Placeholder values
            city: page.city || null,
            base_url: page.base_url || null,
            phone: page.phone || null,
          };

          const response = await fetch('/api/posts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          });

          if (response.ok) {
            successCount++;
          } else {
            const data = await response.json().catch(() => ({}));
            failedRows.push(`${row.location_name || row.location_number}${platform === 'instagram' ? ' (Instagram)' : ''} (${data.error || 'API error'})`);
          }
        }
      }

      let draftSummary = '';
      let draftsOk = false;
      if (draftRows.length > 0) {
        const drafts = await submitDrafts(draftRows);
        draftsOk = drafts.ok;
        if (drafts.ok) draftSummary = drafts.summary;
        else failedRows.push(`${draftRows.length} approval draft(s): ${drafts.summary}`);
      }

      if (failedRows.length > 0) {
        setError(`Failed rows: ${failedRows.join(', ')}`);
      }

      if (successCount > 0 || draftsOk) {
        setSuccess([successCount > 0 ? `Successfully created ${successCount} post(s)!` : '', draftSummary].filter(Boolean).join(' '));
        clearBulk();
        onPostCreated(draftsOk && successCount === 0 ? 'approvals' : 'scheduled');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setUploadProgress(null);
      setSubmitting(false);
    }
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    // reset so picking the same file again still fires onChange
    e.target.value = '';
    handleBulkFiles(files);
  };

  const parseCSV = (text: string): CSVRow[] => {
    // Parse CSV properly handling multiline quoted fields
    const records: string[][] = [];
    let currentRecord: string[] = [];
    let currentField = '';
    let inQuotes = false;

    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      const nextChar = text[i + 1];

      if (inQuotes) {
        if (char === '"') {
          if (nextChar === '"') {
            // Escaped quote
            currentField += '"';
            i++;
          } else {
            // End of quoted field
            inQuotes = false;
          }
        } else {
          currentField += char;
        }
      } else {
        if (char === '"') {
          inQuotes = true;
        } else if (char === ',') {
          currentRecord.push(currentField.trim());
          currentField = '';
        } else if (char === '\n' || (char === '\r' && nextChar === '\n')) {
          if (char === '\r') i++; // Skip \n in \r\n
          currentRecord.push(currentField.trim());
          if (currentRecord.some(f => f)) { // Only add non-empty records
            records.push(currentRecord);
          }
          currentRecord = [];
          currentField = '';
        } else if (char !== '\r') {
          currentField += char;
        }
      }
    }

    // Don't forget the last field/record
    if (currentField || currentRecord.length > 0) {
      currentRecord.push(currentField.trim());
      if (currentRecord.some(f => f)) {
        records.push(currentRecord);
      }
    }

    console.log('Parsed records count:', records.length);
    console.log('Headers:', records[0]);
    if (records.length > 1) {
      console.log('First data row field count:', records[1].length);
      console.log('First data row fields:', records[1].map((f, i) => `[${i}]: ${f.substring(0, 50)}...`));
    }

    if (records.length < 2) {
      throw new Error('CSV must have a header row and at least one data row');
    }

    const headers = records[0].map(h => h.toLowerCase().replace(/"/g, ''));
    console.log('Normalized headers:', headers);

    // Validate required headers - need either location_name or location_number, plus post_content
    const hasLocationIdentifier = headers.includes('location_name') || headers.includes('location_number');
    if (!hasLocationIdentifier) {
      throw new Error('Missing required column: location_name or location_number');
    }
    if (!headers.includes('post_content')) {
      throw new Error('Missing required column: post_content');
    }

    const rows: CSVRow[] = [];
    for (let i = 1; i < records.length; i++) {
      const values = records[i];

      if (values.length !== headers.length) {
        console.warn(`Skipping row ${i + 1}: column count mismatch (got ${values.length}, expected ${headers.length})`);
        console.warn('Row values:', values);
        continue;
      }

      const row: Record<string, string> = {};
      headers.forEach((header, index) => {
        row[header] = values[index];
      });

      // Need either location_name or location_number, plus post_content
      if ((!row.location_name && !row.location_number) || !row.post_content) {
        console.warn(`Skipping row ${i + 1}: missing required fields`, {
          location_name: row.location_name,
          location_number: row.location_number,
          has_post_content: !!row.post_content
        });
        continue;
      }

      rows.push({
        location_name: row.location_name || '',
        location_number: row.location_number || '',
        post_content: row.post_content,
        link_url: row.link_url || '',
        scheduled_for: row.scheduled_for || '',
        media_type: row.media_type || '',
        media_file: row.media_file || '',
        media_url: row.media_url || '',
        platforms: row.platforms || '',
        ig_caption: row.ig_caption || '',
      });
    }

    console.log('Final valid rows:', rows.length);
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
    // 'notes' is for people reading the file; the importer ignores columns it doesn't know.
    const headers = ['location_number', 'location_name', 'platforms', 'post_content', 'ig_caption', 'link_url', 'scheduled_for', 'media_type', 'media_file', 'media_url', 'notes'];
    // One franchise example (matched on location_number) and non-franchise examples (blank
    // location_number, matched on the exact page name). Dates are 95+ days out so a test upload
    // can be reviewed and deleted long before it's due.
    const daysOut = (days: number, hour: number) => {
      const d = new Date();
      d.setDate(d.getDate() + days);
      d.setHours(hour, 0, 0, 0);
      const h = d.getHours();
      return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()} ${h % 12 || 12}:00 ${h >= 12 ? 'PM' : 'AM'}`;
    };
    // Example pages are deliberately fake: uploading the template unchanged reports "page not found"
    // for every row and never creates posts on a real client page. Replace with real pages.
    const EXAMPLE_NOTE = 'EXAMPLE ROW: replace the page with a real one from the Pages tab (or delete this row).';
    const exampleRows = [
      ['0001', 'Example Franchise Location A', 'fb', 'Text + link post for {{CITY}}. Call us at {{PHONE}}.', '', '{{BASEURL}}', daysOut(95, 9), '', '', '',
        `FRANCHISE LOCATION, text + link: location_number is matched first (name is a fallback). {{CITY}}/{{PHONE}}/{{BASEURL}} fill in from the page. platforms fb (or blank) = Facebook only. ${EXAMPLE_NOTE}`],
      ['0002', 'Example Franchise Location B', 'fb', 'Photo post for {{CITY}}.', '', '', daysOut(95, 11), 'photo', 'example-photo.jpg', '',
        `FRANCHISE LOCATION, photo: media_file = the name of an image you upload together with this CSV (JPG/PNG/GIF/WEBP, max 10 MB). Several rows can use the same file. media_type can be left blank (detected from the file). link_url is ignored for photos. ${EXAMPLE_NOTE}`],
      ['0003', 'Example Franchise Location C', 'fb', 'Video post for {{CITY}}.', '', '', daysOut(96, 9), 'video', 'example-video.mp4', '',
        `FRANCHISE LOCATION, video: media_file = the name of a video you upload with this CSV (MP4/MOV, max 100 MB). Instead of a file you can put a public https link in media_url and leave media_file blank. ${EXAMPLE_NOTE}`],
      ['', 'Example Brand Page', 'fb', 'Text-only post for a non-franchise page.', '', '', daysOut(96, 11), '', '', '',
        `NON-FRANCHISE PAGE (e.g. IANA): leave location_number blank and put the page name exactly as on the Pages tab. Text only = leave link_url/media blank. Skip {{CITY}}/{{PHONE}}/{{BASEURL}} unless set for the page. ${EXAMPLE_NOTE}`],
      ['0004', 'Example Franchise Location D', 'fb,ig', 'Photo post for {{CITY}} on Facebook. Learn more at {{BASEURL}}', 'Photo post for {{CITY}} on Instagram. Link in bio! #homecare #{{CITY}}', '', daysOut(97, 9), 'photo', 'example-photo.jpg', '',
        `FACEBOOK + INSTAGRAM: platforms fb,ig makes two linked posts (Facebook and Instagram, reviewed side by side); ig = Instagram only. Instagram needs a photo or video and an Instagram account ID on the page (Pages tab). ig_caption is optional (blank = post_content); max 2,200 characters and 30 hashtags (5 or fewer recommended); links are not clickable on Instagram. Photos are converted to JPEG and center-cropped to 4:5-1.91:1 for Instagram (the Facebook post keeps the original); videos must be MP4/MOV, 3 s to 15 min, ideally 9:16. ${EXAMPLE_NOTE}`],
    ];

    const csv = [
      headers.join(','),
      ...exampleRows.map(row => row.map(v => `"${v}"`).join(',')),
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

  // Format ISO date to mm/dd/yyyy for display
  const formatDateForDisplay = (dateStr: string): string => {
    if (!dateStr) return 'Draft';

    const parsed = parseScheduledDate(dateStr);
    if (!parsed) return dateStr;

    const date = new Date(parsed);
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const year = date.getFullYear();
    const hours = date.getHours();
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const ampm = hours >= 12 ? 'PM' : 'AM';
    const displayHour = hours % 12 || 12;

    return `${month}/${day}/${year} ${displayHour}:${minutes} ${ampm}`;
  };

  // Get minimum datetime (now)
  const getMinDateTime = () => {
    const now = new Date();
    now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
    return now.toISOString().slice(0, 16);
  };

  const pageOptions = pages.map(p => ({
    id: p.id,
    label: p.location_number ? `${p.location_number} - ${p.location_name}` : p.location_name,
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

              {/* Platforms */}
              <fieldset>
                <legend className="block text-sm font-medium text-gray-700 mb-2">Post to</legend>
                <div className="flex flex-wrap gap-6">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input type="checkbox" checked={wantFb} onChange={(e) => setWantFb(e.target.checked)} className="w-4 h-4" disabled={submitting} />
                    <span className="text-sm text-gray-700">Facebook</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input type="checkbox" checked={wantIg} onChange={(e) => setWantIg(e.target.checked)} className="w-4 h-4" disabled={submitting} />
                    <span className="text-sm text-gray-700">Instagram</span>
                  </label>
                </div>
                {wantIg && (
                  <p className="mt-1 text-xs text-gray-500">
                    Instagram needs a photo or video and an Instagram account on each page (Pages tab). Photos are converted to JPEG and
                    cropped to 4:5–1.91:1 for Instagram; Facebook keeps the original.
                    {!igEnabled && ' Instagram publishing is not enabled yet: Instagram posts can be drafted for client approval but are not scheduled.'}
                  </p>
                )}
                {!wantFb && !wantIg && <p className="mt-1 text-sm text-red-600">Choose at least one.</p>}
              </fieldset>

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
                  placeholder="Write your post content here... Use placeholders like {{CITY}} or {{FRANCHISENAME}} for dynamic content."
                  disabled={submitting}
                />
                <div className="mt-1 flex items-center justify-between">
                  <p className="text-sm text-gray-500">
                    {postContent.length} / 63,206 characters
                  </p>
                  <details className="text-sm">
                    <summary className="text-blue-600 cursor-pointer hover:text-blue-800">
                      Available placeholders
                    </summary>
                    <div className="absolute mt-1 bg-white border border-gray-200 rounded-lg shadow-lg p-3 z-10 text-gray-600">
                      <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                        <code className="bg-gray-100 px-1 rounded">{'{{CITY}}'}</code>
                        <span>City name</span>
                        <code className="bg-gray-100 px-1 rounded">{'{{FRANCHISENAME}}'}</code>
                        <span>Franchise name</span>
                        <code className="bg-gray-100 px-1 rounded">{'{{LOCATION}}'}</code>
                        <span>Location number</span>
                        <code className="bg-gray-100 px-1 rounded">{'{{BASEURL}}'}</code>
                        <span>Website URL</span>
                        <code className="bg-gray-100 px-1 rounded">{'{{PHONE}}'}</code>
                        <span>Phone number</span>
                      </div>
                    </div>
                  </details>
                </div>
              </div>

              {wantIg && (
                <div>
                  <label htmlFor="igCaption" className="block text-sm font-medium text-gray-700 mb-2">
                    Instagram caption (optional; blank uses the post content)
                  </label>
                  <textarea
                    id="igCaption"
                    value={igCaption}
                    onChange={(e) => setIgCaption(e.target.value)}
                    rows={4}
                    aria-describedby="igCaptionMeter"
                    className="w-full border border-gray-300 rounded-lg px-4 py-2 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 resize-none"
                    placeholder="Instagram version of the text. Links aren't clickable on Instagram."
                    disabled={submitting}
                  />
                  <IgCaptionMeter id="igCaptionMeter" caption={replacePlaceholders(igCaption.trim() || postContent, pageValues(selectedPages[0]))} />
                </div>
              )}

              {/* Media Type Selector */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Post Type
                </label>
                <div className="flex gap-4">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="radio"
                      name="mediaType"
                      checked={mediaType === 'text'}
                      onChange={() => { setMediaType('text'); clearMediaSelection(); }}
                      className="w-4 h-4 text-blue-600"
                      disabled={submitting}
                    />
                    <span className="text-sm text-gray-700">Text/Link</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="radio"
                      name="mediaType"
                      checked={mediaType === 'photo'}
                      onChange={() => { setMediaType('photo'); setLinkUrl(''); clearMediaSelection(); }}
                      className="w-4 h-4 text-blue-600"
                      disabled={submitting}
                    />
                    <span className="text-sm text-gray-700">Photo</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="radio"
                      name="mediaType"
                      checked={mediaType === 'video'}
                      onChange={() => { setMediaType('video'); setLinkUrl(''); clearMediaSelection(); }}
                      className="w-4 h-4 text-blue-600"
                      disabled={submitting}
                    />
                    <span className="text-sm text-gray-700">Video</span>
                  </label>
                </div>
              </div>

              {/* Link URL - only shown for text posts */}
              {mediaType === 'text' && (
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
              )}

              {/* Media Input - shown for photo/video posts */}
              {mediaType !== 'text' && (
                <div className="space-y-4">
                  {/* Input Mode Toggle */}
                  <div className="flex gap-4 border-b pb-3">
                    <button
                      type="button"
                      onClick={() => { setMediaInputMode('file'); clearMediaSelection(); }}
                      className={`text-sm font-medium pb-1 border-b-2 ${
                        mediaInputMode === 'file'
                          ? 'border-blue-500 text-blue-600'
                          : 'border-transparent text-gray-500 hover:text-gray-700'
                      }`}
                    >
                      Upload File
                    </button>
                    <button
                      type="button"
                      onClick={() => { setMediaInputMode('url'); clearMediaSelection(); }}
                      className={`text-sm font-medium pb-1 border-b-2 ${
                        mediaInputMode === 'url'
                          ? 'border-blue-500 text-blue-600'
                          : 'border-transparent text-gray-500 hover:text-gray-700'
                      }`}
                    >
                      Enter URL
                    </button>
                  </div>

                  {/* File Upload Mode */}
                  {mediaInputMode === 'file' && (
                    <div>
                      {!selectedFile ? (
                        <div className="border-2 border-dashed border-gray-300 rounded-lg p-6 text-center hover:border-gray-400 transition-colors">
                          <input
                            ref={mediaFileInputRef}
                            type="file"
                            accept={mediaType === 'photo' ? 'image/jpeg,image/png,image/gif,image/webp' : 'video/mp4,video/quicktime,.mov'}
                            onChange={handleMediaFileSelect}
                            className="hidden"
                            id="media-upload"
                            disabled={submitting || uploading}
                          />
                          <label htmlFor="media-upload" className="cursor-pointer">
                            <svg className="mx-auto h-12 w-12 text-gray-400 mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              {mediaType === 'photo' ? (
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                              ) : (
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                              )}
                            </svg>
                            <p className="text-sm text-gray-600">
                              <span className="text-blue-600 font-medium">Click to upload</span> or drag and drop
                            </p>
                            <p className="text-xs text-gray-500 mt-1">
                              {mediaType === 'photo' ? 'JPG, PNG, GIF, WEBP up to 10MB' : 'MP4, MOV up to 100MB'}
                            </p>
                          </label>
                        </div>
                      ) : (
                        <div className="border border-gray-200 rounded-lg p-4">
                          <div className="flex items-start gap-4">
                            {/* Preview */}
                            {previewUrl && mediaType === 'photo' && (
                              <img
                                src={previewUrl}
                                alt="Preview"
                                className="w-24 h-24 object-cover rounded-lg"
                              />
                            )}
                            {previewUrl && mediaType === 'video' && (
                              <video src={previewUrl} muted preload="metadata" className="w-24 h-24 object-cover rounded-lg bg-black" />
                            )}
                            {/* File info */}
                            <div className="flex-1 min-w-0">
                              <p className="text-sm font-medium text-gray-900 truncate">{selectedFile.name}</p>
                              <p className="text-sm text-gray-500">
                                {(selectedFile.size / (1024 * 1024)).toFixed(2)} MB
                              </p>
                              {uploadedUrl && (
                                <p className="text-sm text-green-600 mt-1 flex items-center gap-1">
                                  <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                                    <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                                  </svg>
                                  Uploaded
                                </p>
                              )}
                              {uploading && (
                                <p className="text-sm text-blue-600 mt-1 flex items-center gap-1">
                                  <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24">
                                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                                  </svg>
                                  Uploading...
                                </p>
                              )}
                            </div>
                            {/* Remove button */}
                            <button
                              type="button"
                              onClick={clearMediaSelection}
                              className="text-gray-400 hover:text-gray-600"
                              disabled={uploading}
                            >
                              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                              </svg>
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  {/* URL Input Mode */}
                  {mediaInputMode === 'url' && (
                    <div>
                      <label htmlFor="mediaUrl" className="block text-sm font-medium text-gray-700 mb-2">
                        {mediaType === 'photo' ? 'Photo URL' : 'Video URL'}
                      </label>
                      <input
                        type="url"
                        id="mediaUrl"
                        value={mediaUrl}
                        onChange={(e) => setMediaUrl(e.target.value)}
                        className="w-full border border-gray-300 rounded-lg px-4 py-2 focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                        placeholder={mediaType === 'photo' ? 'https://example.com/image.jpg' : 'https://example.com/video.mp4'}
                        disabled={submitting}
                      />
                      <p className="mt-1 text-sm text-gray-500">
                        {mediaType === 'photo'
                          ? 'Enter a publicly accessible URL to your image (JPG, PNG, GIF)'
                          : 'Enter a publicly accessible URL to your video (MP4 recommended)'}
                      </p>
                    </div>
                  )}
                </div>
              )}

              {/* In-platform preview (first selected page, placeholders filled) */}
              {postContent.trim() && singlePlatforms.length > 0 && (
                <div className="border-t pt-6">
                  <h3 className="text-sm font-medium text-gray-700 mb-3">
                    Preview{selectedPages.length > 1 ? ` (showing ${selectedPages[0].location_name} of ${selectedPages.length} pages)` : ''}
                  </h3>
                  <div className={`bg-[#f0f2f5] rounded-lg p-4 grid gap-4 ${singlePlatforms.length > 1 ? 'lg:grid-cols-2' : ''}`}>
                    {(() => {
                      const pg = selectedPages[0];
                      const vals = pageValues(pg);
                      const igMediaPreview = mediaType === 'text' ? null
                        : mediaInputMode === 'url' ? mediaUrl
                        : singleIg?.state === 'photo' ? singleIg.url : mediaType === 'video' ? previewUrl : null;
                      return (
                        <>
                          {wantFb && (
                            <div className="space-y-1">
                              <PlatformBadge platform="facebook" />
                              <FacebookPostPreview
                                pageName={pg?.location_name || 'Your Page'}
                                facebookPageId={pg?.facebook_page_id}
                                content={replacePlaceholders(postContent, vals)}
                                linkUrl={mediaType === 'text' ? replacePlaceholders(linkUrl, vals) || null : null}
                                mediaType={mediaType !== 'text' ? mediaType : null}
                                mediaUrl={mediaType === 'text' ? null : (mediaInputMode === 'url' ? mediaUrl : previewUrl)}
                                scheduledFor={!publishNow && scheduledFor ? new Date(scheduledFor).toISOString() : null}
                              />
                            </div>
                          )}
                          {wantIg && (
                            <div className="space-y-1">
                              <PlatformBadge platform="instagram" />
                              <InstagramPostPreview
                                username={pg?.ig_username || pg?.location_name || 'yourpage'}
                                facebookPageId={pg?.facebook_page_id}
                                caption={replacePlaceholders(igCaption.trim() || postContent, vals)}
                                mediaType={mediaType !== 'text' ? mediaType : null}
                                mediaUrl={igMediaPreview}
                                aspectRatio={singleIg?.state === 'photo' ? singleIg.plan.ratio : singleIg?.state === 'video' && singleIg.height ? singleIg.width / singleIg.height : null}
                                note={singleIg?.state === 'loading' ? 'Preparing Instagram version…' : singleIg?.state === 'photo' ? singleIg.plan.note || null : null}
                              />
                            </div>
                          )}
                        </>
                      );
                    })()}
                  </div>
                </div>
              )}

              {wantIg && selectedPages.length > 0 && (singleIgCheck.errors.length > 0 || singleIgCheck.warnings.length > 0) && (
                <div className="rounded-lg border px-4 py-3 text-sm space-y-1" role="status">
                  {singleIgCheck.errors.map((e) => <p key={e} className="text-red-700">Instagram: {e}</p>)}
                  {singleIgCheck.warnings.map((w) => <p key={w} className="text-amber-700">Instagram: {w}</p>)}
                </div>
              )}

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

              {singleHasApprovalPages && (
                <div className="bg-blue-50 border border-blue-100 rounded-lg px-4 py-3 text-sm text-blue-900">
                  <span>
                    <strong>Client approval workflow</strong>:{' '}
                    {selectedPages.filter(p => p.client_id && approvalClientIds.has(p.client_id)).length} selected page(s) belong to clients that require review.
                    They&apos;ll be saved as drafts for internal review instead of {publishNow ? 'publishing' : 'scheduling'}.
                  </span>
                </div>
              )}

              {/* Submit Button */}
              <div className="flex justify-end gap-3">
                <button
                  type="submit"
                  disabled={
                    submitting ||
                    uploading ||
                    singlePlatforms.length === 0 ||
                    singleIgBlocked ||
                    selectedPageIds.length === 0 ||
                    !postContent.trim() ||
                    (mediaType !== 'text' && mediaInputMode === 'file' && !selectedFile) ||
                    (mediaType !== 'text' && mediaInputMode === 'url' && !mediaUrl.trim())
                  }
                  className={`px-6 py-2 rounded-lg font-medium text-white ${
                    submitting ||
                    uploading ||
                    singlePlatforms.length === 0 ||
                    singleIgBlocked ||
                    selectedPageIds.length === 0 ||
                    !postContent.trim() ||
                    (mediaType !== 'text' && mediaInputMode === 'file' && !selectedFile) ||
                    (mediaType !== 'text' && mediaInputMode === 'url' && !mediaUrl.trim())
                      ? 'bg-gray-400 cursor-not-allowed'
                      : publishNow
                        ? 'bg-green-600 hover:bg-green-700'
                        : 'bg-blue-600 hover:bg-blue-700'
                  }`}
                >
                  {submitting || uploading ? (
                    <span className="flex items-center gap-2">
                      <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                      </svg>
                      {uploading ? 'Uploading...' : publishNow ? 'Publishing...' : 'Saving...'}
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
                  Upload CSV + Media Files
                </label>
                <div
                  onDragOver={handleDragOver}
                  onDragLeave={handleDragLeave}
                  onDrop={handleDrop}
                  className={`border-2 border-dashed rounded-lg p-6 text-center transition-colors ${
                    isDraggingCSV
                      ? 'border-blue-500 bg-blue-50'
                      : 'border-gray-300 hover:border-gray-400'
                  }`}
                >
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept={`.csv,text/csv,${ACCEPT_MEDIA},.jpg,.jpeg,.png,.gif,.webp,.mp4,.mov`}
                    multiple
                    onChange={handleFileUpload}
                    className="hidden"
                    id="csv-upload"
                  />
                  <label htmlFor="csv-upload" className="cursor-pointer">
                    <svg className={`mx-auto h-12 w-12 mb-3 ${isDraggingCSV ? 'text-blue-500' : 'text-gray-400'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                    </svg>
                    <p className="text-sm text-gray-600">
                      {isDraggingCSV ? (
                        <span className="text-blue-600 font-medium">Drop your CSV and media files here</span>
                      ) : (
                        <>
                          <span className="text-blue-600 font-medium">Click to upload</span> or drag and drop
                        </>
                      )}
                    </p>
                    <p className="text-xs text-gray-500 mt-1">
                      Select the CSV and all its images/videos together (or add files in several drops). {MEDIA_HELP}
                    </p>
                  </label>
                </div>
                {csvError && (
                  <p className="mt-2 text-sm text-red-600">{csvError}</p>
                )}
                {bulkNotice && (
                  <p className="mt-2 text-sm text-amber-700">{bulkNotice}</p>
                )}
                {(csvData.length > 0 || mediaFiles.length > 0) && (
                  <div className="mt-2 flex items-center justify-between text-sm text-gray-600">
                    <span>
                      {csvData.length > 0 ? `${csvData.length} row(s) from CSV` : 'No CSV yet'} · {mediaFiles.length} media file(s)
                    </span>
                    <button type="button" onClick={clearBulk} className="text-gray-500 hover:text-gray-700 underline" disabled={submitting}>
                      Clear all
                    </button>
                  </div>
                )}
                {mediaMapping.unreferenced.length > 0 && (
                  <div className="mt-2 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-sm text-amber-900">
                    <p className="font-medium">
                      {mediaMapping.unreferenced.length} file(s) not used by any row{csvData.length > 0 ? ' (check the media_file column)' : ''}:
                    </p>
                    <ul className="mt-1 flex flex-wrap gap-2">
                      {mediaMapping.unreferenced.map((i) => (
                        <li key={`${mediaFiles[i].name}-${i}`} className="inline-flex items-center gap-1 bg-white border border-amber-200 rounded px-2 py-0.5">
                          {mediaFiles[i].name}
                          <button type="button" onClick={() => removeMediaFile(i)} className="text-amber-700 hover:text-amber-900" aria-label={`Remove ${mediaFiles[i].name}`}>
                            ×
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>

              {/* CSV Preview */}
              {csvData.length > 0 && (
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <h3 className="text-sm font-medium text-gray-700">
                      Preview ({csvData.length} posts)
                    </h3>
                    <button type="button" onClick={() => setShowBulkPreviews(!showBulkPreviews)}
                      className="text-sm text-blue-600 hover:text-blue-800">
                      {showBulkPreviews ? 'Show table' : 'Show previews'}
                    </button>
                  </div>
                  {bulkIgCount > 0 && (
                    <div className="bg-pink-50 border border-pink-100 rounded-lg px-4 py-3 mb-3 text-sm text-pink-900">
                      <strong>Instagram</strong>: {bulkIgCount} row(s) include Instagram. Photos are converted to JPEG and center-cropped to
                      4:5–1.91:1 for Instagram (shown in the previews); Facebook keeps the original file.
                      {!igEnabled && ' Instagram publishing is not enabled yet, so Instagram posts are drafted for client approval but not scheduled.'}
                      {igPreparing && ' Preparing Instagram media…'}
                    </div>
                  )}
                  {bulkApprovalCount > 0 && (
                    <div className="bg-blue-50 border border-blue-100 rounded-lg px-4 py-3 mb-3 text-sm text-blue-900">
                      <span>
                        <strong>Client approval workflow</strong>: {bulkApprovalCount} of {csvData.length} row(s) are for clients that require review.
                        They&apos;ll be grouped into one review batch per client and the internal team member on each client will be alerted.
                      </span>
                    </div>
                  )}
                  {showBulkPreviews && (
                    <div className="bg-[#f0f2f5] rounded-lg p-4 grid gap-4 max-h-[720px] overflow-auto" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(360px, 1fr))' }}>
                      {csvData.map((row, index) => {
                        const plan = rowPlans[index];
                        const pg = plan.page;
                        const vals = pageValues(pg);
                        const ms = mediaMapping.rows[index];
                        const kind = ms && (ms.state === 'file' || ms.state === 'url') ? ms.kind : null;
                        // Real local file (object URL) when mapped; the CSV media_url otherwise
                        const previewMedia = ms?.state === 'file' ? mediaObjectUrls[ms.fileIndex] || null : ms?.state === 'url' ? row.media_url.trim() : null;
                        const both = plan.platforms.length > 1;
                        const ig = plan.platforms.includes('instagram') ? igPreviewFor(index, row) : null;
                        return (
                          <div key={index} className={both ? 'space-y-1' : undefined} style={both ? { gridColumn: '1 / -1' } : undefined}
                            role={both ? 'group' : undefined} aria-label={both ? `Row ${index + 2}: Facebook and Instagram versions` : undefined}>
                            {!pg && <p className="text-xs text-red-600 mb-1">Row {index + 2}: page not found</p>}
                            {plan.errors.map((e) => <p key={e} className="text-xs text-red-600 mb-1">Row {index + 2}: {e}</p>)}
                            {plan.warnings.map((w) => <p key={w} className="text-xs text-amber-700 mb-1">Row {index + 2}: {w}</p>)}
                            <div className={both ? 'grid gap-4 md:grid-cols-2' : undefined}>
                              {plan.platforms.includes('facebook') && (
                                <FacebookPostPreview
                                  pageName={pg?.location_name || row.location_name || row.location_number}
                                  facebookPageId={pg?.facebook_page_id}
                                  content={replacePlaceholders(row.post_content, vals)}
                                  linkUrl={!kind ? replacePlaceholders(row.link_url, vals) || null : null}
                                  mediaType={kind}
                                  mediaUrl={previewMedia}
                                  scheduledFor={parseScheduledDate(row.scheduled_for)}
                                />
                              )}
                              {ig && (
                                <InstagramPostPreview
                                  username={pg?.ig_username || pg?.location_name || row.location_name || row.location_number}
                                  facebookPageId={pg?.facebook_page_id}
                                  caption={plan.igCaption}
                                  mediaType={kind}
                                  mediaUrl={ig.url}
                                  aspectRatio={ig.ratio}
                                  note={ig.note}
                                />
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                  {!showBulkPreviews && (
                  <div className="border rounded-lg overflow-hidden">
                    <div className="max-h-64 overflow-auto">
                      <table className="min-w-full divide-y divide-gray-200">
                        <thead className="bg-gray-50 sticky top-0">
                          <tr>
                            <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Location #</th>
                            <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Location Name</th>
                            <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Platforms</th>
                            <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Content</th>
                            <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Type</th>
                            <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Media</th>
                            <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Scheduled</th>
                          </tr>
                        </thead>
                        <tbody className="bg-white divide-y divide-gray-200">
                          {csvData.map((row, index) => {
                            const ms = mediaMapping.rows[index];
                            const file = ms && (ms.state === 'file' || ms.state === 'error') && ms.fileIndex !== undefined ? mediaFiles[ms.fileIndex] : undefined;
                            const thumb = ms && ms.state === 'file' ? mediaObjectUrls[ms.fileIndex] : undefined;
                            const plan = rowPlans[index];
                            return (
                            <tr key={index} className={plan.errors.length ? 'bg-red-50' : undefined}>
                              <td className="px-4 py-2 text-sm text-gray-900 whitespace-nowrap">
                                {row.location_number || '-'}
                              </td>
                              <td className="px-4 py-2 text-sm text-gray-900 whitespace-nowrap">
                                {row.location_name || '-'}
                              </td>
                              <td className="px-4 py-2 text-sm whitespace-nowrap">
                                <span className="inline-flex gap-1">
                                  {plan.platforms.map((p) => <PlatformBadge key={p} platform={p} />)}
                                  {plan.platforms.length === 0 && <span className="text-red-700">?</span>}
                                </span>
                              </td>
                              <td className="px-4 py-2 text-sm text-gray-600 max-w-xs">
                                <div className="truncate">{row.post_content}</div>
                                {plan.errors.map((e) => <div key={e} className="text-xs text-red-700 whitespace-normal">{e}</div>)}
                                {plan.warnings.map((w) => <div key={w} className="text-xs text-amber-700 whitespace-normal">{w}</div>)}
                                {plan.pending && <div className="text-xs text-gray-500">Preparing Instagram media…</div>}
                              </td>
                              <td className="px-4 py-2 text-sm text-gray-500 whitespace-nowrap">
                                {ms && ms.state !== 'error' ? mediaStatusLabel(ms) : (row.media_type || 'text')}
                              </td>
                              <td className="px-4 py-2 text-sm whitespace-nowrap">
                                {ms?.state === 'file' && file && (
                                  <span className="inline-flex items-center gap-2 text-gray-700">
                                    {thumb && ms.kind === 'photo' && <img src={thumb} alt="" className="w-10 h-10 object-cover rounded" />}
                                    {thumb && ms.kind === 'video' && <video src={thumb} muted preload="metadata" className="w-10 h-10 object-cover rounded bg-black" />}
                                    <span className="max-w-[12rem] truncate">{file.name}</span>
                                  </span>
                                )}
                                {ms?.state === 'url' && <span className="text-gray-500 max-w-[12rem] truncate inline-block align-middle">{row.media_url}</span>}
                                {ms?.state === 'none' && <span className="text-gray-400">-</span>}
                                {ms?.state === 'error' && <span className="text-red-700 font-medium">{mediaStatusLabel(ms)}</span>}
                              </td>
                              <td className="px-4 py-2 text-sm text-gray-500 whitespace-nowrap">
                                {formatDateForDisplay(row.scheduled_for)}
                              </td>
                            </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                  )}
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

              {errorRows.length > 0 && (
                <div className="bg-red-50 border border-red-200 text-red-800 px-4 py-3 rounded-lg text-sm flex items-center justify-between gap-4">
                  <span>
                    {errorRows.length} row(s) have problems (rows {errorRows.slice(0, 8).map((i) => i + 2).join(', ')}{errorRows.length > 8 ? '…' : ''}).
                    Add the missing files or fix the CSV, or leave those rows out.
                  </span>
                  <button type="button" onClick={removeErroredRows} disabled={submitting}
                    className="shrink-0 px-3 py-1.5 rounded-md bg-white border border-red-300 text-red-700 hover:bg-red-100">
                    Leave out {errorRows.length} row(s)
                  </button>
                </div>
              )}

              {/* Submit Button */}
              <div className="flex justify-end">
                <button
                  onClick={handleBulkSubmit}
                  disabled={submitting || csvData.length === 0 || errorRows.length > 0 || igPreparing}
                  title={igPreparing ? 'Preparing Instagram media…' : undefined}
                  className={`px-6 py-2 rounded-lg font-medium text-white ${
                    submitting || csvData.length === 0 || errorRows.length > 0 || igPreparing
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
                      {uploadProgress || 'Uploading...'}
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
                  <li>• <strong>location_number</strong> (optional): Location number to match - takes priority over location_name</li>
                  <li>• <strong>location_name</strong> (optional): Location name - used if location_number not provided</li>
                  <li>• <strong>platforms</strong> (optional): <code>fb</code>, <code>ig</code> or <code>fb,ig</code> (facebook/instagram also work). Blank = Facebook only. <code>fb,ig</code> creates two linked posts that are reviewed side by side</li>
                  <li>• <strong>post_content</strong> (required): The text content of your post</li>
                  <li>• <strong>ig_caption</strong> (optional): Instagram caption; blank uses post_content (placeholders work in both). Max 2,200 characters and 30 hashtags</li>
                  <li>• <strong>link_url</strong> (optional): URL to include with text posts (ignored for photo/video)</li>
                  <li>• <strong>scheduled_for</strong> (optional): Date/time in format MM/DD/YYYY HH:MM AM/PM (e.g., 01/20/2025 10:00 AM)</li>
                  <li>• <strong>media_type</strong> (optional): Leave empty for text, or use &quot;photo&quot; or &quot;video&quot;. With media_file it can be left blank (detected from the file)</li>
                  <li>• <strong>media_file</strong> (optional): File name of an image/video you upload together with the CSV (e.g. example-photo.jpg). Matching ignores upper/lower case and folders; without an extension it matches the file name before the dot. Several rows can share one file</li>
                  <li>• <strong>media_url</strong> (optional): Publicly accessible URL to a photo or video, used only when media_file is blank</li>
                  <li>• <strong>notes</strong> (optional): Your own notes; ignored on upload</li>
                </ul>
                <p className="text-sm text-gray-500 mt-2">Note: Either location_number or location_name is required for each row.</p>
                <p className="text-sm text-gray-500 mt-1">
                  Media: {MEDIA_HELP} Files are checked against the CSV before anything is created; rows with a missing file,
                  a type mismatch or an oversized file block the upload until fixed or left out. Uploaded media stays private
                  until the post is scheduled.
                </p>
                <p className="text-sm text-gray-500 mt-1">
                  Instagram: needs a photo or video and an Instagram account ID on the page (Pages tab); text-only posts aren&apos;t possible.
                  Photos are converted to JPEG (max 1440 px wide) and center-cropped to 4:5–1.91:1 when needed; the Facebook post keeps the
                  original. Videos: MP4/MOV, 3 s to 15 min, 9:16 recommended. Links in captions are not clickable; more than 5 hashtags gets a warning.
                  {!igEnabled && ' Instagram publishing is not enabled yet: Instagram posts go through client approval but are held back when the batch is scheduled.'}
                </p>
                <p className="text-sm text-gray-500 mt-1">
                  Non-franchise pages (e.g. IANA): leave location_number blank and enter the page name exactly as it appears on the Pages tab.
                  Avoid {'{{CITY}}'}/{'{{BASEURL}}'}/{'{{PHONE}}'} unless those fields are filled in for the page.
                </p>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
