import { createClient, createServiceClient } from '@/lib/supabase/server';
import type { User } from '@supabase/supabase-js';

// App identifier for multi-app authentication
export const APP_ID = 'facebook-poster';

export type UserRole = 'admin' | 'manager' | 'viewer';

export interface UserWithRole {
  id: string;
  email: string;
  role: UserRole;
  createdAt: string;
}

/**
 * Get the current authenticated user from the session
 */
export async function getCurrentUser(): Promise<User | null> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  return user;
}

/**
 * Get the role for a user in this app
 */
export async function getUserRole(userId: string, app: string = APP_ID): Promise<UserRole | null> {
  const supabase = createServiceClient();

  const { data, error } = await supabase
    .from('user_roles')
    .select('role')
    .eq('user_id', userId)
    .eq('app', app)
    .single();

  if (error || !data) {
    return null;
  }

  return data.role as UserRole;
}

/**
 * Get the current user's role
 */
export async function getCurrentUserRole(): Promise<UserRole | null> {
  const user = await getCurrentUser();
  if (!user) return null;
  return getUserRole(user.id);
}

/**
 * Sign in with email and password
 */
export async function signIn(email: string, password: string): Promise<{ error: string | null }> {
  const supabase = await createClient();

  const { error } = await supabase.auth.signInWithPassword({
    email,
    password,
  });

  if (error) {
    return { error: error.message };
  }

  return { error: null };
}

/**
 * Sign out the current user
 */
export async function signOut(): Promise<void> {
  const supabase = await createClient();
  await supabase.auth.signOut();
}

/**
 * Require authentication for API routes
 * Returns user if authenticated, or an error response
 */
export async function requireAuth(): Promise<{
  user: { id: string; email: string } | null;
  error: Response | null;
}> {
  const supabase = await createClient();
  const { data: { user }, error } = await supabase.auth.getUser();

  if (error || !user) {
    const { NextResponse } = await import('next/server');
    return {
      user: null,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    };
  }

  return {
    user: { id: user.id, email: user.email || '' },
    error: null
  };
}
