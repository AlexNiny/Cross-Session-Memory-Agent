import { NextRequest, NextResponse } from 'next/server';
import { clearSessionCookie, destroyCurrentSession } from '@/lib/auth';

export async function POST(req: NextRequest) {
  try {
    await destroyCurrentSession(req);
  } catch {}

  const res = NextResponse.json({ success: true });
  clearSessionCookie(res);
  return res;
}
