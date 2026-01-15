import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

export async function GET() {
  const { error: authError } = await requireAuth();
  if (authError) return authError;

  try {
    // Fetch Facebook pages from Supabase
    const response = await fetch(
      `${SUPABASE_URL}/rest/v1/facebook_pages?select=*&order=location_name.asc`,
      {
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`,
          'Content-Type': 'application/json',
        },
        cache: 'no-store',
      }
    );

    if (!response.ok) {
      const error = await response.text();
      console.error('Supabase error:', error);
      return NextResponse.json(
        { error: 'Failed to fetch pages', details: error },
        { status: response.status }
      );
    }

    const pages = await response.json();

    return NextResponse.json({ pages });
  } catch (error) {
    console.error('Error fetching pages:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
