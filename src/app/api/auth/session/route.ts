import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { getStoredLLMConfig } from '@/lib/user-config';

export async function GET(req: NextRequest) {
  try {
    const user = await getCurrentUser(req);
    if (!user) return NextResponse.json({ authenticated: false });

    const config = await getStoredLLMConfig(user.id);
    return NextResponse.json({ authenticated: true, user, config });
  } catch (err) {
    const error = err instanceof Error ? err.message : 'Failed to load session';
    return NextResponse.json({ error }, { status: 500 });
  }
}
