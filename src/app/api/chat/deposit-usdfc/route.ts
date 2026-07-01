import { NextRequest, NextResponse } from 'next/server';
import { finalizeStorageUsdfcDeposit, getStorageFundingStatus } from '@/lib/synapse';
import { parseUnits } from 'viem';
import { requireUser } from '@/lib/auth';

function parseAmount(amount: unknown): bigint {
  if (typeof amount === 'bigint') return amount;
  if (typeof amount !== 'string' || amount.trim().length === 0) {
    throw new Error('amount is required');
  }
  return parseUnits(amount.trim(), 18);
}

export async function POST(req: NextRequest) {
  try {
    const user = await requireUser(req);
    const { amount, transferHash } = await req.json();
    if (!transferHash) {
      return NextResponse.json({ error: 'transferHash required' }, { status: 400 });
    }

    const result = await finalizeStorageUsdfcDeposit(
      user.walletAddress,
      parseAmount(amount),
      transferHash as `0x${string}`,
    );
    return NextResponse.json({ success: true, ...result });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err?.message || 'Internal error' });
  }
}

export async function GET(req: NextRequest) {
  try {
    const user = await requireUser(req);
    const status = await getStorageFundingStatus(user.walletAddress);
    return NextResponse.json({ success: true, ...status });
  } catch (err: any) {
    const error = err?.message || 'Internal error';
    return NextResponse.json({ success: false, error }, { status: error === 'Authentication required.' ? 401 : 200 });
  }
}
