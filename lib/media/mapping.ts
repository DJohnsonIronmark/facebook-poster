// Pure media rules + CSV-row-to-file mapping for bulk upload. No imports, so this module runs
// under plain Node (tests), in the browser, and in server routes.

export type MediaKind = 'photo' | 'video';

export const MB = 1024 * 1024;
export const MEDIA_LIMITS: Record<MediaKind, number> = { photo: 10 * MB, video: 100 * MB };

/** Allowed content types → kind + the extension used for the storage path. */
export const ALLOWED_MEDIA: Record<string, { kind: MediaKind; ext: string }> = {
  'image/jpeg': { kind: 'photo', ext: 'jpg' },
  'image/png': { kind: 'photo', ext: 'png' },
  'image/gif': { kind: 'photo', ext: 'gif' },
  'image/webp': { kind: 'photo', ext: 'webp' },
  'video/mp4': { kind: 'video', ext: 'mp4' },
  'video/quicktime': { kind: 'video', ext: 'mov' },
};

const EXT_TO_TYPE: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
  mp4: 'video/mp4', mov: 'video/quicktime',
};

export const ACCEPT_MEDIA = Object.keys(ALLOWED_MEDIA).join(',');
export const MEDIA_HELP = 'Photos: JPG, PNG, GIF, WEBP up to 10 MB. Videos: MP4, MOV up to 100 MB.';

export interface MediaFileLike {
  name: string;
  type: string;
  size: number;
}

/** File name without any folder path (handles / and \ separators). */
export function baseName(name: string): string {
  const parts = String(name).trim().split(/[\\/]/);
  return (parts[parts.length - 1] || '').trim();
}

export function fileExtension(name: string): string {
  const b = baseName(name);
  const dot = b.lastIndexOf('.');
  return dot > 0 ? b.slice(dot + 1).toLowerCase() : '';
}

function stem(name: string): string {
  const b = baseName(name);
  const dot = b.lastIndexOf('.');
  return dot > 0 ? b.slice(0, dot) : b;
}

/** Normalized content type, falling back to the extension when the browser didn't report one. */
export function resolveContentType(file: { name: string; type: string }): string | null {
  const t = String(file.type || '').toLowerCase().trim();
  if (ALLOWED_MEDIA[t]) return t;
  if (t === 'image/jpg') return 'image/jpeg';
  if (!t || t === 'application/octet-stream') return EXT_TO_TYPE[fileExtension(file.name)] || null;
  return null;
}

/** image/* → photo, video/* → video (falls back to the extension). */
export function inferMediaKind(file: { name: string; type: string }): MediaKind | null {
  const t = String(file.type || '').toLowerCase();
  if (t.startsWith('image/')) return 'photo';
  if (t.startsWith('video/')) return 'video';
  const byExt = EXT_TO_TYPE[fileExtension(file.name)];
  return byExt ? ALLOWED_MEDIA[byExt].kind : null;
}

export type MediaValidation =
  | { ok: true; kind: MediaKind; contentType: string; ext: string }
  | { ok: false; code: 'unsupported_type' | 'file_too_large' | 'empty_file'; message: string };

export function validateMediaFile(file: MediaFileLike): MediaValidation {
  const contentType = resolveContentType(file);
  if (!contentType) {
    return { ok: false, code: 'unsupported_type', message: `Unsupported file type. ${MEDIA_HELP}` };
  }
  const { kind, ext } = ALLOWED_MEDIA[contentType];
  const size = Number(file.size);
  if (!Number.isFinite(size) || size <= 0) return { ok: false, code: 'empty_file', message: 'File is empty' };
  if (size > MEDIA_LIMITS[kind]) {
    return {
      ok: false, code: 'file_too_large',
      message: `File too large (${(size / MB).toFixed(1)} MB; ${kind === 'photo' ? 'photos' : 'videos'} max ${MEDIA_LIMITS[kind] / MB} MB)`,
    };
  }
  return { ok: true, kind, contentType, ext };
}

/** CSV media_type → kind; '' for blank/text; null if unrecognised. */
export function parseMediaTypeCell(v: string | null | undefined): MediaKind | '' | null {
  const s = String(v ?? '').trim().toLowerCase();
  if (!s || s === 'text') return '';
  if (s === 'photo' || s === 'image') return 'photo';
  if (s === 'video') return 'video';
  return null;
}

export interface RowMediaInput {
  media_type?: string;
  media_file?: string;
  media_url?: string;
}

export type RowMediaErrorCode =
  | 'missing_file' | 'ambiguous_file' | 'type_mismatch' | 'file_too_large' | 'unsupported_type'
  | 'empty_file' | 'invalid_media_type' | 'missing_media';

export type RowMediaStatus =
  | { state: 'none' }
  | { state: 'url'; kind: MediaKind }
  | { state: 'file'; kind: MediaKind; fileIndex: number }
  | { state: 'error'; code: RowMediaErrorCode; message: string; fileIndex?: number };

export interface MappingResult {
  rows: RowMediaStatus[];
  /** indexes into `files` that no row references */
  unreferenced: number[];
}

function urlKind(url: string): MediaKind | null {
  let path = url;
  try { path = new URL(url).pathname; } catch { /* not absolute; use as-is */ }
  const byExt = EXT_TO_TYPE[fileExtension(path)];
  return byExt ? ALLOWED_MEDIA[byExt].kind : null;
}

/**
 * Maps each CSV row to an uploaded file by its media_file name.
 *  1. exact file name match (case-insensitive, any folder path ignored)
 *  2. if media_file has no extension, match the file whose name minus extension matches
 * media_type is inferred from the file when blank. A row with media_file always uses the file
 * (media_url is ignored); rows without media_file keep the old media_url behaviour.
 */
export function mapRowsToFiles(rows: RowMediaInput[], files: MediaFileLike[]): MappingResult {
  const byName = new Map<string, number[]>();
  const byStem = new Map<string, number[]>();
  files.forEach((f, i) => {
    const name = baseName(f.name).toLowerCase();
    const s = stem(f.name).toLowerCase();
    byName.set(name, [...(byName.get(name) || []), i]);
    byStem.set(s, [...(byStem.get(s) || []), i]);
  });

  const used = new Set<number>();
  const out: RowMediaStatus[] = rows.map((row) => {
    const declared = parseMediaTypeCell(row.media_type);
    const ref = baseName(row.media_file || '');
    const url = String(row.media_url || '').trim();

    if (declared === null) {
      return { state: 'error', code: 'invalid_media_type', message: `media_type "${row.media_type}" must be blank, text, photo or video` };
    }

    if (ref) {
      const key = ref.toLowerCase();
      let matches = byName.get(key) || [];
      if (matches.length === 0 && !ref.includes('.')) matches = byStem.get(key) || [];
      if (matches.length === 0) return { state: 'error', code: 'missing_file', message: `Missing file: ${ref}` };
      matches.forEach((i) => used.add(i));
      if (matches.length > 1) {
        return { state: 'error', code: 'ambiguous_file', message: `"${ref}" matches ${matches.length} files; add the extension or rename` };
      }
      const fileIndex = matches[0];
      const v = validateMediaFile(files[fileIndex]);
      if (!v.ok) return { state: 'error', code: v.code, message: v.message, fileIndex };
      if (declared === '' && String(row.media_type || '').trim().toLowerCase() === 'text') {
        return { state: 'error', code: 'type_mismatch', message: `media_type is text but ${ref} is a ${v.kind}`, fileIndex };
      }
      if (declared && declared !== v.kind) {
        return { state: 'error', code: 'type_mismatch', message: `media_type is ${declared} but ${ref} is a ${v.kind}`, fileIndex };
      }
      return { state: 'file', kind: v.kind, fileIndex };
    }

    if (url) {
      const kind = declared || urlKind(url);
      if (!kind) return { state: 'error', code: 'invalid_media_type', message: 'Set media_type (photo or video) for this media_url' };
      return { state: 'url', kind };
    }

    if (declared) return { state: 'error', code: 'missing_media', message: `media_type is ${declared} but no media_file or media_url` };
    return { state: 'none' };
  });

  const unreferenced = files.map((_, i) => i).filter((i) => !used.has(i));
  return { rows: out, unreferenced };
}
