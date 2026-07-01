import { NextRequest, NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import type { ChatTurn } from '@/lib/memory-manager';

export const dynamic = 'force-dynamic';

const MAX_SYNC_TURNS = 1000;
const MAX_MESSAGE_CHARS = 200_000;

function normalizeSessionId(value: unknown): string {
  if (typeof value !== 'string' || value.length < 8 || value.length > 128) {
    throw new Error('Valid sessionId is required.');
  }
  return value;
}

function normalizeTurns(value: unknown): ChatTurn[] {
  if (!Array.isArray(value)) throw new Error('turns must be an array.');
  if (value.length > MAX_SYNC_TURNS) throw new Error(`Cannot sync more than ${MAX_SYNC_TURNS} turns at once.`);

  return value.map((item, index) => {
    if (!item || typeof item !== 'object') throw new Error(`Invalid turn at index ${index}.`);
    const turn = item as Partial<ChatTurn>;
    if (!Number.isInteger(turn.turnIndex) || Number(turn.turnIndex) < 0) {
      throw new Error(`Invalid turn index at item ${index}.`);
    }
    if (typeof turn.userMessage !== 'string' || typeof turn.agentResponse !== 'string') {
      throw new Error(`Invalid message payload at item ${index}.`);
    }
    if (turn.userMessage.length > MAX_MESSAGE_CHARS || turn.agentResponse.length > MAX_MESSAGE_CHARS) {
      throw new Error(`Turn ${turn.turnIndex} is too large to sync.`);
    }
    return {
      turnIndex: Number(turn.turnIndex),
      userMessage: turn.userMessage,
      agentResponse: turn.agentResponse,
      timestamp: Number.isFinite(turn.timestamp) ? Number(turn.timestamp) : Date.now(),
    };
  });
}

export async function GET(req: NextRequest) {
  try {
    const user = await requireUser(req);
    const sessionId = normalizeSessionId(new URL(req.url).searchParams.get('sessionId'));
    const { getMemoryManager } = await import('@/lib/memory-manager');
    const memory = await getMemoryManager();
    const restored = await memory.restoreHistory(sessionId, user.walletAddress, user.id);
    return NextResponse.json({
      sessionId,
      source: restored.source,
      turnCount: restored.turns.length,
      turns: restored.turns,
    });
  } catch (err) {
    const error = err instanceof Error ? err.message : 'Failed to restore session';
    return NextResponse.json({ error }, {
      status: error === 'Authentication required.' ? 401 : error.includes('sessionId') ? 400 : 500,
    });
  }
}

export async function POST(req: NextRequest) {
  try {
    await requireUser(req);
    const body = await req.json();
    const sessionId = normalizeSessionId(body.sessionId);
    normalizeTurns(body.turns);
    return NextResponse.json({
      success: true,
      sessionId,
      syncedCount: 0,
      skipped: true,
      reason: 'D1 chat body storage is disabled; chat turns stay in the browser and Filecoin backups.',
    });
  } catch (err) {
    const error = err instanceof Error ? err.message : 'Failed to sync session';
    return NextResponse.json({ error }, {
      status: error === 'Authentication required.' ? 401 : error.includes('Invalid') || error.includes('required') || error.includes('turns') ? 400 : 500,
    });
  }
}
