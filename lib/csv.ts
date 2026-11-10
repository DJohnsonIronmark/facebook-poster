// RFC-4180-ish CSV helpers (quoted fields, escaped quotes, multiline values)

export function parseCSVObjects(text: string): Record<string, string>[] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let inQuotes = false;
  const src = text.replace(/^﻿/, '');

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') { record.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      record.push(field); field = '';
      if (record.some((f) => f.trim())) records.push(record);
      record = [];
    } else field += ch;
  }
  record.push(field);
  if (record.some((f) => f.trim())) records.push(record);

  if (records.length < 2) return [];
  const headers = records[0].map((h) => h.trim().toLowerCase());
  return records.slice(1).map((r) => {
    const obj: Record<string, string> = {};
    headers.forEach((h, i) => { obj[h] = (r[i] ?? '').trim(); });
    return obj;
  });
}

export function toCSV(headers: string[], rows: (string | null | undefined)[][]): string {
  const esc = (v: string | null | undefined) => {
    let s = v ?? '';
    // neutralise spreadsheet formula injection
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return `"${s.replace(/"/g, '""')}"`;
  };
  return [headers.map(esc).join(','), ...rows.map((r) => r.map(esc).join(','))].join('\r\n');
}

export function downloadCSV(filename: string, csv: string) {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** MM/DD/YYYY [HH:MM [AM|PM]] (local time) or ISO → ISO string; null if unparseable/empty */
export function parseScheduledDate(dateStr: string | null | undefined): string | null {
  if (!dateStr || !dateStr.trim()) return null;
  const m = dateStr.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?:\s*(AM|PM))?)?$/i);
  if (m) {
    const [, month, day, year, hours, minutes, ampm] = m;
    let hour = hours ? parseInt(hours, 10) : 9;
    if (ampm) {
      if (ampm.toUpperCase() === 'PM' && hour !== 12) hour += 12;
      else if (ampm.toUpperCase() === 'AM' && hour === 12) hour = 0;
    }
    const d = new Date(+year, +month - 1, +day, hour, minutes ? +minutes : 0);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }
  const iso = new Date(dateStr);
  return isNaN(iso.getTime()) ? null : iso.toISOString();
}

/** ISO → "MM/DD/YYYY h:mm AM" in local time (round-trips with parseScheduledDate) */
export function formatScheduledDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const h = d.getHours();
  return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()} ${h % 12 || 12}:${String(d.getMinutes()).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
}
