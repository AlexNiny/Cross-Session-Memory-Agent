import { NextRequest, NextResponse } from 'next/server';
import { depositExistingStorageWalletUsdfc } from '@/lib/synapse';
import { parseUnits } from 'viem';
import { requireUser } from '@/lib/auth';

function parseOptionalAmount(amount: unknown): bigint | undefined {
  if (amount == null || amount === '') return undefined;
  if (typeof amount !== 'string') throw new Error('amount must be a string');
  return parseUnits(amount.trim(), 18);
}

export async function POST(req: NextRequest) {
  try {
    const user = await requireUser(req);
    const { amount } = await req.json();

    const result = await depositExistingStorageWalletUsdfc(
      user.walletAddress,
      parseOptionalAmount(amount),
    );
    return NextResponse.json({ success: true, ...result });
  } catch (err: any) {
    const error = err?.message || 'Internal error';
    return NextResponse.json({ success: false, error }, { status: error === 'Authentication required.' ? 401 : 200 });
  }
}
