import { NextRequest, NextResponse } from 'next/server';
import { setSessionCookie, verifyAuthChallenge } from '@/lib/auth';
import { getStoredLLMConfig } from '@/lib/user-config';

export async function POST(req: NextRequest) {
  try {
    const { walletAddress, signature } = await req.json();
    if (!walletAddress || typeof walletAddress !== 'string') {
      return NextResponse.json({ error: 'walletAddress is required' }, { status: 400 });
    }
    if (!signature || typeof signature !== 'string') {
      return NextResponse.json({ error: 'signature is required' }, { status: 400 });
    }

    const { user, token, maxAge } = await verifyAuthChallenge(walletAddress, signature as `0x${string}`);
    const config = await getStoredLLMConfig(user.id);
    const res = NextResponse.json({ authenticated: true, user, config });
    setSessionCookie(res, token, maxAge);
    return res;
  } catch (err) {
    const error = err instanceof Error ? err.message : 'Failed to verify sign-in';
    return NextResponse.json({ error }, { status: 401 });
  }
}
