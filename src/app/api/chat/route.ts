import { NextRequest, NextResponse } from 'next/server';
import { handleUserMessage, getStorageInfo } from '@/lib/agent';
import { requireUser } from '@/lib/auth';
import { getResolvedLLMConfig } from '@/lib/user-config';
import type { ChatTurn } from '@/lib/memory-manager';

const MAX_CONTEXT_TURNS = 1000;
const MAX_MESSAGE_CHARS = 200_000;

function normalizeTurns(value: unknown): ChatTurn[] {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error('localTurns must be an array.');
  if (value.length > MAX_CONTEXT_TURNS) throw new Error(`Cannot send more than ${MAX_CONTEXT_TURNS} local turns.`);

  return value.map((item, index) => {
    if (!item || typeof item !== 'object') throw new Error(`Invalid local turn at index ${index}.`);
    const turn = item as Partial<ChatTurn>;
    if (!Number.isInteger(turn.turnIndex) || Number(turn.turnIndex) < 0) {
      throw new Error(`Invalid local turn index at item ${index}.`);
    }
    if (typeof turn.userMessage !== 'string' || typeof turn.agentResponse !== 'string') {
      throw new Error(`Invalid local turn message at item ${index}.`);
    }
    if (turn.userMessage.length > MAX_MESSAGE_CHARS || turn.agentResponse.length > MAX_MESSAGE_CHARS) {
      throw new Error(`Local turn ${turn.turnIndex} is too large.`);
    }
    return {
      turnIndex: Number(turn.turnIndex),
      userMessage: turn.userMessage,
      agentResponse: turn.agentResponse,
      timestamp: Number.isFinite(turn.timestamp) ? Number(turn.timestamp) : Date.now(),
    };
  });
}

/** POST /api/chat — handle a chat message */
export async function POST(req: NextRequest) {
  try {
    const user = await requireUser(req);
    const body = await req.json();
    const { sessionId, message, backupEvery } = body;
    const localTurns = normalizeTurns(body.localTurns);

    if (!sessionId || typeof sessionId !== 'string') {
      return NextResponse.json({ error: 'sessionId is required' }, { status: 400 });
    }
    if (!message || typeof message !== 'string' || message.trim().length === 0) {
      return NextResponse.json({ error: 'message is required' }, { status: 400 });
    }

    const providerConfig = await getResolvedLLMConfig(user.id);
    const result = await handleUserMessage(
      sessionId, message.trim(),
      providerConfig,
      user.walletAddress,
      Number(backupEvery || 5),
      user.id,
      localTurns,
    );
    return NextResponse.json(result);
  } catch (err) {
    const error = err instanceof Error ? err.message : 'Internal server error';
    console.error('Chat API error:', err);
    const isBadRequest = /localTurns|Invalid|Cannot|too large|required/i.test(error);
    return NextResponse.json({ error }, { status: error === 'Authentication required.' ? 401 : isBadRequest ? 400 : 500 });
  }
}

/** GET /api/chat — get storage & session status */
export async function GET(req: NextRequest) {
  try {
    const user = await requireUser(req);
    const info = await getStorageInfo(user.walletAddress);
    return NextResponse.json(info);
  } catch (err) {
    console.error('Storage info error:', err);
    const error = err instanceof Error ? err.message : 'Failed to get storage info';
    return NextResponse.json({ error }, { status: error === 'Authentication required.' ? 401 : 500 });
  }
}
