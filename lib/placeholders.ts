export interface PlaceholderValues {
  city?: string | null;
  franchise_name?: string | null;
  location_number?: string | null;
  base_url?: string | null;
  phone?: string | null;
}

// Replace {{CITY}}-style placeholders in post text / links with page values
export function replacePlaceholders(text: string, values: PlaceholderValues): string {
  if (!text) return text;

  let result = text;
  const placeholders: Record<string, string> = {
    '{{CITY}}': values.city || '',
    '{{FRANCHISENAME}}': values.franchise_name || '',
    '{{LOCATION}}': values.location_number || '',
    '{{BASEURL}}': values.base_url || '',
    '{{PHONE}}': values.phone || '',
  };

  for (const [placeholder, value] of Object.entries(placeholders)) {
    result = result.replace(new RegExp(placeholder, 'gi'), value);
  }

  // Fix URL duplication patterns (e.g., https://www.homeinsteadhttps://www.homeinstead.com/...)
  // This handles cases where user types partial URL before {{BASEURL}} placeholder
  result = result.replace(/https?:\/\/[a-zA-Z0-9.-]*(https?:\/\/)/gi, '$1');

  return result;
}
