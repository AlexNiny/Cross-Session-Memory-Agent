import { NextRequest, NextResponse } from 'next/server';
import { approveWarmStorageForExistingBalance } from '@/lib/synapse';
import { requireUser } from '@/lib/auth';

export async function POST(req: NextRequest) {
  try {
    const user = await requireUser(req);
    const result = await approveWarmStorageForExistingBalance(user.walletAddress);
    return NextResponse.json({ success: true, ...result });
  } catch (err: any) {
    const error = err?.message || 'Internal error';
    return NextResponse.json({ success: false, error }, { status: error === 'Authentication required.' ? 401 : 200 });
  }
}
