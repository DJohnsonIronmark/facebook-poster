// Pure helper: groups the Facebook, Instagram, LinkedIn and X versions of one post (shared post_group_id) so
// review UIs can show them side by side. No imports (runs under plain Node tests).

export interface Groupable {
  id: string;
  post_group_id?: string | null;
  platform?: string | null;
}

const ORDER: Record<string, number> = { facebook: 0, instagram: 1, linkedin: 2, x: 3 };
const platformOrder = (p: Groupable) => ORDER[p.platform || 'facebook'] ?? 0;

/**
 * Returns groups in the order their first post appears. Posts without a post_group_id are their
 * own group. Within a group: Facebook, Instagram, LinkedIn, X.
 */
export function groupPosts<T extends Groupable>(posts: T[]): T[][] {
  const groups: T[][] = [];
  const index = new Map<string, number>();
  for (const p of posts) {
    const key = p.post_group_id || '';
    if (key && index.has(key)) {
      groups[index.get(key) as number].push(p);
      continue;
    }
    if (key) index.set(key, groups.length);
    groups.push([p]);
  }
  for (const g of groups) g.sort((a, b) => platformOrder(a) - platformOrder(b));
  return groups;
}
