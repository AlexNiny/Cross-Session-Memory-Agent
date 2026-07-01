import { NextRequest, NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import { getStoredLLMConfig, upsertLLMConfig } from '@/lib/user-config';

export async function GET(req: NextRequest) {
  try {
    const user = await requireUser(req);
    const config = await getStoredLLMConfig(user.id);
    return NextResponse.json({ config });
  } catch (err) {
    const error = err instanceof Error ? err.message : 'Failed to load config';
    const status = error === 'Authentication required.' ? 401 : 500;
    return NextResponse.json({ error }, { status });
  }
}

export async function PUT(req: NextRequest) {
  try {
    const user = await requireUser(req);
    const { providerUrl, model, apiKey } = await req.json();
    if (!providerUrl || typeof providerUrl !== 'string') {
      return NextResponse.json({ error: 'providerUrl is required' }, { status: 400 });
    }
    if (!model || typeof model !== 'string') {
      return NextResponse.json({ error: 'model is required' }, { status: 400 });
    }
    if (apiKey != null && typeof apiKey !== 'string') {
      return NextResponse.json({ error: 'apiKey must be a string' }, { status: 400 });
    }

    const config = await upsertLLMConfig(user.id, { providerUrl, model, apiKey });
    return NextResponse.json({ config });
  } catch (err) {
    const error = err instanceof Error ? err.message : 'Failed to save config';
    const status = error === 'Authentication required.' ? 401 : 500;
    return NextResponse.json({ error }, { status });
  }
}
