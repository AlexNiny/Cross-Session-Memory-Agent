import { NextRequest, NextResponse } from 'next/server';
import { prepareLoginTx, getSessionKeyStatus } from '@/lib/synapse';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { walletAddress } = body;
    if (!walletAddress || typeof walletAddress !== 'string') {
      return NextResponse.json({ error: 'walletAddress is required' }, { status: 400 });
    }
    const addr = walletAddress as `0x${string}`;
    const status = getSessionKeyStatus(addr);
    if (status.authorized) {
      return NextResponse.json({ alreadyAuthorized: true, ...status });
    }
    const tx = await prepareLoginTx(addr);
    return NextResponse.json({ alreadyAuthorized: false, ...tx });
  } catch (err) {
    const error = err instanceof Error ? err.message : 'Internal server error';
    return NextResponse.json({ error }, { status: 500 });
  }
}
