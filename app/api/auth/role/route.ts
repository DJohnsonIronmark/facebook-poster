import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';
import { APP_ID } from '@/lib/auth';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const userId = searchParams.get('userId');

    if (!userId) {
      return NextResponse.json({ error: 'User ID required' }, { status: 400 });
    }

    const supabase = createServiceClient();

    const { data, error } = await supabase
      .from('user_roles')
      .select('role')
      .eq('user_id', userId)
      .eq('app', APP_ID)
      .single();

    if (error) {
      return NextResponse.json({ role: null });
    }

    return NextResponse.json({ role: data.role });
  } catch (error) {
    console.error('Error fetching user role:', error);
    return NextResponse.json({ role: null });
  }
}
