import { NextRequest, NextResponse } from 'next/server';
import { confirmLogin } from '@/lib/synapse';
import { requireUser } from '@/lib/auth';

export async function POST(req: NextRequest) {
  try {
    const user = await requireUser(req);
    const body = await req.json();
    const { txHash } = body;
    if (!txHash) {
      return NextResponse.json({ error: 'txHash is required' }, { status: 400 });
    }
    const result = await confirmLogin(user.walletAddress, txHash as `0x${string}`);
    return NextResponse.json(result);
  } catch (err) {
    const error = err instanceof Error ? err.message : 'Internal server error';
    return NextResponse.json({ error }, { status: error === 'Authentication required.' ? 401 : 500 });
  }
}
