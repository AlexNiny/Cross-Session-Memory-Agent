import { NextRequest, NextResponse } from 'next/server';
import { handleUserMessage, getStorageInfo } from '@/lib/agent';

/** POST /api/chat — handle a chat message */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { sessionId, message, providerUrl, apiKey, model, walletAddress } = body;

    if (!sessionId || typeof sessionId !== 'string') {
      return NextResponse.json({ error: 'sessionId is required' }, { status: 400 });
    }
    if (!message || typeof message !== 'string' || message.trim().length === 0) {
      return NextResponse.json({ error: 'message is required' }, { status: 400 });
    }
    if (!apiKey || typeof apiKey !== 'string') {
      return NextResponse.json({ error: 'API key is required.' }, { status: 400 });
    }

    const result = await handleUserMessage(
      sessionId, message.trim(),
      { providerUrl: providerUrl || 'https://api.openai.com/v1', apiKey, model: model || 'gpt-4o-mini' },
      walletAddress
    );
    return NextResponse.json(result);
  } catch (err) {
    const error = err instanceof Error ? err.message : 'Internal server error';
    console.error('Chat API error:', err);
    return NextResponse.json({ error }, { status: 500 });
  }
}

/** GET /api/chat — get storage & session status */
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const walletAddress = searchParams.get('wallet') || undefined;
    const info = await getStorageInfo(walletAddress);
    return NextResponse.json(info);
  } catch (err) {
    console.error('Storage info error:', err);
    return NextResponse.json({ error: 'Failed to get storage info' }, { status: 500 });
  }
}
