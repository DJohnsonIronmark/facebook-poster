import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';

// Support both env var naming conventions
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_KEY!;

export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient(
    SUPABASE_URL,
    SUPABASE_ANON_KEY,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            );
          } catch {
            // The `setAll` method was called from a Server Component.
            // This can be ignored if you have middleware refreshing sessions.
          }
        },
      },
    }
  );
}

// Service client for admin operations (bypasses RLS)
export function createServiceClient() {
  const { createClient } = require('@supabase/supabase-js');
  // Standard name is SUPABASE_SERVICE_ROLE; fall back to the legacy name.
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) {
    throw new Error('SUPABASE_SERVICE_ROLE (or SUPABASE_SERVICE_ROLE_KEY) is not configured');
  }
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
