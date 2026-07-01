import { NextRequest, NextResponse } from 'next/server';
import { prepareLoginTx, getSessionKeyStatus } from '@/lib/synapse';
import { requireUser } from '@/lib/auth';

export async function POST(req: NextRequest) {
  try {
    const user = await requireUser(req);
    const addr = user.walletAddress;
    const status = await getSessionKeyStatus(addr);
    if (status.authorized) {
      return NextResponse.json({ alreadyAuthorized: true, ...status });
    }
    const tx = await prepareLoginTx(addr);
    return NextResponse.json({ alreadyAuthorized: false, ...tx });
  } catch (err) {
    const error = err instanceof Error ? err.message : 'Internal server error';
    console.error('Prepare login error:', err);
    return NextResponse.json({ error }, { status: error === 'Authentication required.' ? 401 : 500 });
  }
}
