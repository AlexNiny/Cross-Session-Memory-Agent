import { NextRequest, NextResponse } from 'next/server';
import { createAuthChallenge } from '@/lib/auth';

export async function POST(req: NextRequest) {
  try {
    const { walletAddress } = await req.json();
    if (!walletAddress || typeof walletAddress !== 'string') {
      return NextResponse.json({ error: 'walletAddress is required' }, { status: 400 });
    }

    const challenge = await createAuthChallenge(walletAddress, req.nextUrl.origin);
    return NextResponse.json(challenge);
  } catch (err) {
    const error = err instanceof Error ? err.message : 'Failed to create sign-in challenge';
    return NextResponse.json({ error }, { status: 500 });
  }
}
