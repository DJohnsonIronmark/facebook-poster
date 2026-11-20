import { IG_IMAGE_MAX_BYTES, planInstagramImage, validateIgVideo, type CropPlan } from './rules';

// Browser-only: prepares media for Instagram before upload.
//  * images → a separate JPEG derivative (white background for transparency, ≤ 1440 px wide,
//    center-cropped to 4:5–1.91:1 when needed). The Facebook post keeps the original file.
//  * videos → duration/size read from a <video> element (the file itself is shared with Facebook).

export type IgMediaInfo =
  | { state: 'loading' }
  | { state: 'photo'; file: File; url: string; plan: CropPlan; warnings: string[] }
  | { state: 'video'; duration: number; width: number; height: number; errors: string[]; warnings: string[] }
  | { state: 'error'; message: string };

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('This image could not be read by the browser'));
    img.src = src;
  });
}

function canvasToJpeg(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not convert the image to JPEG'))), 'image/jpeg', quality);
  });
}

function stemOf(name: string): string {
  const base = name.split(/[\\/]/).pop() || 'image';
  const dot = base.lastIndexOf('.');
  return (dot > 0 ? base.slice(0, dot) : base).replace(/[^\w.-]+/g, '-').slice(0, 80) || 'image';
}

/** JPEG derivative of an image for Instagram (does not touch the original). */
export async function prepareInstagramImage(file: File): Promise<{ file: File; plan: CropPlan; warnings: string[] }> {
  const src = URL.createObjectURL(file);
  try {
    const img = await loadImage(src);
    const plan = planInstagramImage(img.naturalWidth, img.naturalHeight);
    const canvas = document.createElement('canvas');
    canvas.width = plan.width;
    canvas.height = plan.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas is not available in this browser');
    ctx.fillStyle = '#ffffff'; // JPEG has no transparency
    ctx.fillRect(0, 0, plan.width, plan.height);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, plan.sx, plan.sy, plan.sw, plan.sh, 0, 0, plan.width, plan.height);

    let blob = await canvasToJpeg(canvas, 0.9);
    for (const q of [0.8, 0.7, 0.6]) {
      if (blob.size <= IG_IMAGE_MAX_BYTES) break;
      blob = await canvasToJpeg(canvas, q);
    }
    if (blob.size > IG_IMAGE_MAX_BYTES) throw new Error('Image is still over 8 MB after converting for Instagram');

    const warnings: string[] = [];
    if (file.type === 'image/gif') warnings.push('Animated GIFs are posted to Instagram as a still image');
    return { file: new File([blob], `${stemOf(file.name)}-instagram.jpg`, { type: 'image/jpeg' }), plan, warnings };
  } finally {
    URL.revokeObjectURL(src);
  }
}

/** Reads a video's duration and size; resolves with NaN/0 values when the browser can't decode it. */
export function readVideoMeta(file: File, timeoutMs = 15000): Promise<{ duration: number; width: number; height: number }> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    let done = false;
    const finish = (v: { duration: number; width: number; height: number }) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      video.removeAttribute('src');
      video.load();
      URL.revokeObjectURL(url);
      resolve(v);
    };
    const timer = setTimeout(() => finish({ duration: NaN, width: 0, height: 0 }), timeoutMs);
    video.preload = 'metadata';
    video.muted = true;
    video.onloadedmetadata = () => finish({ duration: video.duration, width: video.videoWidth, height: video.videoHeight });
    video.onerror = () => finish({ duration: NaN, width: 0, height: 0 });
    video.src = url;
  });
}

/** Analyses one media file for Instagram (photo → derivative + crop plan, video → length/shape checks). */
export async function analyzeInstagramMedia(file: File, kind: 'photo' | 'video'): Promise<IgMediaInfo> {
  try {
    if (kind === 'photo') {
      const prepared = await prepareInstagramImage(file);
      return { state: 'photo', file: prepared.file, url: URL.createObjectURL(prepared.file), plan: prepared.plan, warnings: prepared.warnings };
    }
    const meta = await readVideoMeta(file);
    if (!Number.isFinite(meta.duration)) {
      // Some MOV codecs can't be decoded by every browser; don't block, but say it wasn't checked
      return { state: 'video', ...meta, errors: [], warnings: ['Could not read this video in the browser; make sure it is 3 s to 15 min long'] };
    }
    const issues = validateIgVideo(meta);
    return { state: 'video', ...meta, errors: issues.errors, warnings: issues.warnings };
  } catch (e) {
    return { state: 'error', message: e instanceof Error ? e.message : 'Could not prepare this file for Instagram' };
  }
}

/** Releases object URLs created by analyzeInstagramMedia. */
export function releaseIgMedia(info: IgMediaInfo | undefined) {
  if (info && info.state === 'photo') URL.revokeObjectURL(info.url);
}
