import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';

export async function requireAuth() {
  // AUTH DISABLED FOR DEVELOPMENT - Set to false to re-enable auth
  const bypassAuth = true;
  if (bypassAuth) {
    return { user: { id: 'dev-user', email: 'dev@localhost' }, error: null };
  }
  // END AUTH BYPASS

  const supabase = await createClient();
  const { data: { user }, error } = await supabase.auth.getUser();

  if (error || !user) {
    return { user: null, error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  }

  return { user, error: null };
}
