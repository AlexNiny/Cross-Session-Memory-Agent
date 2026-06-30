import { NextRequest, NextResponse } from 'next/server';
import { confirmLogin } from '@/lib/synapse';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { walletAddress, txHash } = body;
    if (!walletAddress || !txHash) {
      return NextResponse.json({ error: 'walletAddress and txHash are required' }, { status: 400 });
    }
    const result = await confirmLogin(walletAddress as `0x${string}`, txHash as `0x${string}`);
    return NextResponse.json(result);
  } catch (err) {
    const error = err instanceof Error ? err.message : 'Internal server error';
    return NextResponse.json({ error }, { status: 500 });
  }
}
